import { App, Modal, Setting } from 'obsidian';

export type StartingPoint = 'local' | 'remote';

/**
 * Asked once per vault. Until it is answered nothing automatic runs, because
 * neither side can be assumed to be the authority.
 */
export class FirstRunModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private repoLabel: string,
		private localFileCount: number,
		private onChoice: (choice: StartingPoint) => void,
		private onDismissed: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText('Which side is the starting point?');

		contentEl.createEl('p', {
			text: `This vault has not been synchronized with ${this.repoLabel} yet. Choose which side to start from. This is asked once, and afterwards the two stay in step on their own.`,
		});

		new Setting(contentEl)
			.setName('Upload this vault')
			.setDesc(
				`Sends this vault's ${this.localFileCount} matching file(s) to GitHub. Nothing on GitHub is deleted, and files that exist only there are downloaded afterwards. Choose this on the device that already has your notes.`,
			)
			.addButton((button) =>
				button
					.setCta()
					.setButtonText('Upload')
					.onClick(() => this.choose('local')),
			);

		new Setting(contentEl)
			.setName('Download from GitHub')
			.setDesc(
				"Replaces this vault's copies with GitHub's. Local files that differ are moved to .trash first, and files that exist only here are left alone. Choose this on a new or empty device.",
			)
			.addButton((button) =>
				button.setButtonText('Download').onClick(() => this.choose('remote')),
			);

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Closing this window leaves synchronization switched off until you choose.',
		});
	}

	private choose(choice: StartingPoint): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onChoice(choice);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onDismissed();
	}
}
