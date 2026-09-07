import { App, Modal, Setting } from 'obsidian';
import { SyncManager } from '../sync/SyncManager';

export class ConflictModal extends Modal {
	constructor(
		app: App,
		private syncManager: SyncManager,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Sync conflicts');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Redrawn after each resolution, so the list shrinks as conflicts clear. */
	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const conflicts = Object.values(this.syncManager.getState().conflicts);
		if (conflicts.length === 0) {
			contentEl.createEl('p', { text: 'No unresolved conflicts.' });
			return;
		}

		contentEl.createEl('p', {
			text: 'The plugin has preserved the local version and created a remote conflict copy where possible. Nothing was silently overwritten.',
		});

		for (const conflict of conflicts) {
			const container = contentEl.createDiv('ultisync-conflict');
			container.createDiv({ cls: 'ultisync-conflict-path', text: conflict.path });
			container.createEl('small', {
				text: conflict.remoteExists
					? `Remote version: ${conflict.remoteSha ?? 'unknown'}`
					: 'Remote version was deleted.',
			});

			if (conflict.conflictCopyPath) {
				container.createEl('p', { text: `Remote copy: ${conflict.conflictCopyPath}` });
			}

			new Setting(container)
				.addButton((button) =>
					button.setButtonText('Keep local').onClick(async () => {
						await this.syncManager.keepLocal(conflict.path);
						this.render();
					}),
				)
				.addButton((button) =>
					button.setButtonText('Keep remote').onClick(async () => {
						await this.syncManager.keepRemote(conflict.path);
						this.render();
					}),
				)
				.addButton((button) =>
					button.setButtonText('Clear').onClick(async () => {
						await this.syncManager.clearConflict(conflict.path);
						this.render();
					}),
				);
		}
	}
}
