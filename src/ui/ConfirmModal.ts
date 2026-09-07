import { App, Modal, Setting } from 'obsidian';

/** A plain two-choice question. Closing without choosing counts as cancel. */
export class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void,
		private destructive = true,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(this.title);
		contentEl.createEl('p', { text: this.body });

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(this.confirmLabel).onClick(() => {
					this.resolved = true;
					this.close();
					this.onConfirm();
				});
				if (this.destructive) button.setWarning();
				else button.setCta();
			})
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolved = false;
	}
}
