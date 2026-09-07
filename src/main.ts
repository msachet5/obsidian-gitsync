import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { SyncManager } from './sync/SyncManager';
import { SyncStateStore, generateDeviceId } from './sync/SyncState';
import { ConflictModal } from './ui/ConflictModal';
import { ConfirmModal } from './ui/ConfirmModal';
import { CredentialDraft, SettingsTab } from './ui/SettingsTab';
import { SetupCheckModal, SetupDecision } from './ui/SetupCheckModal';
import { StatusBarController } from './ui/StatusBar';
import { SYNC_PANEL_VIEW_TYPE, SyncPanelView } from './ui/SyncPanelView';
import { SetupCheckResult, summarize } from './sync/SetupCheck';
import { GitHubApiError } from './github/GitHubClient';
import {
	ConnectionState,
	DEFAULT_EXTENSIONS,
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
	LARGE_CHECK_BYTES,
	GitSyncSettings,
	PersistedData,
	SyncStateData,
	SyncStatus,
} from './types';
import {
	isIgnoredPath,
	matchesExtensions,
	normalizePath,
	setConfigDir,
} from './vault/PathFilter';

/**
 * Obsidian does not type the settings modal, so opening this plugin's own tab
 * goes through a narrow cast rather than an app-wide `any`.
 */
/**
 * Turns a failure into something a person can act on. The distinction that
 * matters is whose problem it is: the network, the token, or the repository.
 */
function describeConnectionFailure(error: unknown): string {
	if (error instanceof GitHubApiError) {
		switch (error.status) {
			case 0:
				return 'Not connected. Check your internet connection and try again.';
			case 401:
				return 'Bad credentials, please recheck your GitHub creds. The token may have expired or been revoked — generate a new one if so.';
			case 403:
				return 'GitHub refused the request. The token may lack Contents read/write on this repository, or the rate limit is exhausted.';
			case 404:
				return 'Repository or branch not found. Check the owner and repository names, and that the token can see this repository.';
			default:
				return `GitHub request failed (HTTP ${error.status}): ${error.message}`;
		}
	}
	return error instanceof Error ? error.message : 'Connection failed.';
}

/** A defaults object nobody else shares, so later edits cannot reach back. */
function freshSettings(): GitSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		pullExtensions: [...DEFAULT_EXTENSIONS],
		pushExtensions: [...DEFAULT_EXTENSIONS],
		ignoredPaths: [],
	};
}

function formatBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

interface SettingsCapableApp {
	setting?: {
		open(): void;
		openTabById(id: string): void;
	};
}

export default class GitSyncPlugin extends Plugin {
	settings: GitSyncSettings = freshSettings();

	private state!: SyncStateData;
	private stateStore!: SyncStateStore;
	private syncManager!: SyncManager;
	private statusBar!: StatusBarController;
	private settingsTab!: SettingsTab;

	private currentStatus: SyncStatus = 'synced';
	private currentStatusDetail = 'Ready';

	// Set while a comparison is running, so a second Save or toggle cannot start
	// an overlapping check against the same repository.
	private checkRunning = false;

	private connectionState: ConnectionState = 'incomplete';

	async onload(): Promise<void> {
		setConfigDir(this.app.vault.configDir);
		await this.loadSettingsAndState();

		this.statusBar = new StatusBarController(this, this.app.workspace, () =>
			this.openStatus(),
		);
		this.syncManager = this.createSyncManager();

		this.settingsTab = new SettingsTab(
				this.app,
				{
					settings: this.settings,
					saveSettings: () => this.saveSettings(),
					applyCredentials: (draft) => this.applyCredentials(draft),
				setSyncEnabled: (enabled) => this.setSyncEnabled(enabled),
				hasCredentials: () => this.hasCredentials(),
				getConnectionState: () => this.getConnectionState(),
				confirmReset: () => this.confirmReset(),
				pushNow: () => this.syncManager.pushEverything(),
				resetSyncState: () => this.resetSyncState(),
				getDeviceId: () => this.state.deviceId,
				getStatus: () => this.statusSnapshot(),
				},
			this,
		);
		this.addSettingTab(this.settingsTab);

		this.registerView(
			SYNC_PANEL_VIEW_TYPE,
			(leaf) =>
				new SyncPanelView(leaf, {
					getStatus: () => this.statusSnapshot(),
					getState: () => this.state,
					getActivity: () => this.syncManager.getActivity(),
					openConflicts: () => new ConflictModal(this.app, this.syncManager).open(),
					openSettings: () => this.openSettings(),
				}),
		);

		this.addRibbonIcon('refresh-cw', 'GitSync status', () => {
			void this.revealPanel();
		});

		this.registerCommands();
		this.registerVaultEvents();
		this.registerActivationEvents();
		this.syncManager.startPolling();

		this.app.workspace.onLayoutReady(() => {
			// A short delay so the vault index is populated before the first scan.
			window.setTimeout(() => {
				void this.probeConnection();
				void this.syncManager.onActivation();
			}, 1500);
		});

		this.setStatus('synced', 'Ready.');
	}

	onunload(): void {
		this.syncManager?.destroy();
	}

	private createSyncManager(): SyncManager {
		return new SyncManager(
			this.app.vault,
			this.settings,
			this.stateStore,
			this.state,
			(status, detail) => this.setStatus(status, detail),
			() => this.updateStateReference(),
		);
	}

	private statusSnapshot(): { status: SyncStatus; detail?: string } {
		return { status: this.currentStatus, detail: this.currentStatusDetail };
	}

	/** Opens the panel in the right sidebar, or reveals it if already there. */
	private async revealPanel(): Promise<void> {
		const [existing] = this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE);
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (!leaf) {
			new Notice('GitSync: could not open the status panel.');
			return;
		}

		await leaf.setViewState({ type: SYNC_PANEL_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	// Every status change and every state refresh redraws the panel. It is the
	// only view that has to keep up with a background process.
	private refreshPanel(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SyncPanelView) view.render();
		}
	}

	hasCredentials(): boolean {
		const { githubOwner, githubRepo, token } = this.settings;
		return Boolean(githubOwner && githubRepo && token);
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	private setConnectionState(state: ConnectionState): void {
		this.connectionState = state;
		this.refreshSettingsTab();
	}

	/** The settings tab redraws itself when the connection verdict changes. */
	private refreshSettingsTab(): void {
		this.settingsTab?.display();
	}

	/**
	 * One question answered in one request: can we reach this repository right
	 * now. Network, credentials and repository all fail into the same place, so
	 * they are reported together rather than as separate concepts.
	 *
	 * A repository with no commits has no branch to read, which is a success:
	 * there is simply nothing there yet.
	 */
	private async probeConnection(
		credentials: CredentialDraft = this.settings,
	): Promise<{ ok: boolean; message?: string }> {
		if (!credentials.githubOwner || !credentials.githubRepo || !credentials.token) {
			this.setConnectionState('incomplete');
			return { ok: false, message: 'Owner, repository and token are all required.' };
		}

		this.setConnectionState('checking');
		const { GitHubClient } = await import('./github/GitHubClient');
		const client = new GitHubClient(
			credentials.githubOwner.trim(),
			credentials.githubRepo.trim(),
			credentials.token,
			credentials.branch.trim() || 'main',
		);

		try {
			await client.getBranchReferenceOrNull(true);
			this.setConnectionState('healthy');
			return { ok: true };
		} catch (error) {
			console.error('[GitSync]', error);
			this.setConnectionState('failed');
			return { ok: false, message: describeConnectionFailure(error) };
		}
	}

	/**
	 * Save. The credentials are always stored, because losing what someone
	 * typed is worse than storing something that does not work yet. What a
	 * failed check withholds is automatic synchronization, not the settings.
	 */
	private async applyCredentials(draft: CredentialDraft): Promise<void> {
		Object.assign(this.settings, draft);
		await this.persistEverything();

		const probe = await this.probeConnection(draft);
		if (!probe.ok) {
			new Notice(`GitSync: ${probe.message}`, 12000);
			await this.disableSync();
			return;
		}

		await this.runSetupCheck();
	}

	private async setSyncEnabled(enabled: boolean): Promise<void> {
		if (!enabled) {
			this.settings.syncEnabled = false;
			await this.persistEverything();
			this.setStatus('pending', 'Synchronization is off.');
			return;
		}

		// Turning it on is a promise that it will work, so prove it first.
		const probe = await this.probeConnection();
		if (!probe.ok) {
			new Notice(`GitSync: ${probe.message}`, 12000);
			this.settings.syncEnabled = false;
			await this.persistEverything();
			this.setStatus('error', probe.message ?? 'Not connected.');
			return;
		}

		this.settings.syncEnabled = true;
		await this.persistEverything();

		if (this.syncManager.needsStartingPoint()) {
			await this.runSetupCheck();
		}
	}

	/** Clears credentials and all synchronization bookkeeping. Files are kept. */
	private async resetEverything(): Promise<void> {
		this.syncManager?.destroy();

		const deviceId = this.state.deviceId;
		// Mutated rather than replaced: the settings tab and the sync manager
		// both hold this object, and swapping it would leave them reading the
		// values that were just cleared.
		Object.assign(this.settings, freshSettings(), { syncEnabled: false });
		this.state = { ...DEFAULT_STATE, deviceId };
		await this.persistEverything();

		this.restartSyncManager();
		this.setConnectionState('incomplete');
		this.setStatus('pending', 'Reset. Enter your GitHub details to begin.');
		new Notice('GitSync: credentials and settings cleared. Your files were not touched.');
	}

	// Runs the comparison and puts the outcome to the user. Nothing is written
	// until they answer, and declining leaves synchronization switched off.
	private async runSetupCheck(): Promise<void> {
		if (this.checkRunning) return;
		this.checkRunning = true;
		this.setStatus(
			'syncing',
			'Checking vault and repo. Please do not change files while this runs.',
		);

		let result: SetupCheckResult;
		try {
			let warnedLarge = false;
			result = await this.syncManager.runSetupCheck((progress) => {
				if (progress.totalBytes > LARGE_CHECK_BYTES && !warnedLarge) {
					warnedLarge = true;
					new Notice(
						`GitSync: this vault and repository share ${formatBytes(progress.totalBytes)} of files. ` +
							'The check will take a while. You can leave it running.',
						10000,
					);
				}
				if (progress.total > 0 && progress.done % 25 === 0) {
					this.setStatus(
						'syncing',
						`Checking vault and repo — ${progress.done} of ${progress.total} file(s). Please do not change files while this runs.`,
					);
				}
			});
		} catch (error) {
			const message = describeConnectionFailure(error);
			console.error('[GitSync]', error);
			new Notice(`GitSync: ${message}`, 12000);
			this.setConnectionState('failed');
			this.setStatus('error', message);
			await this.disableSync();
			return;
		} finally {
			this.checkRunning = false;
		}

		this.setStatus('pending', `Comparison complete: ${summarize(result)}.`);
		new SetupCheckModal(this.app, result, (decision) => {
			void this.applySetupDecision(decision);
		}).open();
	}

	private async applySetupDecision(decision: SetupDecision): Promise<void> {
		if (decision === 'cancel') {
			new Notice('GitSync: left switched off. Turn Sync on to run the check again.');
			await this.disableSync();
			return;
		}

		if (decision === 'pull') {
			await this.syncManager.adoptRemote();
		} else {
			await this.syncManager.adoptLocal();
		}
	}

	private async disableSync(): Promise<void> {
		this.settings.syncEnabled = false;
		await this.persistEverything();
		this.setStatus('pending', 'Synchronization is off.');
	}

	private confirmReset(): void {
		new ConfirmModal(
			this.app,
			'Reset all credentials and plugin settings?',
			'You will need to re-enter the GitHub owner, repository and personal access token. Your notes are not touched and nothing is deleted from GitHub.',
			'Proceed',
			() => {
				void this.resetEverything();
			},
		).open();
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => {
				void this.syncManager.syncNow();
			},
		});
		this.addCommand({
			id: 'open-panel',
			name: 'Open status panel',
			callback: () => {
				void this.revealPanel();
			},
		});
		this.addCommand({
			id: 'show-status',
			name: 'Show status',
			callback: () => this.openStatus(),
		});
		this.addCommand({
			id: 'show-conflicts',
			name: 'Show conflicts',
			callback: () => new ConflictModal(this.app, this.syncManager).open(),
		});
		this.addCommand({
			id: 'open-settings',
			name: 'Open settings',
			callback: () => this.openSettings(),
		});
	}

	/** Opens Obsidian's settings modal straight to this plugin's own tab. */
	private openSettings(): void {
		const setting = (this.app as unknown as SettingsCapableApp).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on('create', (file) => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.handleVaultChange(file)));

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (
					oldPath &&
					!this.syncManager.isSelfWrite(oldPath) &&
					!isIgnoredPath(file.path, this.settings.ignoredPaths)
				) {
					this.syncManager.markUserNamed(file.path);
					this.syncManager.recordRename(oldPath, file.path);
				}
				this.handleVaultChange(file);
				if (oldPath) {
					this.handleVaultPath(oldPath);
				}
			}),
		);
	}

	private registerActivationEvents(): void {
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				void this.syncManager.onActivation();
			}
		});
		this.registerDomEvent(window, 'focus', () => {
			void this.syncManager.onActivation();
		});
	}

	private handleVaultChange(file: TAbstractFile): void {
		this.handleVaultPath(file.path);
	}

	private handleVaultPath(path: string): void {
		if (this.syncManager.isSelfWrite(path)) return;
		if (isIgnoredPath(path, this.settings.ignoredPaths)) return;

		if (matchesExtensions(normalizePath(path), this.settings.pushExtensions)) {
			this.syncManager.markDirty();
		}
	}

	private async loadSettingsAndState(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PersistedData> | null;

		Object.assign(this.settings, freshSettings(), saved?.settings ?? {});
		this.stateStore = new SyncStateStore(this, () => this.settings);

		const rawState = saved?.state;
		if (rawState) {
			this.state = {
				...DEFAULT_STATE,
				...rawState,
				trackedFiles: rawState.trackedFiles ?? {},
				conflicts: rawState.conflicts ?? {},
				lastSyncedTree: rawState.lastSyncedTree ?? {},
				pendingRenames: rawState.pendingRenames ?? {},
			};
		} else {
			this.state = await this.stateStore.load();
		}

		// load() is what mints a device id, so a state written before ids existed
		// has to go back through it.
		if (!this.state.deviceId) {
			this.state = await this.stateStore.load();
		}

		if (!saved?.state) {
			await this.persistEverything();
		}
	}

	async saveSettings(): Promise<void> {
		await this.persistEverything();
		if (this.syncManager) {
			this.syncManager.destroy();
			this.syncManager.startPolling();
		}
	}

	private async persistEverything(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			state: this.state,
		} satisfies PersistedData);
	}

	// Throws away this vault's copy of the synced files and downloads them again.
	// This is the only action in the plugin that destroys local work on purpose,
	// so it is confirmed explicitly and everything it removes goes to .trash.
	async resetSyncState(): Promise<void> {
		const managed = this.managedFiles();
		const confirmed = window.confirm(
			'Reset and re-pull from GitHub?\n\n' +
				`${managed.length} file(s) in this vault will be moved to .trash and downloaded again from GitHub.\n\n` +
				'Any local change that has not been pushed yet will be lost. GitHub itself is not modified.\n\n' +
				'Continue?',
		);
		if (!confirmed) {
			new Notice('GitSync: reset cancelled. Nothing was changed.');
			return;
		}

		this.syncManager?.destroy();
		this.setStatus('syncing', 'Resetting local files...');

		try {
			for (const file of managed) {
				await this.app.vault.trash(file, !this.settings.recycleBin);
			}
		} catch (error) {
			console.error('[GitSync]', error);
			new Notice('GitSync: could not clear local files. Nothing was re-pulled.');
			this.setStatus('error', 'Reset failed while clearing local files.');
			this.restartSyncManager();
			return;
		}

		this.state = {
			...DEFAULT_STATE,
			deviceId: this.state.deviceId || generateDeviceId(),
		};
		await this.persistEverything();
		this.restartSyncManager();
		await this.syncManager.initialPull();
	}

	/** Every vault file the plugin is responsible for, in either direction. */
	private managedFiles(): TFile[] {
		const extensions = Array.from(
			new Set([...this.settings.pullExtensions, ...this.settings.pushExtensions]),
		);
		return this.app.vault.getFiles().filter((file) => {
			const path = normalizePath(file.path);
			return (
				matchesExtensions(path, extensions) &&
				!isIgnoredPath(path, this.settings.ignoredPaths)
			);
		});
	}

	private restartSyncManager(): void {
		this.syncManager = this.createSyncManager();
		this.syncManager.startPolling();
	}

	private updateStateReference(): void {
		this.state = this.syncManager.getState();
		this.refreshPanel();
	}

	private setStatus(status: SyncStatus, detail?: string): void {
		this.currentStatus = status;
		this.currentStatusDetail = detail ?? status;
		this.statusBar?.set(status, detail);
		this.refreshPanel();
	}

	private openStatus(): void {
		const conflicts = Object.keys(this.state.conflicts).length;
		new Notice(
			`GitSync: ${this.currentStatusDetail}${conflicts ? ` Conflicts: ${conflicts}.` : ''}`,
		);
	}
}
