import { Plugin } from 'obsidian';
import {
	DEFAULT_STATE,
	GitSyncSettings,
	PersistedData,
	SyncStateData,
	devicePlatform,
} from '../types';

/** A short, locally generated id. Never derived from hardware identifiers. */
export function generateDeviceId(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const suffix = Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `${devicePlatform()}-${suffix}`;
}

export class SyncStateStore {
	constructor(
		private plugin: Plugin,
		private getSettings: () => GitSyncSettings,
	) {}

	async load(): Promise<SyncStateData> {
		const stored = (await this.plugin.loadData()) as Partial<PersistedData> | null;
		const state = stored?.state;
		const merged: SyncStateData = {
			...DEFAULT_STATE,
			...(state ?? {}),
			trackedFiles: state?.trackedFiles ?? {},
			conflicts: state?.conflicts ?? {},
			// Absent on state written before the tree snapshot existed. An empty map
			// is the safe reading: no path was in it, so nothing looks deleted, and
			// the first pull records the real tree.
			lastSyncedTree: state?.lastSyncedTree ?? {},
			pendingRenames: state?.pendingRenames ?? {},
		};

		if (!merged.deviceId) {
			merged.deviceId = generateDeviceId();
			await this.save(merged);
		}
		return merged;
	}

	async save(state: SyncStateData): Promise<void> {
		await this.plugin.saveData({
			settings: this.getSettings(),
			state,
		} satisfies PersistedData);
	}
}
