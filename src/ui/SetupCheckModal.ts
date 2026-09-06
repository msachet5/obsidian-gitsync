import { App, Modal, Setting } from 'obsidian';
import { SetupCheckResult } from '../sync/SetupCheck';

/**
 * What the user decided to do about the difference between vault and repo.
 * "link" records the current position without moving any file.
 */
export type SetupDecision = 'link' | 'pull' | 'push' | 'cancel';

interface Choice {
	title: string;
	body: string;
	/** Buttons other than cancel, in order. The first is the primary action. */
	actions: { label: string; decision: SetupDecision; warn?: boolean }[];
}

function choiceFor(result: SetupCheckResult): Choice {
	const { relation, localOnly, remoteOnly, conflicting } = result;

	switch (relation) {
		case 'up-to-date':
			return {
				title: 'This vault is up to date',
				body: 'Everything here already matches GitHub. Synchronization will start from now on.',
				actions: [{ label: 'Start syncing', decision: 'link' }],
			};

		case 'remote-empty':
			return {
				title: 'The repository is empty',
				body: `Nothing is on GitHub yet, so this vault's ${localOnly.length} file(s) will be uploaded as the starting point.`,
				actions: [{ label: 'Upload and start syncing', decision: 'push' }],
			};

		case 'remote-ahead':
			return {
				title: 'GitHub is ahead',
				body: `GitHub has ${remoteOnly.length} file(s) this vault does not, and nothing here conflicts with them. They can be downloaded without replacing any of your work.`,
				actions: [{ label: 'Proceed', decision: 'pull' }],
			};

		case 'local-ahead':
			return {
				title: 'This vault is ahead',
				body: `This vault has ${localOnly.length} file(s) GitHub does not, and nothing on GitHub conflicts with them. They can be pushed without replacing anything there.`,
				actions: [{ label: 'Push and start syncing', decision: 'push' }],
			};

		case 'both-ahead':
			return {
				title: 'Both sides have new files',
				body: `This vault has ${localOnly.length} file(s) GitHub does not, and GitHub has ${remoteOnly.length} this vault does not. No file differs on both sides, so the two sets can simply be combined.`,
				actions: [{ label: 'Merge and start syncing', decision: 'push' }],
			};

		case 'diverged':
			return {
				title: 'These cannot be merged cleanly',
				body: `${conflicting.length} file(s) exist in both places with different contents. There is no shared history to merge them from, so one side has to be the starting point. The versions that lose are moved to the vault's .trash rather than destroyed.`,
				actions: [
					{ label: 'Upload this vault', decision: 'push', warn: true },
					{ label: 'Download from GitHub', decision: 'pull', warn: true },
				],
			};
	}
}

export class SetupCheckModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private result: SetupCheckResult,
		private onDecision: (decision: SetupDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const choice = choiceFor(this.result);
		this.titleEl.setText(choice.title);
		contentEl.createEl('p', { text: choice.body });

		this.renderFileLists();

		const buttons = new Setting(contentEl);
		for (const [index, action] of choice.actions.entries()) {
			buttons.addButton((button) => {
				button.setButtonText(action.label).onClick(() => this.decide(action.decision));
				if (action.warn) button.setWarning();
				else if (index === 0) button.setCta();
			});
		}
		buttons.addButton((button) =>
			button.setButtonText('Cancel').onClick(() => this.decide('cancel')),
		);

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Cancelling leaves synchronization switched off. Turning Sync back on runs this check again.',
		});
	}

	/** Shows what is actually different, capped so a big difference stays readable. */
	private renderFileLists(): void {
		const groups: [string, string[]][] = [
			['Differ on both sides', this.result.conflicting],
			['Only on GitHub', this.result.remoteOnly],
			['Only in this vault', this.result.localOnly],
		];

		for (const [label, paths] of groups) {
			if (!paths.length) continue;
			const details = this.contentEl.createEl('details', { cls: 'gitsync-file-list' });
			details.createEl('summary', { text: `${label} (${paths.length})` });
			const list = details.createEl('ul');
			for (const path of paths.slice(0, 50)) {
				list.createEl('li', { text: path });
			}
			if (paths.length > 50) {
				list.createEl('li', { text: `...and ${paths.length - 50} more` });
			}
		}
	}

	private decide(decision: SetupDecision): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onDecision(decision);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onDecision('cancel');
		}
	}
}
