import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { SyncManager } from './sync/SyncManager';
import { SyncStateStore, generateDeviceId } from './sync/SyncState';
import { ConflictModal } from './ui/ConflictModal';
import { FirstRunModal } from './ui/FirstRunModal';
import { SettingsTab } from './ui/SettingsTab';
import { StatusBarController } from './ui/StatusBar';
import { SYNC_PANEL_VIEW_TYPE, SyncPanelView } from './ui/SyncPanelView';
import {
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
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
interface SettingsCapableApp {
	setting?: {
		open(): void;
		openTabById(id: string): void;
	};
}

export default class GitSyncPlugin extends Plugin {
	settings: GitSyncSettings = { ...DEFAULT_SETTINGS };

	private state!: SyncStateData;
	private stateStore!: SyncStateStore;
	private syncManager!: SyncManager;
	private statusBar!: StatusBarController;

	private currentStatus: SyncStatus = 'synced';
	private currentStatusDetail = 'Ready';

	// Set while the question is on screen or its answer is still being carried
	// out. Both states must suppress a second prompt: the first would open two
	// modals, the second would start two adoptions over the same files.
	private startingPointPending = false;

	async onload(): Promise<void> {
		setConfigDir(this.app.vault.configDir);
		await this.loadSettingsAndState();

		this.statusBar = new StatusBarController(this, this.app.workspace, () =>
			this.openStatus(),
		);
		this.syncManager = this.createSyncManager();

		this.addSettingTab(
			new SettingsTab(
				this.app,
				{
					settings: this.settings,
					saveSettings: () => this.saveSettings(),
					testConnection: () => this.testConnection(),
					pushNow: () => this.syncManager.pushEverything(),
					resetSyncState: () => this.resetSyncState(),
					getDeviceId: () => this.state.deviceId,
					getStatus: () => this.statusSnapshot(),
				},
				this,
			),
		);

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
				if (this.promptForStartingPointIfNeeded()) return;
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

	// Asked once per vault, and only when there is something to ask about: the
	// repository has to be configured and no starting commit recorded yet.
	// Returns true when the question was put, so callers can hold off on doing
	// anything else.
	private promptForStartingPointIfNeeded(): boolean {
		if (this.startingPointPending) return true;
		if (!this.syncManager.needsStartingPoint()) return false;

		const configured =
			this.settings.githubOwner && this.settings.githubRepo && this.settings.token;
		if (!configured) return false;

		this.startingPointPending = true;
		this.setStatus('pending', 'Waiting for a starting point.');

		new FirstRunModal(
			this.app,
			`${this.settings.githubOwner}/${this.settings.githubRepo}`,
			this.managedFiles().length,
			(choice) => {
				const adoption =
					choice === 'local'
						? this.syncManager.adoptLocal()
						: this.syncManager.adoptRemote();
				void adoption.finally(() => {
					this.startingPointPending = false;
				});
			},
			() => {
				this.startingPointPending = false;
				this.setStatus('pending', 'No starting point chosen yet.');
			},
		).open();

		return true;
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

		this.settings = { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) };
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
			this.promptForStartingPointIfNeeded();
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
				await this.app.vault.trash(file, false);
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

	async testConnection(): Promise<void> {
		const { GitHubClient } = await import('./github/GitHubClient');
		try {
			const client = new GitHubClient(
				this.settings.githubOwner.trim(),
				this.settings.githubRepo.trim(),
				this.settings.token,
				this.settings.branch.trim() || 'main',
			);
			const ref = await client.testConnection();
			new Notice(`GitSync: connected. ${ref.ref} → ${ref.object.sha.slice(0, 12)}`);
			this.setStatus('synced', 'GitHub connection successful.');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Connection test failed.';
			console.error('[GitSync]', error);
			new Notice(`GitSync: ${message}`);
			this.setStatus('error', message);
		}
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
