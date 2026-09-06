import { normalizeExtension } from './VaultScanner';

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

export function matchesExtensions(path: string, extensions: string[]): boolean {
	const normalizedPath = normalizePath(path).toLowerCase();
	const normalizedExtensions = extensions.map(normalizeExtension);
	return normalizedExtensions.some((extension) => normalizedPath.endsWith(extension));
}
