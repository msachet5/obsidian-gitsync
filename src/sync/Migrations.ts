import { DEFAULT_SETTINGS, DEFAULT_STATE } from '../types.ts';
// Interfaces do not exist at runtime, so these are imported as types
// explicitly. That is what lets node --test load this module directly.
import type { UltiSyncSettings, SyncStateData, TrackedFile } from '../types.ts';

/**
 * Bump when the stored shape changes in a way that cannot be absorbed by
 * merging against the defaults, and add a step to `STEPS` describing the
 * change. Adding a field never needs a bump: an absent field takes its default.
 */
export const SCHEMA_VERSION = 1;

const DEBUG_LOG_LIMIT = 200;

export interface MigrationResult {
	settings: UltiSyncSettings;
	state: SyncStateData;
	/** True when what was read differs from what should be stored. */
	changed: boolean;
	notes: string[];
}

/**
 * Rewrites of the stored shape, applied in order for anything older. Version 0
 * is any file written before versioning existed.
 */
const STEPS: { to: number; describe: string; apply: (raw: RawData) => void }[] = [
	{
		to: 1,
		describe: 'adopted a versioned data file',
		// Nothing structural to rewrite. Earlier versions are absorbed by the
		// field-by-field validation below, which is exactly what this step
		// exists to record.
		apply: () => undefined,
	},
];

interface RawData {
	schemaVersion?: unknown;
	settings?: unknown;
	state?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/** Drops entries that are not shaped like tracked files rather than trusting them. */
function trackedFiles(value: unknown): Record<string, TrackedFile> {
	if (!isRecord(value)) return {};
	const out: Record<string, TrackedFile> = {};
	for (const [path, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		if (typeof entry.localHash !== 'string' || typeof entry.remoteSha !== 'string') continue;
		out[path] = {
			localHash: entry.localHash,
			remoteSha: entry.remoteSha,
			...(typeof entry.mtime === 'number' ? { mtime: entry.mtime } : {}),
			...(typeof entry.size === 'number' ? { size: entry.size } : {}),
		};
	}
	return out;
}

function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
	);
}

/**
 * Turns whatever is on disk into something the plugin can run on.
 *
 * Every field is taken only if it is the right shape, so a truncated or
 * hand-edited data file degrades to defaults instead of crashing on load. A
 * setting the plugin no longer has is dropped rather than carried forever, and
 * one it has gained takes its default.
 */
export function migrate(raw: unknown): MigrationResult {
	const notes: string[] = [];
	const data: RawData = isRecord(raw) ? raw : {};

	const storedVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
	for (const step of STEPS) {
		if (storedVersion < step.to) {
			step.apply(data);
			notes.push(`v${step.to}: ${step.describe}`);
		}
	}

	const rawSettings = isRecord(data.settings) ? data.settings : {};
	const settings: UltiSyncSettings = {
		syncEnabled:
			typeof rawSettings.syncEnabled === 'boolean'
				? rawSettings.syncEnabled
				: DEFAULT_SETTINGS.syncEnabled,
		recycleBin:
			typeof rawSettings.recycleBin === 'boolean'
				? rawSettings.recycleBin
				: DEFAULT_SETTINGS.recycleBin,
		githubOwner: typeof rawSettings.githubOwner === 'string' ? rawSettings.githubOwner : '',
		githubRepo: typeof rawSettings.githubRepo === 'string' ? rawSettings.githubRepo : '',
		branch:
			typeof rawSettings.branch === 'string' && rawSettings.branch
				? rawSettings.branch
				: DEFAULT_SETTINGS.branch,
		token: typeof rawSettings.token === 'string' ? rawSettings.token : '',
		pullExtensions: stringArray(rawSettings.pullExtensions, DEFAULT_SETTINGS.pullExtensions),
		pushExtensions: stringArray(rawSettings.pushExtensions, DEFAULT_SETTINGS.pushExtensions),
		ignoredPaths: stringArray(rawSettings.ignoredPaths, DEFAULT_SETTINGS.ignoredPaths),
	};

	const rawState = isRecord(data.state) ? data.state : {};
	const debugLog = stringArray(rawState.debugLog, []);
	const state: SyncStateData = {
		deviceId: typeof rawState.deviceId === 'string' ? rawState.deviceId : '',
		lastSyncedCommit: stringOrNull(rawState.lastSyncedCommit),
		lastRemoteCheck: stringOrNull(rawState.lastRemoteCheck),
		lastSuccessfulPull: stringOrNull(rawState.lastSuccessfulPull),
		lastSuccessfulPush: stringOrNull(rawState.lastSuccessfulPush),
		trackedFiles: trackedFiles(rawState.trackedFiles),
		conflicts: isRecord(rawState.conflicts)
			? (rawState.conflicts as SyncStateData['conflicts'])
			: {},
		lastSyncedTree: stringMap(rawState.lastSyncedTree),
		pendingRenames: stringMap(rawState.pendingRenames),
		// Trimmed on the way in, so a file that grew while an older build was
		// running does not stay oversized forever.
		debugLog: debugLog.slice(-DEBUG_LOG_LIMIT),
	};

	if (!state.lastSyncedCommit) {
		// Without a synced commit the recorded tree describes nothing, and
		// keeping it would make every path in it look deleted.
		state.lastSyncedTree = {};
	}

	const changed =
		storedVersion !== SCHEMA_VERSION ||
		debugLog.length !== state.debugLog.length ||
		!isRecord(data.settings) ||
		!isRecord(data.state);

	return { settings, state, changed, notes };
}

/** What DEFAULT_STATE looks like once versioned, for a first run. */
export function freshState(): SyncStateData {
	return { ...DEFAULT_STATE, trackedFiles: {}, conflicts: {}, lastSyncedTree: {}, pendingRenames: {}, debugLog: [] };
}
