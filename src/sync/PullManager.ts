import { App, Platform, TFile, Vault } from 'obsidian';
import { GitHubClient, RemoteSnapshot } from '../github/GitHubClient';
import { UltiSyncSettings, SyncStateData, TrackedFile } from '../types';
import {
	isIgnoredPath,
	isSafeVaultPath,
	isWritableOnThisPlatform,
	matchesExtensions,
	normalizePath,
} from '../vault/PathFilter';
import { base64ToArrayBuffer, gitBlobSha, sha256 } from '../vault/VaultScanner';

export interface ApplyResult {
	pulled: number;
	deletedPaths: Set<string>;
	trace: string[];
}

export interface AdoptResult {
	pulled: number;
	replaced: number;
	cancelled: boolean;
}

/** Blobs per round of downloads. Small enough that a large pull never holds
 *  every decoded file in memory at once. */
const BATCH_SIZE = 4;

export class PullManager {
	constructor(
		private app: App,
		private github: GitHubClient,
		private settings: UltiSyncSettings,
	) {}

	private get vault(): Vault {
		return this.app.vault;
	}

	// Every deletion in the plugin goes through here. FileManager.trashFile
	// follows the vault's own "Deleted files" preference, so a file this plugin
	// removes ends up wherever Obsidian would have put it.
	private async trash(file: TFile): Promise<void> {
		await this.app.fileManager.trashFile(file);
	}

	async applyRemoteChanges(
		remote: RemoteSnapshot,
		state: SyncStateData,
		safeChangedPaths: Iterable<string>,
		safeDeletedPaths: Iterable<string>,
	): Promise<ApplyResult> {
		const deletedPaths = new Set<string>();
		const trace: string[] = [];

		const changed = [...safeChangedPaths].filter((path) => this.isPullable(path, remote));
		const pulled = await this.downloadAndWrite(changed, remote, state);

		for (const path of safeDeletedPaths) {
			if (!matchesExtensions(path, this.settings.pullExtensions)) {
				trace.push(`${path}: skipped, extension not in pullExtensions`);
				continue;
			}
			if (isIgnoredPath(path, this.settings.ignoredPaths)) {
				trace.push(`${path}: skipped, ignoredPaths`);
				continue;
			}

			const file = this.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.trash(file);
				trace.push(`${path}: found locally, moved to trash`);
			} else {
				trace.push(
					`${path}: NOT found locally (getAbstractFileByPath returned ${
						file === null ? 'null' : typeof file
					}) — nothing to trash, only bookkeeping cleared`,
				);
			}
			delete state.trackedFiles[path];
			deletedPaths.add(path);
		}

		return { pulled, deletedPaths, trace };
	}

	// Used once, when the user chooses GitHub as the starting point on a vault
	// that already holds files. Unlike performInitialPull this does not refuse to
	// overwrite, because the user has explicitly asked for the remote to win, but
	// the versions it replaces are trashed rather than destroyed, and files that
	// exist only locally are left completely alone.
	//
	// The confirmation is asked for asynchronously because it is a modal now,
	// and a modal cannot answer before the frame it is opened in has ended.
	async adoptRemote(
		remote: RemoteSnapshot,
		state: SyncStateData,
		confirmOverwrite: (paths: string[]) => Promise<boolean>,
	): Promise<AdoptResult> {
		if (this.settings.pullExtensions.length === 0) {
			throw new Error('Select at least one pull extension first.');
		}

		const paths = Array.from(remote.entries.keys()).filter((path) =>
			this.isPullable(path, remote),
		);

		const differing: string[] = [];
		for (const path of paths) {
			const file = this.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) continue;
			const entry = remote.entries.get(path);
			if (!entry?.sha) continue;
			if ((await gitBlobSha(await this.vault.readBinary(file))) !== entry.sha) {
				differing.push(path);
			}
		}

		if (differing.length && !(await confirmOverwrite(differing))) {
			return { pulled: 0, replaced: 0, cancelled: true };
		}

		for (const path of differing) {
			const file = this.vault.getAbstractFileByPath(normalizePath(path));
			if (file instanceof TFile) {
				await this.trash(file);
			}
		}

		const pulled = await this.downloadAndWrite(paths, remote, state);
		return { pulled, replaced: differing.length, cancelled: false };
	}

	/**
	 * @param overwriteExisting - Set after a reset, which has just cleared the
	 * vault on purpose. The collision guard below exists to protect a vault that
	 * already holds work from a first-time pull, and applying it to a reset
	 * turns a file that resisted deletion into a reason to abandon the whole
	 * operation.
	 */
	async performInitialPull(
		remote: RemoteSnapshot,
		state: SyncStateData,
		overwriteExisting = false,
	): Promise<{ pulled: number; skipped: number }> {
		if (this.settings.pullExtensions.length === 0) {
			throw new Error('Select at least one pull extension before the initial pull.');
		}

		const paths = Array.from(remote.entries.keys()).filter((path) => {
			const entry = remote.entries.get(path);
			return Boolean(
				entry &&
					entry.type === 'blob' &&
					matchesExtensions(path, this.settings.pullExtensions) &&
					!isIgnoredPath(path, this.settings.ignoredPaths) &&
					isSafeVaultPath(path),
			);
		});

		const collisions = overwriteExisting
			? []
			: paths.filter((path) => this.vault.getAbstractFileByPath(path));
		if (collisions.length) {
			const SHOWN = 25;
			const list = collisions
				.slice(0, SHOWN)
				.map((path) => `  • ${path}`)
				.join('\n');
			const more =
				collisions.length > SHOWN ? `\n  ...and ${collisions.length - SHOWN} more` : '';
			throw new Error(
				`Initial pull would overwrite ${collisions.length} existing local file(s). ` +
					`Remove them (or the whole vault's content) first, then retry:\n` +
					list +
					more,
			);
		}

		const pulled = await this.downloadAndWrite(paths, remote, state);
		// Everything in the repository the extension filters exclude. Reported so
		// a repository that is mostly unsupported file types does not look like a
		// pull that quietly failed.
		return { pulled, skipped: remote.entries.size - paths.length };
	}

	// Blobs are fetched a batch at a time rather than strictly one after another.
	// Each download is a separate round trip, and on a phone the serial version
	// spends nearly all of its time waiting.
	private async downloadAndWrite(
		paths: string[],
		remote: RemoteSnapshot,
		state: SyncStateData,
	): Promise<number> {
		let pulled = 0;

		for (let index = 0; index < paths.length; index += BATCH_SIZE) {
			const batch = paths.slice(index, index + BATCH_SIZE);
			const fetched = await Promise.all(
				batch.map(async (path) => {
					const entry = remote.entries.get(path);
					if (!entry?.sha) return null;
					const blob = await this.github.getBlob(entry.sha);
					return {
						path,
						sha: entry.sha,
						bytes: base64ToArrayBuffer(blob.content),
					};
				}),
			);

			for (const item of fetched) {
				if (!item) continue;
				await this.writeBinaryFile(item.path, item.bytes);
				state.trackedFiles[item.path] = {
					localHash: await sha256(item.bytes),
					remoteSha: item.sha,
					...this.statOf(item.path),
				};
				pulled++;
			}
		}

		return pulled;
	}

	private isPullable(path: string, remote: RemoteSnapshot): boolean {
		const entry = remote.entries.get(path);
		return Boolean(
			entry &&
				entry.type === 'blob' &&
				entry.sha &&
				matchesExtensions(path, this.settings.pullExtensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths) &&
				isSafeVaultPath(path) &&
				isWritableOnThisPlatform(path, Platform.isWin),
		);
	}

	/** Remote paths this platform cannot represent, so they can be reported. */
	unwritablePaths(remote: RemoteSnapshot): string[] {
		return Array.from(remote.entries.keys()).filter(
			(path) => !isWritableOnThisPlatform(path, Platform.isWin),
		);
	}

	// Read back after writing: the stat has to describe the file as it now sits on
	// disk, or the change detector's fast path will think it was edited.
	private statOf(path: string): Pick<TrackedFile, 'mtime' | 'size'> {
		const file = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) return {};
		return { mtime: file.stat.mtime, size: file.stat.size };
	}

	private async writeBinaryFile(path: string, bytes: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParentFolder(normalized);

		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, bytes);
			return;
		}
		if (existing) {
			throw new Error(`Cannot write ${normalized}: a folder already exists at that path.`);
		}
		await this.vault.createBinary(normalized, bytes);
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const parts = path.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.vault.getAbstractFileByPath(current)) {
				await this.vault.createFolder(current);
			}
		}
	}
}
