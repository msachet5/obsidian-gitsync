import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
	title: string;
	/** Rendered one paragraph per entry. */
	body: string | string[];
	/** Paths or names the question is about, rendered as a list under the body. */
	list?: string[];
	confirmLabel: string;
	/** Styles the confirm button as destructive. On by default, because every
	 *  question this modal asks is about losing something. */
	destructive?: boolean;
}

/** How many list entries are shown before the rest are summarised. */
const LIST_SHOWN = 12;

/**
 * A plain two-choice question. Closing without choosing counts as cancel, so a
 * caller waiting on the answer is never left waiting: every way out of the
 * modal reports exactly once.
 */
export class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private options: ConfirmOptions,
		private onChoice: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, options } = this;
		contentEl.empty();
		this.titleEl.setText(options.title);

		for (const paragraph of Array.isArray(options.body) ? options.body : [options.body]) {
			contentEl.createEl('p', { text: paragraph });
		}

		if (options.list?.length) this.renderList(options.list);

		new Setting(contentEl)
			.addButton((button) => {
				button.setButtonText(options.confirmLabel).onClick(() => this.answer(true));
				// setDestructive would be the modern spelling, but it needs 1.13
				// and this plugin still supports 1.7.2.
				if (options.destructive ?? true) button.setWarning();
				else button.setCta();
			})
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.answer(false)));
	}

	private renderList(paths: string[]): void {
		const list = this.contentEl.createEl('ul', { cls: 'ultisync-confirm-list' });
		for (const path of paths.slice(0, LIST_SHOWN)) {
			list.createEl('li', { text: path });
		}
		if (paths.length > LIST_SHOWN) {
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: `...and ${paths.length - LIST_SHOWN} more.`,
			});
		}
	}

	private answer(confirmed: boolean): void {
		if (this.answered) return;
		this.answered = true;
		this.close();
		this.onChoice(confirmed);
	}

	onClose(): void {
		this.contentEl.empty();
		// Escape and the close button never reach answer(), and a caller
		// awaiting the reply would wait forever.
		if (!this.answered) {
			this.answered = true;
			this.onChoice(false);
		}
	}
}

/** The same question as a promise, for the callers that await the answer. */
export function confirmWithModal(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, options, resolve).open();
	});
}
