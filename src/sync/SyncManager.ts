import { Notice, TFile, Vault } from 'obsidian';
import {
	GitHubApiError,
	GitHubClient,
	RemoteSnapshot,
} from '../github/GitHubClient';
import {
	ACTIVITY_LIMIT,
	ActivityEntry,
	ActivityKind,
	ConflictRecord,
	EMPTY_BLOB_SHA,
	GitSyncSettings,
	POLL_HOLD_AFTER_PUSH_MS,
	PULL_INTERVAL_MS,
	PUSH_DELAY_SECONDS,
	PushTrigger,
	SELF_WRITE_GRACE_MS,
	SyncStateData,
	SyncStatus,
} from '../types';
import {
	isIgnoredPath,
	isSafeVaultPath,
	matchesExtensions,
	normalizePath,
} from '../vault/PathFilter';
import { base64ToArrayBuffer, gitBlobSha, sha256 } from '../vault/VaultScanner';
import { ChangeDetector } from './ChangeDetector';
import { ConflictDetector, IdenticalPaths } from './ConflictDetector';
import { attemptMerge } from './MergeAttempt';
import { PullManager } from './PullManager';
import { PushManager } from './PushManager';
import { renamesDeclaredIn } from './RenameRecord';
import { ProgressCallback, SetupCheck, SetupCheckResult } from './SetupCheck';
import { SyncStateStore } from './SyncState';

const DEBUG_LOG_LIMIT = 200;

/** Path to blob sha for every blob in a snapshot. */
function treeMapOf(remote: RemoteSnapshot): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [path, entry] of remote.entries) {
		if (entry.type === 'blob' && entry.sha) {
			map[path] = entry.sha;
		}
	}
	return map;
}

function basename(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut >= 0 ? path.slice(cut + 1) : path;
}

function listForPrompt(paths: string[], shown = 12): string {
	const list = paths
		.slice(0, shown)
		.map((path) => `  • ${path}`)
		.join('\n');
	return paths.length > shown ? `${list}\n  ...and ${paths.length - shown} more` : list;
}

export class SyncManager {
	private running = false;
	private requested = false;
	private dirty = false;
	private pushTimer: number | null = null;
	private pollTimer: number | null = null;

	// Nothing automatic (no poll, no debounced push, no follow-up requested
	// mid-push) runs before this moment. It is re-armed when a push finishes, so
	// the next attempt never lands on a branch read GitHub has not caught up
	// with yet: that read is what turned an edit made during a push into a
	// spurious conflict.
	private syncHoldUntil = 0;

	/** Paths this plugin has just written, against the moment the flag lapses. */
	private selfWrites = new Map<string, number>();

	// Paths the user renamed before they were ever pushed. Held in memory only,
	// because it matters for the minute between creating a note and pushing it.
	private userNamed = new Set<string>();

	private activity: ActivityEntry[] = [];

	constructor(
		private vault: Vault,
		private settings: GitSyncSettings,
		private stateStore: SyncStateStore,
		private state: SyncStateData,
		private setStatus: (status: SyncStatus, detail: string) => void,
		private refreshUI: () => void,
	) {}

	getState(): SyncStateData {
		return this.state;
	}

	getActivity(): ActivityEntry[] {
		return this.activity;
	}

	// Naming a note is the user finishing what Obsidian started. Until that
	// happens an empty new file is a placeholder and waits; afterwards it is an
	// ordinary new note and goes out on the usual delay, empty or not.
	markUserNamed(path: string): void {
		this.userNamed.add(normalizePath(path));
	}

	/** Flags paths the plugin is about to write, so the vault events that follow
	 *  are recognised as this plugin's own work rather than the user's. */
	markSelfWrite(...paths: string[]): void {
		const until = Date.now() + SELF_WRITE_GRACE_MS;
		for (const path of paths) {
			this.selfWrites.set(normalizePath(path), until);
		}
	}

	// Consulted by the vault event handlers. Without it a pull feeds itself: the
	// files it writes look exactly like edits the user just made, so the vault is
	// marked dirty and pushed straight back, and a rename it applies is recorded
	// as a local rename and declared to the other device as though this vault had
	// performed it.
	isSelfWrite(path: string): boolean {
		const key = normalizePath(path);
		const until = this.selfWrites.get(key);
		if (until === undefined) return false;
		if (Date.now() > until) {
			this.selfWrites.delete(key);
			return false;
		}
		return true;
	}

	// Newest first, capped. The side panel is the only reader, and it wants to
	// show what just happened without scrolling.
	private record(kind: ActivityKind, text: string): void {
		this.activity.unshift({ at: Date.now(), kind, text });
		if (this.activity.length > ACTIVITY_LIMIT) {
			this.activity.length = ACTIVITY_LIMIT;
		}
		this.debug(`[${kind}] ${text}`);
		this.refreshUI();
	}

	// Same information as the in-memory activity list, but written to disk. The
	// status panel is lost the moment the app closes or the device is out of
	// sight; this is what lets a sync that happened on a device nobody is
	// watching still be read back afterward.
	private debug(line: string): void {
		if (!this.state.debugLog) this.state.debugLog = [];
		this.state.debugLog.push(`${new Date().toISOString()} ${line}`);
		if (this.state.debugLog.length > DEBUG_LOG_LIMIT) {
			this.state.debugLog.splice(0, this.state.debugLog.length - DEBUG_LOG_LIMIT);
		}
		void this.stateStore.save(this.state);
	}

	// Called from the vault's rename event, which is the only place the old and
	// new path are known together. Once the event is gone the old path is just a
	// file that is not there any more, indistinguishable from a deletion.
	recordRename(oldPath: string, newPath: string): void {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (!from || !to || from === to) return;

		// A renamed folder arrives as one event, but every tracked file beneath it
		// moved too.
		const pairs: [string, string][] = [[from, to]];
		for (const trackedPath of Object.keys(this.state.trackedFiles)) {
			if (trackedPath.startsWith(`${from}/`)) {
				pairs.push([trackedPath, `${to}${trackedPath.slice(from.length)}`]);
			}
		}

		for (const [start, end] of pairs) {
			this.applyRenamePair(start, end);
		}
		void this.stateStore.save(this.state);
	}

	/** Collapses a chain of renames so the remote is told the original path. */
	private applyRenamePair(from: string, to: string): void {
		let origin = from;
		for (const [start, current] of Object.entries(this.state.pendingRenames)) {
			if (current === from) {
				origin = start;
				delete this.state.pendingRenames[start];
				break;
			}
		}

		// Renamed back to where it started, so there is nothing to declare.
		if (origin === to) {
			delete this.state.pendingRenames[origin];
			return;
		}
		if (!this.state.trackedFiles[origin]) return;
		this.state.pendingRenames[origin] = to;
	}

	/** Compares this vault against the repository before anything is linked. */
	async runSetupCheck(onProgress?: ProgressCallback): Promise<SetupCheckResult> {
		return new SetupCheck(this.vault, this.getClient(), this.settings).run(onProgress);
	}

	private get syncEnabled(): boolean {
		return this.settings.syncEnabled;
	}

	markDirty(): void {
		if (!this.syncEnabled) return;
		if (this.needsStartingPoint()) {
			this.dirty = true;
			return;
		}
		const wasClean = !this.dirty;
		this.dirty = true;
		this.setStatus('pending', 'Local changes pending.');
		if (wasClean) this.record('info', 'Local changes waiting to be pushed');
		this.scheduleDebouncedPush();
	}

	startPolling(): void {
		this.stopPolling();
		this.pollTimer = window.setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
				return;
			}
			if (!this.syncEnabled) return;
			if (Date.now() < this.syncHoldUntil) return;
			void this.checkRemote();
		}, PULL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.pollTimer) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	async onActivation(): Promise<void> {
		if (!this.syncEnabled) return;
		const last = this.state.lastRemoteCheck ? Date.parse(this.state.lastRemoteCheck) : 0;
		if (Date.now() - last < PULL_INTERVAL_MS) {
			return;
		}
		await this.checkRemote();
	}

	// True while this vault has never been linked to a commit. Everything
	// automatic stays inert until a starting point is chosen.
	needsStartingPoint(): boolean {
		return !this.state.lastSyncedCommit;
	}

	// "Upload this vault." Adopts the remote's current position without
	// downloading anything, then pushes. Every local file is untracked at this
	// point, so the push carries all of them; remote-only files are untouched on
	// GitHub and arrive with the next ordinary pull.
	async adoptLocal(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.setStatus('pushing', 'Uploading this vault...');
		try {
			const github = this.getClient();
			const ref = await github.getBranchReference(true);
			const commit = await github.getCommit(ref.object.sha);
			const remote = await github.readTreeSnapshot(commit.sha, commit.tree.sha);

			this.state.lastSyncedCommit = remote.commitSha;
			this.state.lastSyncedTree = treeMapOf(remote);
			await this.stateStore.save(this.state);

			await this.performPush('adopt');
			new Notice('GitSync: this vault is now the starting point.');
		} catch (error) {
			this.state.lastSyncedCommit = null;
			this.state.lastSyncedTree = {};
			await this.stateStore.save(this.state);
			this.handleError(error);
		} finally {
			this.running = false;
		}
	}

	// "Download from GitHub." Overwrites this vault's copies with the remote's.
	// Files that exist only locally are left alone: this replaces what both
	// sides have, it does not empty the vault.
	async adoptRemote(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.setStatus('pulling', 'Downloading from GitHub...');
		try {
			const github = this.getClient();
			const ref = await github.getBranchReference(true);
			const commit = await github.getCommit(ref.object.sha);
			const remote = await github.readTreeSnapshot(commit.sha, commit.tree.sha);

			const pull = new PullManager(this.vault, github, this.settings);
			const result = await pull.adoptRemote(remote, this.state, (paths) =>
				window.confirm(
					`${paths.length} file(s) in this vault differ from GitHub and will be replaced.\n\n` +
						`The current versions are moved to the vault's .trash folder first:\n\n` +
						listForPrompt(paths) +
						'\n\nReplace them?',
				),
			);

			if (result.cancelled) {
				new Notice('GitSync: cancelled. Nothing was changed.');
				this.setStatus('pending', 'No starting point chosen yet.');
				return;
			}

			const now = new Date().toISOString();
			this.state.lastSyncedCommit = remote.commitSha;
			this.state.lastSyncedTree = treeMapOf(remote);
			this.state.lastSuccessfulPull = now;
			this.state.lastRemoteCheck = now;
			await this.stateStore.save(this.state);

			this.dirty = false;
			this.setStatus('synced', `Downloaded ${result.pulled} file(s).`);
			new Notice(`GitSync: downloaded ${result.pulled} file(s) from GitHub.`);
			this.refreshUI();
		} catch (error) {
			this.state.lastSyncedCommit = null;
			this.state.lastSyncedTree = {};
			await this.stateStore.save(this.state);
			this.handleError(error);
		} finally {
			this.running = false;
		}
	}

	async initialPull(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pulling', 'Initial pull...');
		try {
			const github = this.getClient();
			const ref = await github.getBranchReference();
			const commit = await github.getCommit(ref.object.sha);
			const remote = await github.readTreeSnapshot(commit.sha, commit.tree.sha);

			const pull = new PullManager(this.vault, github, this.settings);
			const result = await pull.performInitialPull(remote, this.state);

			const now = new Date().toISOString();
			this.state.lastSyncedCommit = remote.commitSha;
			this.state.lastSyncedTree = treeMapOf(remote);
			this.state.lastRemoteCheck = now;
			this.state.lastSuccessfulPull = now;
			await this.stateStore.save(this.state);

			this.dirty = false;
			this.setStatus('synced', `Initial pull complete: ${result.pulled} file(s).`);
			new Notice(`GitSync: initial pull complete (${result.pulled} file(s)).`);
			this.refreshUI();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			await this.runRequestedIfNeeded();
		}
	}

	async syncNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('syncing', 'Synchronizing...');
		try {
			await this.syncInternal();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			await this.runRequestedIfNeeded();
		}
	}

	async pullNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pulling', 'Pulling...');
		try {
			await this.pullInternal();
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			await this.runRequestedIfNeeded();
		}
	}

	// The manual push. Unlike the debounced automatic push this carries
	// deletions, because a person pressing a button has an intent that a timer
	// does not, and deletions are still confirmed before a large batch is sent.
	async pushEverything(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pushing', 'Pushing...');
		try {
			if (!this.state.lastSyncedCommit) {
				throw new Error(
					'This vault has not been linked to GitHub yet. Turn on automatic synchronization and choose a starting point first.',
				);
			}
			await this.performPush('manual');
		} catch (error) {
			this.handleError(error);
		} finally {
			this.running = false;
			await this.runRequestedIfNeeded();
		}
	}

	async pushNow(): Promise<void> {
		if (this.running) {
			this.requested = true;
			return;
		}
		this.running = true;
		this.setStatus('pushing', 'Pushing...');
		try {
			await this.pushInternal();
		} catch (error) {
			this.handleError(error);
			if (this.dirty && !this.needsStartingPoint()) {
				this.scheduleDebouncedPush();
			}
		} finally {
			this.running = false;
			await this.runRequestedIfNeeded();
		}
	}

	// Sync now is the only entry point that does both halves, and even here they
	// are two independent operations run in sequence, not one combined
	// procedure. It is the deliberate, full reconcile: the only place deletions
	// move in either direction.
	private async syncInternal(): Promise<void> {
		await this.pullInternal(true);
		await this.performPush('manual');
	}

	// Pull is how this device gets current. It runs on activation, on the poll
	// timer, and from sync now / pull now, never as a precondition of pushing.
	//
	// Deletions are applied here rather than only on an explicit sync. The
	// reason they were withheld was that a path missing from the remote tree was
	// indistinguishable from one this device had simply never pulled, and from
	// one a stale read had failed to mention. Neither is true any more:
	// lastSyncedTree says exactly what the remote held, and the comparison below
	// refuses to act at all unless the remote genuinely moved forward.
	private async pullInternal(allowDeletions = true): Promise<void> {
		const github = this.getClient();

		if (!this.state.lastSyncedCommit) {
			await this.initialPull();
			return;
		}

		const ref = await github.getBranchReference();
		const remoteHead = ref.object.sha;

		if (remoteHead === this.state.lastSyncedCommit) {
			await this.pruneConflictsAgainstSyncedTree();
			this.state.lastRemoteCheck = new Date().toISOString();
			await this.stateStore.save(this.state);
			this.setStatus(
				Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
				'No remote changes.',
			);
			return;
		}

		const comparison = await github.compareCommits(this.state.lastSyncedCommit, remoteHead);
		const relation = comparison.status;

		// A head that is behind or identical is a stale read, not a branch that
		// moved. Drop the cached ETag so the next poll asks for a fresh body.
		if (relation === 'identical' || relation === 'behind') {
			github.invalidateBranchCache();
			this.state.lastRemoteCheck = new Date().toISOString();
			await this.stateStore.save(this.state);
			this.setStatus(
				Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
				'No remote changes.',
			);
			return;
		}

		await this.reconcileRemoteAndLocal(
			remoteHead,
			github,
			allowDeletions,
			relation,
			renamesDeclaredIn(comparison.commits),
		);
	}

	private async pushInternal(): Promise<void> {
		if (!this.state.lastSyncedCommit) {
			throw new Error('Complete an initial pull before pushing.');
		}
		await this.performPush('automatic');
	}

	// Push stands alone. It reads the branch itself, builds its commit on top of
	// whatever the remote currently holds, and retries if the branch moves while
	// it works. It never pulls first: GitHub carries over every path this device
	// did not touch, so a change made elsewhere to a different file survives
	// untouched. Getting this vault current is the pull path's job.
	//
	// What differs by trigger is only how a large batch of deletions is treated.
	// A person who pressed push is there to answer for it, whereas a background
	// timer is not, so a bulk deletion waits for someone to look at it rather
	// than being confirmed by a dialog nobody asked for.
	async performPush(trigger: PushTrigger = 'automatic'): Promise<void> {
		this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;
		try {
			await this.performPushInternal(trigger);
		} finally {
			// The settling period counts from the moment the push actually
			// finished. Arming it only at the start left a long push clear to be
			// followed immediately by another one.
			this.syncHoldUntil = Date.now() + POLL_HOLD_AFTER_PUSH_MS;
		}
	}

	private async performPushInternal(trigger: PushTrigger): Promise<void> {
		const github = this.getClient();
		const push = new PushManager(this.vault, github, this.settings);

		const result = await push.push(this.state, {
			// Adoption is the one push that must not delete: nothing was tracked
			// before it, so every absence is meaningless rather than intentional.
			includeDeletions: trigger !== 'adopt',
			userNamed: this.userNamed,
			confirmDeletions: (paths) =>
				trigger === 'manual'
					? window.confirm(
							`Sync will delete ${paths.length} file(s) from GitHub because they are no longer in this vault:\n\n` +
								listForPrompt(paths) +
								'\n\nIf this vault has not finished loading, cancel and try again.\n\nDelete them on GitHub?',
						)
					: false,
		});

		this.debug(`push trigger=${trigger}`);
		for (const line of result.trace) this.debug(`push-trace ${line}`);

		if (result.remote) {
			await this.pruneResolvedConflicts(result.remote);
			await this.recordCollisions(result.collisions, result.remote);
		}

		if (result.withheldDeletions.length) {
			const held = result.withheldDeletions.length;
			this.record('info', `${held} deletion(s) held back`);
			new Notice(
				trigger === 'manual'
					? `GitSync: kept ${held} file(s) on GitHub. Nothing was deleted.`
					: `GitSync: ${held} deletion(s) held back. Use Push in settings to send them.`,
			);
		}

		if (result.deletedPaths.length) {
			this.record('push', `Removed ${result.deletedPaths.length} file(s) from GitHub`);
		}

		if (result.pushed && result.commitSha) {
			this.state.lastSuccessfulPush = new Date().toISOString();
			this.record('push', `Pushed ${result.changedCount} change(s) to GitHub`);

			// Only advance the synced position when the push started from the
			// commit this vault already knew about. Otherwise the next pull has to
			// reconcile the difference.
			if (result.remote?.commitSha === this.state.lastSyncedCommit) {
				this.state.lastSyncedCommit = result.commitSha;
				const tree = treeMapOf(result.remote);
				for (const path of result.deletedPaths) delete tree[path];
				for (const [path, sha] of Object.entries(result.writtenShas)) {
					tree[path] = sha;
					this.userNamed.delete(path);
				}
				this.state.lastSyncedTree = tree;
			}
		}

		await this.pruneConflictsAgainstSyncedTree();
		this.state.lastRemoteCheck = new Date().toISOString();
		await this.stateStore.save(this.state);

		this.dirty = false;
		if (result.deferredUntil !== null) {
			this.dirty = true;
			this.scheduleDeferredPush(result.deferredUntil);
		}

		const conflictCount = Object.keys(this.state.conflicts).length;
		this.setStatus(
			conflictCount ? 'conflict' : 'synced',
			conflictCount
				? `${conflictCount} conflict(s) need attention.`
				: result.pushed
					? `Pushed ${result.changedCount} change(s).`
					: 'Nothing to push.',
		);
		this.refreshUI();
	}

	// A collision is the one thing GitHub cannot merge for us: the same file
	// changed here and there. The local file is left exactly as it is and the
	// remote version is brought down beside it.
	private async recordCollisions(paths: string[], remote: RemoteSnapshot): Promise<void> {
		if (!paths.length) return;

		const conflicts: ConflictRecord[] = [];
		for (const path of paths) {
			if (this.state.conflicts[path]) continue;

			const file = this.vault.getAbstractFileByPath(path);
			const localHash =
				file instanceof TFile ? await sha256(await this.vault.readBinary(file)) : null;
			const remoteEntry = remote.entries.get(path);

			conflicts.push({
				path,
				detectedAt: new Date().toISOString(),
				localHash,
				remoteSha: remoteEntry?.sha ?? null,
				remoteExists: Boolean(remoteEntry && remoteEntry.type === 'blob'),
				conflictCopyPath: null,
			});
		}

		await this.recordConflicts(conflicts, remote);
	}

	// Combines a file that changed here and on the remote. Returns true when the
	// vault now holds merged text; false means it is a genuine conflict.
	private async mergeDivergence(
		path: string,
		remote: RemoteSnapshot,
		github: GitHubClient,
	): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return false;

		const bytes = await this.vault.readBinary(file);
		const tracked = this.state.trackedFiles[path];
		const remoteEntry = remote.entries.get(path);

		const outcome = await attemptMerge(github, path, bytes, tracked, remoteEntry);
		if (!outcome || !remoteEntry?.sha) return false;

		this.markSelfWrite(path);
		await this.vault.process(file, () => outcome.merged);
		this.record('merge', `Merged remote edits into ${basename(path)}`);

		this.state.trackedFiles[path] = {
			localHash: await sha256(outcome.theirBytes),
			remoteSha: remoteEntry.sha,
		};
		this.markDirty();
		return true;
	}

	// Records tracking for paths whose local bytes already match the remote blob,
	// and drops them from the pending change sets so neither side acts on them.
	private reconcileIdentical(
		identical: IdenticalPaths,
		localChanged: Set<string>,
		remoteChanged: Set<string>,
	): void {
		for (const [path, entry] of identical) {
			this.state.trackedFiles[path] = {
				localHash: entry.localHash,
				remoteSha: entry.remoteSha,
			};
			localChanged.delete(path);
			remoteChanged.delete(path);
		}
	}

	// Pull only. This brings the vault up to the remote commit and never pushes;
	// outgoing changes are the debounced push's business.
	private async reconcileRemoteAndLocal(
		remoteHeadSha: string,
		github: GitHubClient,
		allowDeletions = false,
		relation = 'ahead',
		declaredRenames: Map<string, string> = new Map(),
	): Promise<void> {
		this.setStatus('pulling', 'Inspecting remote changes...');
		this.record('info', 'New changes on GitHub');

		const remoteCommit = await github.getCommit(remoteHeadSha);
		const remote = await github.readTreeSnapshot(remoteHeadSha, remoteCommit.tree.sha);
		await this.pruneResolvedConflicts(remote);

		const remoteChanged = this.remoteChangedAgainstState(remote);
		const remoteDeleted = this.remoteDeletedAgainstState(remote);
		this.debug(
			`pull-scan relation=${relation} remoteDeleted=[${[...remoteDeleted].join(
				', ',
			)}] remoteChanged=[${[...remoteChanged].join(', ')}]`,
		);

		const renames = this.detectRemoteRenames(remote, remoteDeleted, remoteChanged);
		for (const [from, to] of declaredRenames) {
			if (remoteDeleted.has(from) && remote.entries.has(to)) {
				renames.set(from, to);
			}
		}
		if (renames.size) {
			this.debug(
				`pull-renames detected=[${[...renames.entries()]
					.map(([from, to]) => `${from}->${to}`)
					.join(', ')}]`,
			);
		}

		const renamed = await this.applyRemoteRenames(
			renames,
			remote,
			remoteDeleted,
			remoteChanged,
		);
		this.debug(
			`pull-renames applied=${renamed} remoteDeletedAfter=[${[...remoteDeleted].join(', ')}]`,
		);

		const deletionsTrustworthy = allowDeletions && relation === 'ahead';
		if (allowDeletions && remoteDeleted.size && !deletionsTrustworthy) {
			new Notice(
				`GitSync: the remote has diverged from this vault, so ${remoteDeleted.size} deletion(s) were not applied.`,
			);
		}

		const detector = new ChangeDetector(this.vault, this.settings);
		const local = await detector.detectLocalChanges(
			this.state,
			this.settings.pushExtensions,
			this.userNamed,
		);

		const conflictDetector = new ConflictDetector(this.vault, this.settings.ignoredPaths);
		const detection = await conflictDetector.detect(
			this.state,
			remote,
			local.modifiedOrCreated,
			remoteChanged,
			remoteDeleted,
		);
		this.reconcileIdentical(detection.identical, local.modifiedOrCreated, remoteChanged);

		const conflicts: ConflictRecord[] = [];
		for (const conflict of detection.conflicts) {
			if (await this.mergeDivergence(conflict.path, remote, github)) {
				remoteChanged.delete(conflict.path);
				continue;
			}
			conflicts.push(conflict);
		}
		await this.recordConflicts(conflicts, remote);

		const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
		const safeRemoteChanged = new Set(
			[...remoteChanged].filter((path) => !conflictPaths.has(path)),
		);
		const safeRemoteDeleted = deletionsTrustworthy
			? new Set([...remoteDeleted].filter((path) => !conflictPaths.has(path)))
			: new Set<string>();
		this.debug(
			`pull-delete-plan deletionsTrustworthy=${deletionsTrustworthy} conflictPaths=[${[
				...conflictPaths,
			].join(', ')}] safeRemoteDeleted=[${[...safeRemoteDeleted].join(', ')}]`,
		);

		this.markSelfWrite(...safeRemoteChanged, ...safeRemoteDeleted);
		const pull = new PullManager(this.vault, github, this.settings);
		const pullResult = await pull.applyRemoteChanges(
			remote,
			this.state,
			safeRemoteChanged,
			safeRemoteDeleted,
		);
		this.debug(
			`pull-delete-result actuallyDeleted=[${[...pullResult.deletedPaths].join(
				', ',
			)}] pulledFileCount=${pullResult.pulled}`,
		);
		for (const line of pullResult.trace) this.debug(`pull-delete-trace ${line}`);

		// A deletion that was not applied has to stay in the recorded tree, or the
		// next pull would see it as already gone and never apply it.
		const nextTree = treeMapOf(remote);
		let carriedForward = 0;
		for (const path of remoteDeleted) {
			if (pullResult.deletedPaths.has(path)) continue;
			const previous = this.state.lastSyncedTree[path];
			if (previous === undefined) continue;
			nextTree[path] = previous;
			carriedForward++;
		}
		if (carriedForward) {
			this.record('info', `${carriedForward} remote deletion(s) not applied yet`);
		}

		const now = new Date().toISOString();
		this.state.lastSyncedCommit = remoteHeadSha;
		this.state.lastSyncedTree = nextTree;
		this.state.lastRemoteCheck = now;
		this.state.lastSuccessfulPull = now;
		await this.stateStore.save(this.state);

		this.dirty = local.modifiedOrCreated.size > 0 || local.deleted.size > 0;
		if (this.dirty) {
			this.scheduleDebouncedPush();
		}

		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			renamed
				? `Pulled ${pullResult.pulled} file(s), moved ${renamed}.`
				: `Pulled ${pullResult.pulled} file(s).`,
		);

		if (pullResult.pulled || renamed || pullResult.deletedPaths.size) {
			const parts: string[] = [];
			if (pullResult.pulled) parts.push(`${pullResult.pulled} file(s)`);
			if (renamed) parts.push(`${renamed} renamed`);
			if (pullResult.deletedPaths.size) parts.push(`${pullResult.deletedPaths.size} removed`);
			this.record('pull', `Pulled ${parts.join(', ')}`);
		}

		this.refreshUI();
	}

	private remoteChangedAgainstState(remote: RemoteSnapshot): Set<string> {
		const result = new Set<string>();
		const remoteExtensions = this.remoteTrackingExtensions();

		for (const [path, tracked] of Object.entries(this.state.trackedFiles)) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;

			const remoteEntry = remote.entries.get(path);
			if (remoteEntry && remoteEntry.type === 'blob' && remoteEntry.sha !== tracked.remoteSha) {
				result.add(path);
			}
		}

		for (const [path, entry] of remote.entries) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (entry.type === 'blob' && !this.state.trackedFiles[path]) {
				result.add(path);
			}
		}

		return result;
	}

	// A path was deleted when the tree this vault last synced to contained it and
	// the current tree does not. trackedFiles is deliberately not consulted here:
	// it holds only what this device happened to pull, which is what made a file
	// that was never this device's business look exactly like a deleted one.
	private remoteDeletedAgainstState(remote: RemoteSnapshot): Set<string> {
		const result = new Set<string>();
		const remoteExtensions = this.remoteTrackingExtensions();

		for (const path of Object.keys(this.state.lastSyncedTree)) {
			if (!matchesExtensions(path, remoteExtensions)) continue;
			if (isIgnoredPath(path, this.settings.ignoredPaths)) continue;
			if (!remote.entries.has(path)) {
				result.add(path);
			}
		}

		return result;
	}

	// A rename arrives at this device as one path vanishing and an unrelated path
	// appearing. Git does not record renames either: it recognises them by
	// noticing the content is unchanged, and the blob sha is precisely that
	// comparison, already computed by GitHub.
	//
	// A file renamed and edited in the same remote commit has a different sha
	// and is not matched. It falls through to delete-plus-download, which costs a
	// round trip and loses nothing.
	private detectRemoteRenames(
		remote: RemoteSnapshot,
		remoteDeleted: Set<string>,
		remoteChanged: Set<string>,
	): Map<string, string> {
		const renames = new Map<string, string>();
		if (!remoteDeleted.size) return renames;

		const arrivalsBySha = new Map<string, string[]>();
		for (const path of remoteChanged) {
			if (this.state.trackedFiles[path]) continue;
			const sha = remote.entries.get(path)?.sha;
			// Every empty file shares one sha, so matching on it would pair
			// unrelated paths.
			if (!sha || sha === EMPTY_BLOB_SHA) continue;

			const existing = arrivalsBySha.get(sha);
			if (existing) existing.push(path);
			else arrivalsBySha.set(sha, [path]);
		}
		if (!arrivalsBySha.size) return renames;

		const claimed = new Set<string>();
		for (const from of remoteDeleted) {
			const sha = this.state.lastSyncedTree[from];
			if (!sha || sha === EMPTY_BLOB_SHA) continue;

			const to = arrivalsBySha.get(sha)?.find((path) => !claimed.has(path));
			if (!to) continue;

			claimed.add(to);
			renames.set(from, to);
		}

		return renames;
	}

	// Moves the local file instead of deleting it and downloading a copy under
	// the new name. This runs on every pull, including automatic ones: a rename
	// preserves content, so unlike a deletion there is nothing here to withhold
	// until the user asks for it.
	private async applyRemoteRenames(
		renames: Map<string, string>,
		remote: RemoteSnapshot,
		remoteDeleted: Set<string>,
		remoteChanged: Set<string>,
	): Promise<number> {
		let renamed = 0;

		for (const [from, to] of renames) {
			const file = this.vault.getAbstractFileByPath(from);
			const sha = remote.entries.get(to)?.sha;
			const movable =
				file instanceof TFile &&
				!this.vault.getAbstractFileByPath(to) &&
				matchesExtensions(to, this.settings.pullExtensions) &&
				!isIgnoredPath(to, this.settings.ignoredPaths) &&
				isSafeVaultPath(to);
			if (!movable) continue;

			const tracked = this.state.trackedFiles[from];
			this.markSelfWrite(from, to);
			await this.ensureParentFolder(to);
			await this.vault.rename(file, to);
			delete this.state.trackedFiles[from];

			if (tracked && sha) {
				const moved = this.vault.getAbstractFileByPath(to);
				this.state.trackedFiles[to] = {
					...tracked,
					remoteSha: sha,
					...(moved instanceof TFile
						? { mtime: moved.stat.mtime, size: moved.stat.size }
						: {}),
				};
			}

			remoteDeleted.delete(from);
			remoteChanged.delete(to);
			renamed++;
		}

		return renamed;
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				await this.vault.createFolder(current);
			}
		}
	}

	// Prunes conflicts using the recorded tree rather than a freshly fetched one.
	//
	// Conflicts were only ever re-examined during a reconcile or a push, and both
	// of those look at the remote as it was before the operation. Once the two
	// devices had settled and the branch went quiet, nothing looked again: the
	// "no remote changes" path returns early, so a conflict both sides had long
	// since resolved stayed pinned to the status bar indefinitely.
	//
	// lastSyncedTree already describes the remote at the synced commit, so this
	// costs no request at all.
	private async pruneConflictsAgainstSyncedTree(): Promise<void> {
		const paths = Object.keys(this.state.conflicts);
		if (!paths.length) return;

		let changed = false;
		for (const path of paths) {
			const remoteSha = this.state.lastSyncedTree[path] ?? null;
			if (await this.resolveConflictIfSettled(path, remoteSha)) {
				changed = true;
			}
		}

		if (changed) {
			await this.stateStore.save(this.state);
			this.refreshUI();
		}
	}

	// Conflict records are sticky: recordConflicts refuses to overwrite an
	// existing entry, and nothing else removes them. Without pruning, a conflict
	// that has since resolved itself pins the status bar to "conflict" forever
	// and leaves phantom entries in the conflict modal, where keep remote on a
	// path that no longer exists remotely would delete the local file.
	private async pruneResolvedConflicts(remote: RemoteSnapshot): Promise<void> {
		let changed = false;
		for (const path of Object.keys(this.state.conflicts)) {
			const remoteEntry = remote.entries.get(path);
			const remoteSha = remoteEntry?.type === 'blob' ? remoteEntry.sha : null;
			if (await this.resolveConflictIfSettled(path, remoteSha)) {
				changed = true;
			}
		}

		if (changed) {
			await this.stateStore.save(this.state);
			this.refreshUI();
		}
	}

	/**
	 * Drops one conflict record when it no longer describes a disagreement:
	 * either the path is gone from both sides, or both sides now hold identical
	 * bytes. Returns whether anything changed.
	 */
	private async resolveConflictIfSettled(
		path: string,
		remoteSha: string | null,
	): Promise<boolean> {
		const localFile = this.vault.getAbstractFileByPath(path);

		if (!(localFile instanceof TFile) && !remoteSha) {
			delete this.state.conflicts[path];
			return true;
		}

		if (localFile instanceof TFile && remoteSha) {
			const bytes = await this.vault.readBinary(localFile);
			if ((await gitBlobSha(bytes)) === remoteSha) {
				delete this.state.conflicts[path];
				this.state.trackedFiles[path] = {
					localHash: await sha256(bytes),
					remoteSha,
				};
				return true;
			}
		}

		return false;
	}

	private remoteTrackingExtensions(): string[] {
		return Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);
	}

	private async recordConflicts(
		conflicts: ConflictRecord[],
		remote: RemoteSnapshot,
	): Promise<void> {
		for (const conflict of conflicts) {
			if (this.state.conflicts[conflict.path]) continue;
			conflict.conflictCopyPath = await this.createConflictCopy(conflict.path, remote);
			this.state.conflicts[conflict.path] = conflict;
		}

		if (conflicts.length) {
			await this.stateStore.save(this.state);
			for (const conflict of conflicts) {
				this.record('conflict', `Conflict in ${basename(conflict.path)}`);
			}
			new Notice(`${conflicts.length} synchronization conflict(s) detected.`);
		}
	}

	/** Brings the remote version down beside the local one, named per device. */
	private async createConflictCopy(
		path: string,
		remote: RemoteSnapshot,
	): Promise<string | null> {
		const remoteEntry = remote.entries.get(path);
		if (!remoteEntry || remoteEntry.type !== 'blob' || !remoteEntry.sha) {
			return null;
		}

		const blob = await this.getClient().getBlob(remoteEntry.sha);
		const bytes = base64ToArrayBuffer(blob.content);

		const dot = path.lastIndexOf('.');
		const stem = dot >= 0 ? path.slice(0, dot) : path;
		const ext = dot >= 0 ? path.slice(dot) : '';
		const copyPath = `${stem} (conflict - ${this.state.deviceId})${ext}`;

		if (this.vault.getAbstractFileByPath(copyPath)) {
			return copyPath;
		}

		await this.ensureParentFolder(copyPath);
		this.markSelfWrite(copyPath);
		await this.vault.createBinary(copyPath, bytes);
		return copyPath;
	}

	async keepLocal(path: string): Promise<void> {
		if (!this.state.conflicts[path]) return;
		delete this.state.conflicts[path];
		await this.stateStore.save(this.state);
		this.markDirty();
		await this.pushNow();
	}

	async keepRemote(path: string): Promise<void> {
		if (!this.state.conflicts[path]) return;

		const github = this.getClient();
		const ref = await github.getBranchReference();
		const commit = await github.getCommit(ref.object.sha);
		const remote = await github.readTreeSnapshot(ref.object.sha, commit.tree.sha);
		const pull = new PullManager(this.vault, github, this.settings);

		if (remote.entries.has(path)) {
			await pull.applyRemoteChanges(remote, this.state, new Set([path]), new Set());
		} else {
			// Keeping a remote version that does not exist means deleting the local
			// file, which is worth asking about explicitly.
			const localFile = this.vault.getAbstractFileByPath(path);
			if (localFile instanceof TFile) {
				const proceed = window.confirm(
					`"${path}" does not exist on GitHub.\n\n` +
						`Keeping the remote version means deleting your local copy. It will be moved to the vault's .trash folder.\n\n` +
						'Delete the local file?',
				);
				if (!proceed) {
					new Notice('GitSync: kept the local file. Conflict left unresolved.');
					return;
				}
			}
			await pull.applyRemoteChanges(remote, this.state, new Set(), new Set([path]));
		}

		delete this.state.conflicts[path];
		this.state.lastSyncedCommit = ref.object.sha;
		this.state.lastSyncedTree = treeMapOf(remote);
		this.state.lastRemoteCheck = new Date().toISOString();
		await this.stateStore.save(this.state);

		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			`Kept remote version of ${path}.`,
		);
		this.refreshUI();
	}

	async clearConflict(path: string): Promise<void> {
		delete this.state.conflicts[path];
		await this.stateStore.save(this.state);
		this.setStatus(
			Object.keys(this.state.conflicts).length ? 'conflict' : 'synced',
			'Conflict cleared.',
		);
		this.refreshUI();
	}

	getClient(): GitHubClient {
		return new GitHubClient(
			this.settings.githubOwner.trim(),
			this.settings.githubRepo.trim(),
			this.settings.token,
			this.settings.branch.trim() || 'main',
		);
	}

	// Re-arms for a specific moment rather than the usual delay, so a held-back
	// new file is reconsidered exactly when it becomes eligible.
	private scheduleDeferredPush(at: number): void {
		this.armPushTimer(
			Math.max(
				PUSH_DELAY_SECONDS * 1000,
				at - Date.now() + 250,
				this.syncHoldUntil - Date.now() + 250,
			),
			() => void this.pushNow(),
		);
	}

	private scheduleDebouncedPush(): void {
		this.armPushTimer(
			Math.max(PUSH_DELAY_SECONDS * 1000, this.syncHoldUntil - Date.now() + 250),
			() => void this.pushNow(),
		);
	}

	// An edit made while a push was in flight asks for another sync the instant
	// that push returns. Holding it until the push has settled is what keeps the
	// second attempt from reading a stale branch and calling the file a conflict.
	private scheduleHeldSync(): void {
		this.armPushTimer(Math.max(0, this.syncHoldUntil - Date.now()) + 250, () =>
			void this.syncNow(),
		);
	}

	private armPushTimer(delay: number, run: () => void): void {
		if (this.pushTimer) {
			window.clearTimeout(this.pushTimer);
		}
		this.pushTimer = window.setTimeout(() => {
			this.pushTimer = null;
			run();
		}, delay);
	}

	private async checkRemote(): Promise<void> {
		if (!this.syncEnabled) return;
		if (this.running) return;
		if (Date.now() < this.syncHoldUntil) return;
		if (!this.state.lastSyncedCommit) return;

		try {
			const github = this.getClient();
			const ref = await github.getBranchReference();
			this.state.lastRemoteCheck = new Date().toISOString();

			if (ref.object.sha !== this.state.lastSyncedCommit) {
				await this.pullNow();
			} else if (this.dirty && !this.pushTimer) {
				await this.pushNow();
			}
		} catch (error) {
			this.handleError(error);
		}
	}

	private async runRequestedIfNeeded(): Promise<void> {
		if (!this.requested) return;
		this.requested = false;

		if (Date.now() < this.syncHoldUntil) {
			this.scheduleHeldSync();
			return;
		}
		await this.syncNow();
	}

	private handleError(error: unknown): void {
		let message = 'Synchronization failed.';

		if (error instanceof GitHubApiError) {
			switch (error.status) {
				case 401:
					message = `GitHub authentication failed. Check the token. — ${error.message}`;
					break;
				case 403:
					message = `GitHub denied the request or rate limiting is active. — ${error.message}`;
					break;
				case 404:
					message = `GitHub repository or branch was not found. — ${error.message}`;
					break;
				case 409:
				case 422:
					message = `GitHub rejected the request: ${error.message}`;
					break;
				case 0:
					message = error.message;
					break;
				default:
					message = `GitHub request failed (HTTP ${error.status}): ${error.message}`;
			}
		} else if (error instanceof Error) {
			message = error.message;
		}

		console.error('[GitSync]', error);
		this.record('error', message);
		this.setStatus('error', message);
		new Notice(`GitSync: ${message}`);
		this.refreshUI();
	}

	destroy(): void {
		this.stopPolling();
		if (this.pushTimer) {
			window.clearTimeout(this.pushTimer);
			this.pushTimer = null;
		}
	}
}
