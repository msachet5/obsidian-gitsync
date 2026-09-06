import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
	GitSyncSettings,
	PUSH_DELAY_SECONDS,
	SUPPORTED_EXTENSIONS,
	SyncStatus,
} from '../types';
import { normalizeExtension, normalizePath } from '../vault/PathFilter';

/** What the settings tab needs from the plugin, kept narrow deliberately. */
export interface SettingsHost {
	settings: GitSyncSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	pushNow(): Promise<void>;
	resetSyncState(): Promise<void>;
	getDeviceId(): string;
	getStatus(): { status: SyncStatus; detail?: string };
}

export class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private host: SettingsHost,
		plugin: Plugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'Settings and synchronization state are local to this installation.',
		});

		new Setting(containerEl).setName('GitHub').setHeading();

		new Setting(containerEl)
			.setName('GitHub owner')
			.setDesc('GitHub account or organization that owns the repository.')
			.addText((text) =>
				text
					.setPlaceholder('Your GitHub Username')
					.setValue(this.host.settings.githubOwner)
					.onChange(async (value) => {
						this.host.settings.githubOwner = value.trim();
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('GitHub repository')
			.setDesc('Repository name without .git.')
			.addText((text) =>
				text
					.setPlaceholder('my-obsidian-vault')
					.setValue(this.host.settings.githubRepo)
					.onChange(async (value) => {
						this.host.settings.githubRepo = value.trim();
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Branch')
			.setDesc('The single synchronization branch. Defaults to main.')
			.addText((text) =>
				text.setValue(this.host.settings.branch).onChange(async (value) => {
					this.host.settings.branch = value.trim() || 'main';
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Personal access token')
			.setDesc(
				'Fine-grained token limited to this repository with Contents read/write permission. The token is never logged.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('github_pat_...')
					.setValue(this.host.settings.token)
					.onChange(async (value) => {
						this.host.settings.token = value;
						await this.host.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Checks authentication, repository access and the configured branch.')
			.addButton((button) =>
				button.setButtonText('Test connection').onClick(async () => {
					await this.host.testConnection();
				}),
			);

		new Setting(containerEl).setName('Synchronization').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: `Always on, and identical on every device, so a phone and a desktop never drift into different sync behavior. A push goes out ${PUSH_DELAY_SECONDS} seconds after your last edit. GitHub is checked every five seconds while Obsidian is open and visible, and again as soon as it comes back to the foreground. After every push, ten seconds pass before anything automatic runs again, so an edit made mid-push is sent by a second push rather than racing the first.`,
		});

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

		new Setting(containerEl).setName('Actions').setHeading();
		new Setting(containerEl)
			.setName('Push')
			.setDesc(
				'Sends everything in this vault to GitHub now, without waiting for the timer: new files, edits, renames and deletions. A large batch of deletions is confirmed first. Pulling happens on its own.',
			)
			.addButton((button) =>
				button
					.setCta()
					.setButtonText('Push')
					.onClick(() => {
						void this.host.pushNow();
					}),
			);

		new Setting(containerEl)
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
