import { App, ButtonComponent, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import {
	ConnectionState,
	GitSyncSettings,
	PUSH_DELAY_SECONDS,
	SUPPORTED_EXTENSIONS,
	SyncStatus,
} from '../types';
import { normalizeExtension, normalizePath } from '../vault/PathFilter';

/** The credential fields, which are edited as a draft and applied by Save. */
export type CredentialDraft = Pick<
	GitSyncSettings,
	'githubOwner' | 'githubRepo' | 'branch' | 'token'
>;

/** What the settings tab needs from the plugin, kept narrow deliberately. */
export interface SettingsHost {
	settings: GitSyncSettings;
	saveSettings(): Promise<void>;
	/** Persists the credentials, then runs the setup check against the repo. */
	applyCredentials(draft: CredentialDraft): Promise<void>;
	/** Turning this on re-runs the setup check. */
	setSyncEnabled(enabled: boolean): Promise<void>;
	hasCredentials(): boolean;
	getConnectionState(): ConnectionState;
	/** Asks before clearing credentials and sync bookkeeping. */
	confirmReset(): void;
	pushNow(): Promise<void>;
	resetSyncState(): Promise<void>;
	getDeviceId(): string;
	getStatus(): { status: SyncStatus; detail?: string };
}

const PAT_STEPS = [
	'Open GitHub and click your profile picture, then Settings. Scroll to the bottom of the left-hand menu for Developer settings.',
	'Under Personal access tokens, choose Fine-grained tokens.',
	'Click Generate new token. Give it a name you will recognise later. The description is optional.',
	'Set the expiry. "No expiration" keeps it working indefinitely; a shorter one is fine for testing, and you can always generate a new token afterwards.',
	'Under Repository access, choose Only select repositories and pick the repository you are syncing to. Do not grant access to all repositories.',
	'Open Repository permissions, find Contents, and set it to Read and write. Nothing else is needed.',
	'Click Generate token, then copy the token. GitHub shows it only once.',
	'Paste it into the field above and click Save.',
];

export class SettingsTab extends PluginSettingTab {
	private draft: CredentialDraft;
	private saving = false;

	// Held so the button can be updated through its own API. Obsidian's
	// setDisabled also toggles a class that blocks pointer events, so reaching
	// past the component and clearing the disabled property alone leaves a
	// button that looks enabled and cannot be clicked.
	private saveButton: ButtonComponent | null = null;

	constructor(
		app: App,
		private host: SettingsHost,
		plugin: Plugin,
	) {
		super(app, plugin);
		this.draft = this.draftFromSettings();
	}

	private draftFromSettings(): CredentialDraft {
		const { githubOwner, githubRepo, branch, token } = this.host.settings;
		return { githubOwner, githubRepo, branch, token };
	}

	private allFieldsFilled(): boolean {
		return Boolean(this.draft.githubOwner && this.draft.githubRepo && this.draft.token);
	}

	private isDirty(): boolean {
		const saved = this.draftFromSettings();
		return (
			saved.githubOwner !== this.draft.githubOwner ||
			saved.githubRepo !== this.draft.githubRepo ||
			saved.branch !== this.draft.branch ||
			saved.token !== this.draft.token
		);
	}

	private renderHeader(containerEl: HTMLElement): void {
		const header = containerEl.createDiv({ cls: 'gitsync-header' });

		const state = this.host.getConnectionState();
		const copy: Record<ConnectionState, { text: string; tone: string }> = {
			healthy: { text: 'Connection healthy', tone: 'green' },
			checking: { text: 'Checking connection…', tone: 'orange' },
			incomplete: { text: 'Complete setup', tone: 'orange' },
			failed: { text: 'Not connected', tone: 'red' },
		};
		const { text, tone } = copy[state];

		const status = header.createDiv({ cls: 'gitsync-conn' });
		status.createSpan({ cls: `gitsync-dot gitsync-dot-${tone}` });
		status.createSpan({ text });

		const reset = header.createEl('button', { cls: 'gitsync-reset' });
		setIcon(reset, 'rotate-ccw');
		reset.setAttribute('aria-label', 'Reset all credentials and plugin settings');
		reset.setAttribute('title', 'Reset all credentials and plugin settings');
		reset.addEventListener('click', () => this.host.confirmReset());
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.saveButton = null;
		this.draft = this.saving ? this.draft : this.draftFromSettings();

		this.renderHeader(containerEl);

		containerEl.createEl('p', {
			text: 'Settings and synchronization state are local to this installation.',
		});

		// Two engines writing the same files will each see the other's writes as
		// someone else's edits, which is exactly how conflicts are manufactured.
		const caution = containerEl.createDiv({ cls: 'gitsync-caution' });
		caution.createEl('strong', { text: 'One sync engine at a time. ' });
		caution.createSpan({
			text: 'If this vault is also synced by Obsidian Sync, iCloud, Dropbox or OneDrive, the two will overwrite each other and produce conflicts. Turn the others off for this vault.',
		});

		this.renderCredentials(containerEl);

		// Nothing below is meaningful until GitHub is reachable, so it stays
		// visibly out of play rather than silently doing nothing.
		const gated = containerEl.createDiv();
		this.setDimmed(gated, !this.host.hasCredentials());

		this.renderSyncToggle(gated);

		const extensions = gated.createDiv();
		this.setDimmed(extensions, !this.host.settings.syncEnabled);
		this.renderExtensions(extensions);

		this.renderIgnoredPaths(gated);
		this.renderRecycleBin(gated);
		this.renderDangerZone(gated);
		this.renderDevice(containerEl);
	}

	private setDimmed(el: HTMLElement, dimmed: boolean): void {
		el.toggleClass('gitsync-dimmed', dimmed);
		el.setAttribute('aria-disabled', String(dimmed));
	}

	private renderCredentials(parent: HTMLElement): void {
		const containerEl = parent.createDiv({ cls: 'gitsync-box' });
		new Setting(containerEl).setName('GitHub').setHeading();

		new Setting(containerEl)
			.setName('GitHub owner')
			.setDesc('GitHub account or organization that owns the repository.')
			.addText((text) =>
				text
					.setPlaceholder('Your GitHub Username')
					.setValue(this.draft.githubOwner)
					.onChange((value) => {
						this.draft.githubOwner = value.trim();
						this.refreshSaveButton();
					}),
			);

		new Setting(containerEl)
			.setName('GitHub repository')
			.setDesc('Repository name without .git.')
			.addText((text) =>
				text
					.setPlaceholder('my-obsidian-vault')
					.setValue(this.draft.githubRepo)
					.onChange((value) => {
						this.draft.githubRepo = value.trim();
						this.refreshSaveButton();
					}),
			);

		new Setting(containerEl)
			.setName('Branch')
			.setDesc('The single synchronization branch. Defaults to main.')
			.addText((text) =>
				text.setValue(this.draft.branch).onChange((value) => {
					this.draft.branch = value.trim() || 'main';
					this.refreshSaveButton();
				}),
			);

		const token = new Setting(containerEl)
			.setName('Personal access token')
			.setDesc(
				'Fine-grained token limited to this repository with Contents read/write permission. The token is never logged.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('github_pat_...')
					.setValue(this.draft.token)
					.onChange((value) => {
						this.draft.token = value.trim();
						this.refreshSaveButton();
					});
			});
		this.renderTokenHelp(token.descEl);

		new Setting(containerEl)
			.setClass('gitsync-save')
			.setName('Save')
			.setDesc(
				'Stores these details, checks the connection in the background, then compares this vault against the repository.',
			)
			.addButton((button) => {
				this.saveButton = button;
				button.onClick(async () => {
					if (this.saving || !this.allFieldsFilled()) return;
					this.saving = true;
					this.refreshSaveButton();
					try {
						await this.host.applyCredentials({ ...this.draft });
					} finally {
						this.saving = false;
						this.display();
					}
				});
				// One place decides the label, the enabled state and the accent,
				// so the button cannot drift out of step with the fields.
				this.refreshSaveButton();
			});
	}

	/**
	 * Updates only the Save button. A full display() would rebuild the inputs
	 * and steal focus on every keystroke.
	 */
	private refreshSaveButton(): void {
		const button = this.saveButton;
		if (!button) return;

		const filled = this.allFieldsFilled();
		const settled = filled && !this.isDirty() && this.host.hasCredentials();
		const active = !this.saving && filled && !settled;

		button.setButtonText(this.saving ? 'Checking…' : settled ? 'Saved' : 'Save');
		button.setDisabled(!active);
		if (active) button.setCta();
		else button.removeCta();
	}

	private renderTokenHelp(containerEl: HTMLElement): void {
		const details = containerEl.createEl('details', { cls: 'gitsync-help' });
		details.createEl('summary', { text: 'How to get the PAT' });

		const list = details.createEl('ol');
		for (const step of PAT_STEPS) {
			list.createEl('li', { text: step });
		}

		details.createEl('p', {
			cls: 'setting-item-description',
			text: 'The token is stored in this plugin\'s data file inside your vault. Anyone with access to the vault folder can read it, so scope the token to the one repository.',
		});
	}

	private renderSyncToggle(parent: HTMLElement): void {
		const containerEl = parent.createDiv({ cls: 'gitsync-box' });
		new Setting(containerEl).setName('Synchronization').setHeading();

		const sync = new Setting(containerEl)
			.setName('Sync')
			.setDesc(
				'Turning this on compares the vault against the repository and asks how to proceed. It stays off until that question is answered.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.host.settings.syncEnabled).onChange(async (value) => {
					await this.host.setSyncEnabled(value);
					this.display();
				}),
			);

		const details = sync.descEl.createEl('details', { cls: 'gitsync-help' });
		details.createEl('summary', { text: 'How syncing works' });
		details.createEl('p', {
			text: `A push goes out ${PUSH_DELAY_SECONDS} seconds after your last edit, and the timer restarts on every further edit.`,
		});
		details.createEl('p', {
			text: 'GitHub is checked every five seconds while Obsidian is open and visible, and again as soon as it comes back to the foreground. Nothing is checked while the window is hidden.',
		});
		details.createEl('p', {
			text: 'After a push, the plugin asks GitHub whether the new commit has landed and resumes as soon as it says yes, so an edit made during a push is sent by a second push rather than racing the first.',
		});
	}

	private renderExtensions(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Pull extensions').setHeading();
		containerEl.createEl('p', {
			text: this.host.settings.pullExtensions.length
				? 'Selected extensions will be downloaded from GitHub.'
				: 'No extensions selected. Nothing will be downloaded until you choose at least one.',
		});
		this.renderExtensionSelector(containerEl, this.host.settings.pullExtensions, async (value) => {
			this.host.settings.pullExtensions = value;
			await this.host.saveSettings();
		});

		new Setting(containerEl).setName('Push extensions').setHeading();
		containerEl.createEl('p', {
			text: this.host.settings.pushExtensions.length
				? 'Selected extensions may be pushed to GitHub.'
				: 'No extensions selected. Nothing will be pushed automatically.',
		});
		this.renderExtensionSelector(containerEl, this.host.settings.pushExtensions, async (value) => {
			this.host.settings.pushExtensions = value;
			await this.host.saveSettings();
		});
	}

	private renderRecycleBin(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Recycle bin')
			.setDesc(
				"Keeps every deleted or replaced file in the vault's .trash folder. That folder is never synced to GitHub and is never cleaned up, so it grows until you empty it yourself. With this off, deleted files go to your system trash instead.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.host.settings.recycleBin).onChange(async (value) => {
					this.host.settings.recycleBin = value;
					await this.host.saveSettings();
				}),
			);
	}

	private renderIgnoredPaths(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Ignored paths').setHeading();
		new Setting(containerEl)
			.setName('Ignored paths')
			.setDesc('One path or path prefix per line. Example: .obsidian/workspace.json')
			.addTextArea((text) =>
				text
					.setPlaceholder('.obsidian/workspace.json\n.obsidian/workspace-mobile.json')
					.setValue(this.host.settings.ignoredPaths.join('\n'))
					.onChange(async (value) => {
						this.host.settings.ignoredPaths = value
							.split(/\r?\n/)
							.map(normalizePath)
							.map((path) => path.trim())
							.filter(Boolean);
						await this.host.saveSettings();
					}),
			);
	}

	private renderDangerZone(containerEl: HTMLElement): void {
		const zone = containerEl.createDiv({ cls: 'gitsync-danger-zone' });
		new Setting(zone).setName('Danger zone').setHeading();

		new Setting(zone)
			.setName('Push')
			.setDesc(
				'Sends everything in this vault to GitHub now, without waiting for the timer: new files, edits, renames and deletions. A large batch of deletions is confirmed first. Pulling happens on its own.',
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Push')
					.onClick(() => {
						void this.host.pushNow();
					}),
			);

		new Setting(zone)
			.setName('Reset and re-pull from GitHub')
			.setDesc(
				"Discards this vault's synced files and downloads them again from GitHub. Removed files go to the vault's .trash folder. Anything local that was never pushed will be lost. GitHub is not modified.",
			)
			.addButton((button) =>
				button
					.setWarning()
					.setButtonText('Reset and re-pull')
					.onClick(async () => {
						await this.host.resetSyncState();
						this.display();
					}),
			);
	}

	private renderDevice(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Device').setHeading();
		new Setting(containerEl)
			.setName('Device ID')
			.setDesc('Generated locally and never derived from hardware identifiers.')
			.addText((text) => text.setValue(this.host.getDeviceId()).setDisabled(true));

		const status = this.host.getStatus();
		new Setting(containerEl).setName('Current status').setDesc(status.detail ?? status.status);
	}

	private renderExtensionSelector(
		containerEl: HTMLElement,
		selected: string[],
		onChange: (value: string[]) => Promise<void>,
	): void {
		const normalizedSelected = selected.map(normalizeExtension);

		const controls = containerEl.createDiv('gitsync-extension-controls');
		controls.createEl('button', { text: 'Select all' }).addEventListener('click', () => {
			void onChange([...SUPPORTED_EXTENSIONS]);
			this.display();
		});
		controls.createEl('button', { text: 'Clear all' }).addEventListener('click', () => {
			void onChange([]);
			this.display();
		});

		const grid = containerEl.createDiv('gitsync-extension-grid');
		for (const extension of SUPPORTED_EXTENSIONS) {
			const label = grid.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = normalizedSelected.includes(extension);
			label.createSpan({ text: extension });

			input.addEventListener('change', () => {
				const next = new Set(normalizedSelected);
				if (input.checked) next.add(extension);
				else next.delete(extension);
				void onChange([...next]);
			});
		}
	}
}
