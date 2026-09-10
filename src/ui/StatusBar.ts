import { Plugin, Workspace } from 'obsidian';
import {
	PushCountdown,
	SyncProgress,
	SyncStatus,
	countdownFraction,
	progressPercent,
} from '../types';

const LABELS: Record<SyncStatus, string> = {
	setup: '⚙ UltiSync setup needed',
	off: '○ UltiSync off',
	synced: '✓ Synced',
	pending: '↑ Pending',
	syncing: '↻ Syncing',
	pulling: '↓ Pulling',
	pushing: '↑ Pushing',
	conflict: '⚠ Conflict',
	error: '✕ UltiSync not working',
};

const PHASE_VERB: Record<SyncProgress['phase'], string> = {
	pull: 'Pulling',
	push: 'Pushing',
};

export class StatusBarController {
	private readonly item: HTMLElement;

	private status: SyncStatus = 'synced';
	private detail: string | undefined;
	private progress: SyncProgress | null = null;
	private countdown: PushCountdown | null = null;

	constructor(
		plugin: Plugin,
		workspace: Workspace,
		onClick: () => void,
		onLayoutReady: () => void,
	) {
		this.item = plugin.addStatusBarItem();
		this.item.addClass('ultisync-status');
		this.item.setAttribute('aria-label', 'UltiSync status');
		this.item.addEventListener('click', onClick);

		// Deliberately not seeded with a status here. Claiming "Synced" before
		// anything has been checked is worse than showing nothing for a moment;
		// the plugin sets the real one as soon as it knows it.
		workspace.onLayoutReady(onLayoutReady);
	}

	set(status: SyncStatus, detail?: string): void {
		this.status = status;
		this.detail = detail;
		this.paint();
	}

	/** The two things that move on their own, repainted without a full redraw. */
	setProgress(progress: SyncProgress | null, countdown: PushCountdown | null): void {
		this.progress = progress;
		this.countdown = countdown;
		this.paint();
	}

	private paint(): void {
		this.item.empty();

		// The ring drains through the delay before a push, so the wait reads as
		// a wait rather than as nothing happening. An edit re-arms the timer and
		// it starts again from full.
		if (this.countdown) {
			const donut = this.item.createSpan({ cls: 'ultisync-donut' });
			donut.style.setProperty('--ultisync-donut', String(countdownFraction(this.countdown)));
			donut.setAttribute(
				'aria-label',
				`Pushing in ${Math.ceil(this.countdown.remaining / 1000)}s`,
			);
		}

		this.item.createSpan({ text: this.label() });
		this.item.setAttribute('title', this.title());
	}

	private label(): string {
		if (!this.progress) return LABELS[this.status];

		const { done, total, phase } = this.progress;
		const arrow = phase === 'pull' ? '↓' : '↑';
		return `${arrow} ${PHASE_VERB[phase]} ${done}/${total}`;
	}

	private title(): string {
		if (this.progress) {
			const { done, total, phase } = this.progress;
			return `${PHASE_VERB[phase]} ${done} of ${total} file(s) — ${progressPercent(this.progress)}%`;
		}
		if (this.countdown) {
			return `Pushing in ${Math.ceil(this.countdown.remaining / 1000)}s. Editing restarts the wait.`;
		}
		return this.detail ?? LABELS[this.status];
	}
}
