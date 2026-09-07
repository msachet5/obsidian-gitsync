import { GitHubClient, GitTreeEntry } from '../github/GitHubClient';
import { TrackedFile } from '../types';
import { base64ToArrayBuffer } from '../vault/VaultScanner';
import { merge3 } from './TextMerge';

/**
 * Only line-oriented formats are worth merging. Everything else Obsidian
 * supports is binary, where a three-way merge would corrupt the file.
 */
const MERGEABLE_EXTENSIONS = ['.md'];

export interface MergeOutcome {
	merged: string;
	/** The remote bytes the merge was based on, so the caller can record its sha. */
	theirBytes: ArrayBuffer;
}

/**
 * Attempts to reconcile a file that changed locally and remotely. Returns null
 * whenever the merge is not provably safe, leaving the caller to raise a
 * conflict instead.
 */
export async function attemptMerge(
	github: GitHubClient,
	path: string,
	localBytes: ArrayBuffer,
	tracked: TrackedFile | undefined,
	remoteEntry: GitTreeEntry | undefined,
): Promise<MergeOutcome | null> {
	if (!MERGEABLE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
		return null;
	}
	if (!tracked?.remoteSha || !remoteEntry?.sha) return null;
	if (tracked.remoteSha === remoteEntry.sha) return null;

	try {
		const [baseBlob, theirBlob] = await Promise.all([
			github.getBlob(tracked.remoteSha),
			github.getBlob(remoteEntry.sha),
		]);

		const decoder = new TextDecoder();
		const theirBytes = base64ToArrayBuffer(theirBlob.content);
		const base = decoder.decode(base64ToArrayBuffer(baseBlob.content));
		const theirs = decoder.decode(theirBytes);
		const ours = decoder.decode(localBytes);

		const result = merge3(base, ours, theirs);
		if (!result?.clean) return null;
		return { merged: result.merged, theirBytes };
	} catch (error) {
		console.error('[UltiSync] merge unavailable for', path, error);
		return null;
	}
}
