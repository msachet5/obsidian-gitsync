import { Plugin, Workspace } from 'obsidian';
import { SyncStatus } from '../types';

const LABELS: Record<SyncStatus, string> = {
	synced: '✓ Synced',
	pending: '↑ Pending',
	syncing: '↻ Syncing',
	pulling: '↓ Pulling',
	pushing: '↑ Pushing',
	conflict: '⚠ Conflict',
	error: '✕ Error',
};

export class StatusBarController {
	private readonly item: HTMLElement;

	constructor(plugin: Plugin, workspace: Workspace, onClick: () => void) {
		this.item = plugin.addStatusBarItem();
		this.item.addClass('gitsync-status');
		this.item.setAttribute('aria-label', 'GitSync status');
		this.item.addEventListener('click', onClick);

		workspace.onLayoutReady(() => {
			this.set('synced', 'Ready');
		});
	}

	set(status: SyncStatus, detail?: string): void {
		this.item.setText(LABELS[status]);
		this.item.setAttribute('title', detail ?? LABELS[status]);
	}
}
