import { Platform } from 'obsidian';

/**
 * Coarse platform label used in device ids and commit messages. Obsidian runs
 * on more than macOS and iOS, so this deliberately says only mobile or desktop.
 *
 * Kept out of types.ts so that module stays free of the obsidian import and
 * can be exercised directly by the tests.
 */
export function devicePlatform(): 'mobile' | 'desktop' {
	return Platform.isMobile ? 'mobile' : 'desktop';
}
