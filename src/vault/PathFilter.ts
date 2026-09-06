/**
 * Obsidian's configuration folder is user-configurable, so its real name is
 * supplied once at load rather than assumed to be `.obsidian`.
 */
let configDir = '.obsidian';

export function setConfigDir(dir: string): void {
	const normalized = normalizePath(dir).trim();
	if (normalized) configDir = normalized;
}

/** Paths the plugin refuses to touch regardless of settings. */
function alwaysIgnoredPrefixes(): string[] {
	return ['.trash', configDir];
}

/** Lowercases an extension and guarantees the leading dot. */
export function normalizeExtension(extension: string): string {
	const value = extension.trim().toLowerCase();
	if (!value) return '';
	return value.startsWith('.') ? value : `.${value}`;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Rejects traversal and empty segments before a remote path reaches the vault. */
export function isSafeVaultPath(path: string): boolean {
	const normalized = normalizePath(path);
	if (
		!normalized ||
		normalized.startsWith('../') ||
		normalized.includes('/../') ||
		normalized === '..'
	) {
		return false;
	}
	return !normalized.split('/').some((part) => part === '');
}

export function isIgnoredPath(path: string, ignoredPaths: string[]): boolean {
	const normalized = normalizePath(path);
	const matches = (candidate: string): boolean =>
		candidate !== '' && (normalized === candidate || normalized.startsWith(`${candidate}/`));

	if (alwaysIgnoredPrefixes().some(matches)) return true;
	return ignoredPaths.some((ignored) => matches(normalizePath(ignored.trim())));
}

// eslint-disable-next-line no-control-regex -- control characters are genuinely illegal in Windows filenames, so matching them is the point
const WINDOWS_ILLEGAL = /[<>:"|?*\x00-\x1f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Whether this platform can actually hold the path. Windows rejects several
 * characters and a handful of device names that GitHub stores happily, so a
 * repository built elsewhere can contain paths this vault cannot write.
 */
export function isWritableOnThisPlatform(path: string, isWindows: boolean): boolean {
	if (!isWindows) return true;
	return !normalizePath(path)
		.split('/')
		.some((part) => WINDOWS_ILLEGAL.test(part) || WINDOWS_RESERVED.test(part));
}

export function matchesExtensions(path: string, extensions: string[]): boolean {
	const normalizedPath = normalizePath(path).toLowerCase();
	const normalizedExtensions = extensions.map(normalizeExtension);
	return normalizedExtensions.some((extension) => normalizedPath.endsWith(extension));
}
