import { Plugin, Workspace } from 'obsidian';
import { SyncStatus } from '../types';

const LABELS: Record<SyncStatus, string> = {
	setup: '⚙ GitSync setup needed',
	off: '○ GitSync off',
	synced: '✓ Synced',
	pending: '↑ Pending',
	syncing: '↻ Syncing',
	pulling: '↓ Pulling',
	pushing: '↑ Pushing',
	conflict: '⚠ Conflict',
	error: '✕ GitSync not working',
};

export class StatusBarController {
	private readonly item: HTMLElement;

	constructor(
		plugin: Plugin,
		workspace: Workspace,
		onClick: () => void,
		onLayoutReady: () => void,
	) {
		this.item = plugin.addStatusBarItem();
		this.item.addClass('gitsync-status');
		this.item.setAttribute('aria-label', 'GitSync status');
		this.item.addEventListener('click', onClick);

		// Deliberately not seeded with a status here. Claiming "Synced" before
		// anything has been checked is worse than showing nothing for a moment;
		// the plugin sets the real one as soon as it knows it.
		workspace.onLayoutReady(onLayoutReady);
	}

	set(status: SyncStatus, detail?: string): void {
		this.item.setText(LABELS[status]);
		this.item.setAttribute('title', detail ?? LABELS[status]);
	}
}
