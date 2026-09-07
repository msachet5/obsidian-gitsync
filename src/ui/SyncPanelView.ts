import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { ActivityEntry, ActivityKind, SyncStateData, SyncStatus } from '../types';

export const SYNC_PANEL_VIEW_TYPE = 'gitsync-panel';

/** What the panel needs from the plugin. */
export interface PanelHost {
	getStatus(): { status: SyncStatus; detail?: string };
	getState(): SyncStateData;
	getActivity(): ActivityEntry[];
	openConflicts(): void;
	openSettings(): void;
}

const STATUS_COPY: Record<SyncStatus, { label: string; hint: string }> = {
	setup: { label: 'Not set up', hint: 'No repository connected yet.' },
	off: { label: 'Sync is off', hint: 'Nothing is being sent or received.' },
	synced: { label: 'Up to date', hint: 'Everything here matches GitHub.' },
	pending: { label: 'Waiting to push', hint: 'Local edits are queued for the next push.' },
	syncing: { label: 'Synchronizing', hint: 'Reconciling both sides.' },
	pulling: { label: 'Pulling', hint: 'Bringing down changes from GitHub.' },
	pushing: { label: 'Pushing', hint: 'Sending local changes to GitHub.' },
	conflict: { label: 'Needs attention', hint: 'A file changed in both places.' },
	error: { label: 'Stopped', hint: 'Synchronization hit a problem.' },
};

const ACTIVITY_ICON: Record<ActivityKind, string> = {
	push: '↑',
	pull: '↓',
	merge: '⤭',
	conflict: '⚠',
	error: '✕',
	info: '•',
};

function shortAgo(at: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 5) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	return `${Math.round(hours / 24)}d ago`;
}

interface TimeNode {
	el: HTMLElement;
	at: number | null;
}

export class SyncPanelView extends ItemView {
	// Elements whose text is purely "how long ago", paired with the instant they
	// describe. Elapsed time changes with no event to announce it, but rebuilding
	// the panel once a second to say so would throw away the activity list's
	// scroll position every second. So the timer touches only these, and a full
	// rebuild happens when something actually changes.
	private timeNodes: TimeNode[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private host: PanelHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return SYNC_PANEL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'GitSync';
	}

	getIcon(): string {
		return 'refresh-cw';
	}

	async onOpen(): Promise<void> {
		this.render();
		this.registerInterval(window.setInterval(() => this.tickTimes(), 1000));
	}

	private tickTimes(): void {
		for (const node of this.timeNodes) {
			node.el.setText(node.at === null ? 'never' : shortAgo(node.at));
		}
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('gitsync-panel');
		this.timeNodes = [];

		const { status, detail } = this.host.getStatus();
		const state = this.host.getState();
		const copy = STATUS_COPY[status];

		const card = root.createDiv({ cls: `ghs-card ghs-status ghs-${status}` });
		const heading = card.createDiv({ cls: 'ghs-status-heading' });
		heading.createSpan({ cls: 'ghs-dot' });
		heading.createSpan({ cls: 'ghs-status-label', text: copy.label });

		// Settings belong beside the state they change, not in a row of their
		// own competing with the one action that is ever urgent here.
		const gear = heading.createEl('button', { cls: 'ghs-icon-button' });
		setIcon(gear, 'settings');
		gear.setAttribute('aria-label', 'Open GitSync settings');
		gear.setAttribute('title', 'Open GitSync settings');
		gear.addEventListener('click', () => this.host.openSettings());
		card.createDiv({ cls: 'ghs-status-detail', text: detail || copy.hint });

		const conflictCount = Object.keys(state.conflicts).length;
		const trackedCount = Object.keys(state.trackedFiles).length;

		const facts = root.createDiv({ cls: 'ghs-card ghs-facts' });
		this.timeFact(facts, 'Last pull', state.lastSuccessfulPull);
		this.timeFact(facts, 'Last push', state.lastSuccessfulPush);
		this.fact(facts, 'Files tracked', String(trackedCount));

		// A reset clears the synced commit before re-pulling, and a push can be
		// mid-flight, so "not linked" is momentarily true while the plugin is
		// plainly working. Prompting someone to set up what they are watching run
		// is worse than saying nothing for a few seconds.
		const busy = status === 'syncing' || status === 'pulling' || status === 'pushing';
		if (!state.lastSyncedCommit && !busy) {
			// The whole card is the affordance: this is the one state where there
			// is exactly one useful thing to do, so it opens settings on click.
			const warn = root.createDiv({ cls: 'ghs-card ghs-warn ghs-setup' });
			warn.setAttribute('role', 'button');
			warn.setAttribute('tabindex', '0');
			warn.setAttribute('aria-label', 'Set up GitSync');
			warn.setAttribute('title', 'Set up GitSync');
			warn.createDiv({
				cls: 'ghs-warn-text',
				text: 'Not linked to GitHub yet. Click here to set up GitSync.',
			});

			const openSettings = (): void => this.host.openSettings();
			warn.addEventListener('click', openSettings);
			warn.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					openSettings();
				}
			});
		}

		if (conflictCount) {
			const warn = root.createDiv({ cls: 'ghs-card ghs-warn' });
			warn.createDiv({
				cls: 'ghs-warn-text',
				text: `${conflictCount} file(s) changed in both places and need a decision.`,
			});
			warn.createEl('button', { cls: 'mod-cta ghs-button', text: 'Review conflicts' })
				.addEventListener('click', () => this.host.openConflicts());
		}

		root.createEl('h4', { cls: 'ghs-heading', text: 'Recent activity' });

		const activity = this.host.getActivity();
		if (!activity.length) {
			root.createDiv({ cls: 'ghs-empty', text: 'Nothing yet.' });
			return;
		}

		const list = root.createDiv({ cls: 'ghs-activity' });
		for (const entry of activity) {
			const row = list.createDiv({ cls: `ghs-entry ghs-entry-${entry.kind}` });
			row.createSpan({ cls: 'ghs-entry-icon', text: ACTIVITY_ICON[entry.kind] });
			row.createSpan({ cls: 'ghs-entry-text', text: entry.text });
			this.timeNodes.push({
				el: row.createSpan({ cls: 'ghs-entry-time', text: shortAgo(entry.at) }),
				at: entry.at,
			});
		}
	}

	private fact(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'ghs-fact' });
		row.createSpan({ cls: 'ghs-fact-label', text: label });
		row.createSpan({ cls: 'ghs-fact-value', text: value });
	}

	private timeFact(parent: HTMLElement, label: string, iso: string | null): void {
		const row = parent.createDiv({ cls: 'ghs-fact' });
		row.createSpan({ cls: 'ghs-fact-label', text: label });

		const parsed = iso ? Date.parse(iso) : Number.NaN;
		const at = Number.isNaN(parsed) ? null : parsed;

		this.timeNodes.push({
			el: row.createSpan({
				cls: 'ghs-fact-value',
				text: at === null ? 'never' : shortAgo(at),
			}),
			at,
		});
	}
}
