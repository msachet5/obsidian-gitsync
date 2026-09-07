import { App } from 'obsidian';

/**
 * The id the access token is filed under in Obsidian's secret storage. Stable
 * for the life of the plugin, because changing it would strand the stored value
 * and silently look like a token that had gone missing.
 */
const SECRET_ID = 'ultisync-token';

/** The slice of Obsidian's SecretStorage this plugin uses. */
interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

/**
 * Obsidian gained a first-party secret store in 1.11.4. Reaching it through a
 * narrow cast is what lets `minAppVersion` stay at 1.7.2: on an older build the
 * API is simply absent, and the token stays in `data.json` exactly as it did
 * before. The shape is checked rather than assumed, so a future rename of the
 * API degrades to the old path instead of throwing on load.
 */
function secretStorage(app: App): SecretStorageLike | null {
	// Reached through an untyped view of `app` on purpose. Naming Obsidian's own
	// SecretStorage type here would declare a dependency on 1.11.4 and defeat the
	// fallback: the API is optional at runtime, so it is discovered at runtime.
	const candidate = (app as unknown as Record<string, unknown>).secretStorage;
	if (typeof candidate !== 'object' || candidate === null) return null;

	const store = candidate as Partial<SecretStorageLike>;
	return typeof store.getSecret === 'function' && typeof store.setSecret === 'function'
		? (store as SecretStorageLike)
		: null;
}

/** Whether this Obsidian keeps the token out of the plugin's data file. */
export function usesSecretStorage(app: App): boolean {
	return secretStorage(app) !== null;
}

export interface LoadedToken {
	token: string;
	/** True when the data file still holds a plaintext copy that should go. */
	migrated: boolean;
}

/**
 * The token to run with, preferring the secret store over whatever `data.json`
 * holds. A plaintext token left by an earlier version, or written while running
 * on an older Obsidian, is moved into the store on sight. The caller then
 * persists, and that write is what clears it from the vault file.
 */
export function loadToken(app: App, stored: string): LoadedToken {
	const store = secretStorage(app);
	if (!store) return { token: stored, migrated: false };

	try {
		const secret = store.getSecret(SECRET_ID);
		if (secret) return { token: secret, migrated: stored !== '' };
		if (!stored) return { token: '', migrated: false };
		store.setSecret(SECRET_ID, stored);
		return { token: stored, migrated: true };
	} catch {
		// A store that throws is treated as absent. Losing the token would be a
		// worse outcome than storing it where it already was.
		return { token: stored, migrated: false };
	}
}

/**
 * The settings as they should be written to `data.json`. Where the secret store
 * exists the token goes there instead and the field is left empty, so the file
 * inside the vault never carries the credential.
 */
export function settingsForDisk<T extends { token: string }>(app: App, settings: T): T {
	const store = secretStorage(app);
	if (!store) return settings;

	try {
		store.setSecret(SECRET_ID, settings.token);
		return { ...settings, token: '' };
	} catch {
		return settings;
	}
}
