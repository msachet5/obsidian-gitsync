import { Plugin } from 'obsidian';
import { devicePlatform } from '../platform';
import { GitSyncSettings, PersistedData, SyncStateData } from '../types';
import { SCHEMA_VERSION, migrate } from './Migrations';

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
		const { state } = migrate(await this.plugin.loadData());
		if (!state.deviceId) {
			state.deviceId = generateDeviceId();
			await this.save(state);
		}
		return state;
	}

	async save(state: SyncStateData): Promise<void> {
		await this.plugin.saveData({
			schemaVersion: SCHEMA_VERSION,
			settings: this.getSettings(),
			state,
		} satisfies PersistedData);
	}
}
