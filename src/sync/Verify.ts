import type { TrackedFile } from '../types.ts';
import {
	isIgnoredPath,
	isSafeVaultPath,
	isWritableOnThisPlatform,
	matchesExtensions,
} from '../vault/PathFilter.ts';

/**
 * Everything the check needs, passed in rather than reached for, so the rule
 * can be exercised without a vault behind it.
 */
export interface VerifyInput {
	/** The remote tree as last recorded: path to blob sha. */
	tree: Record<string, string>;
	tracked: Record<string, TrackedFile>;
	pullExtensions: string[];
	ignoredPaths: string[];
	isWindows: boolean;
	/** Whether the vault actually holds this path right now. */
	onDisk: (path: string) => boolean;
}

/**
 * Eligible files the recorded remote tree holds that this vault has never had:
 * no tracking record, and nothing on disk.
 *
 * A tracked path with no file is deliberately excluded. That is a local
 * deletion on its way out, and downloading it again would resurrect what
 * somebody deleted. The filters mirror the ones the pull applies, so every path
 * reported here is one the pull can actually fetch — otherwise a file that can
 * never land would be reported missing forever.
 */
export function pathsNeverPulled(input: VerifyInput): string[] {
	const missing: string[] = [];

	for (const path of Object.keys(input.tree)) {
		if (input.tracked[path]) continue;
		if (!matchesExtensions(path, input.pullExtensions)) continue;
		if (isIgnoredPath(path, input.ignoredPaths)) continue;
		if (!isSafeVaultPath(path)) continue;
		if (!isWritableOnThisPlatform(path, input.isWindows)) continue;
		if (input.onDisk(path)) continue;
		missing.push(path);
	}

	return missing;
}
