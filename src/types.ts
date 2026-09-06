import { Platform } from 'obsidian';

export const PULL_INTERVAL_MS = 5000;
export const POLL_HOLD_AFTER_PUSH_MS = 10000;
export const PUSH_DELAY_SECONDS = 5;
export const ACTIVITY_LIMIT = 30;
export const NEW_FILE_SETTLE_MS = 60000;

/** sha1 of an empty blob, and of an empty tree. Both are fixed Git constants. */
export const EMPTY_BLOB_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** How long a path the plugin just wrote is exempt from looking like a user edit. */
export const SELF_WRITE_GRACE_MS = 2000;

export interface GitSyncSettings {
	/** Master switch. Off until the setup check reaches a conclusion. */
	syncEnabled: boolean;
	/** Keep deleted files in the vault's own .trash instead of the system one. */
	recycleBin: boolean;
	githubOwner: string;
	githubRepo: string;
	branch: string;
	token: string;
	pullExtensions: string[];
	pushExtensions: string[];
	ignoredPaths: string[];
}

/**
 * What the plugin remembers about one synchronized path. `localHash` is the
 * sha-256 of the bytes on disk, `remoteSha` the Git blob sha of the same
 * content on GitHub. `mtime` and `size` are the change detector's fast path.
 */
export interface TrackedFile {
	localHash: string;
	remoteSha: string;
	mtime?: number;
	size?: number;
}

export interface ConflictRecord {
	path: string;
	/** ISO timestamp, so a record survives a reload and still reads sensibly. */
	detectedAt: string;
	localHash: string | null;
	remoteSha: string | null;
	remoteExists: boolean;
	conflictCopyPath: string | null;
}

export interface SyncStateData {
	deviceId: string;
	lastSyncedCommit: string | null;
	lastRemoteCheck: string | null;
	lastSuccessfulPull: string | null;
	lastSuccessfulPush: string | null;
	trackedFiles: Record<string, TrackedFile>;
	conflicts: Record<string, ConflictRecord>;
	/** Every blob path of the tree at `lastSyncedCommit`, mapped to its sha. */
	lastSyncedTree: Record<string, string>;
	/** Old path to new path, for renames made locally but not yet pushed. */
	pendingRenames: Record<string, string>;
	debugLog: string[];
}

/** What the plugin writes to data.json. */
export interface PersistedData {
	settings: GitSyncSettings;
	state: SyncStateData;
}

/** The file types Obsidian itself can open. Nothing outside this list syncs. */
export const SUPPORTED_EXTENSIONS = [
	'.md',
	'.canvas',
	'.base',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.svg',
	'.bmp',
	'.avif',
	'.pdf',
	'.mp3',
	'.wav',
	'.m4a',
	'.ogg',
	'.3gp',
	'.flac',
	'.mp4',
	'.webm',
	'.ogv',
	'.mov',
	'.mkv',
];

/**
 * What a vault syncs before anyone changes anything: notes, the two Obsidian
 * file formats, and the small image types people actually paste into notes.
 *
 * Audio, video and PDF are supported but deliberately left off. They are the
 * file types large enough to run into GitHub's per-blob ceiling and to make a
 * first sync painfully slow, and unlike notes they are rarely the thing
 * someone urgently needs on two devices. They are one checkbox away.
 */
export const DEFAULT_EXTENSIONS = [
	'.md',
	'.canvas',
	'.base',
	'.png',
	'.jpg',
	'.jpeg',
	'.webp',
	'.svg',
];

/** Warn beyond this before hashing, because the check stops feeling instant. */
export const LARGE_CHECK_BYTES = 200 * 1024 * 1024;

export const DEFAULT_SETTINGS: GitSyncSettings = {
	syncEnabled: true,
	recycleBin: false,
	githubOwner: '',
	githubRepo: '',
	branch: 'main',
	token: '',
	pullExtensions: [...DEFAULT_EXTENSIONS],
	pushExtensions: [...DEFAULT_EXTENSIONS],
	ignoredPaths: [],
};

export const DEFAULT_STATE: SyncStateData = {
	deviceId: '',
	lastSyncedCommit: null,
	lastRemoteCheck: null,
	lastSuccessfulPull: null,
	lastSuccessfulPush: null,
	trackedFiles: {},
	conflicts: {},
	lastSyncedTree: {},
	pendingRenames: {},
	debugLog: [],
};


/**
 * Coarse platform label used in device ids and commit messages. Obsidian runs
 * on more than macOS and iOS, so this deliberately says only mobile or desktop.
 */
export function devicePlatform(): 'mobile' | 'desktop' {
	return Platform.isMobile ? 'mobile' : 'desktop';
}

export type SyncStatus =
	| 'pending'
	| 'syncing'
	| 'pulling'
	| 'pushing'
	| 'synced'
	| 'conflict'
	| 'error';

export type ActivityKind = 'info' | 'pull' | 'push' | 'merge' | 'conflict' | 'error';

export interface ActivityEntry {
	at: number;
	kind: ActivityKind;
	text: string;
}

/** Why a push is running. Only "manual" may confirm a bulk deletion, and
 *  "adopt" never deletes at all. */
export type PushTrigger = 'automatic' | 'manual' | 'adopt';
