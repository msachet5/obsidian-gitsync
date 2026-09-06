import { TFile, Vault } from 'obsidian';
import { RemoteSnapshot } from '../github/GitHubClient';
import { ConflictRecord, SyncStateData } from '../types';
import { isIgnoredPath } from '../vault/PathFilter';
import { gitBlobSha, sha256 } from '../vault/VaultScanner';

/** Paths that turned out to hold the same bytes on both sides after all. */
export type IdenticalPaths = Map<string, { localHash: string; remoteSha: string }>;

export interface ConflictReport {
	conflicts: ConflictRecord[];
	identical: IdenticalPaths;
}

export class ConflictDetector {
	constructor(
		private vault: Vault,
		private settingsIgnoredPaths: string[],
	) {}

	/**
	 * A path that changed on both sides is only a conflict if the two sides
	 * actually differ. Two devices frequently converge on identical content, and
	 * those paths are reported separately so the caller can record them as
	 * synchronized rather than raising a conflict the user has to resolve.
	 */
	async detect(
		state: SyncStateData,
		remote: RemoteSnapshot,
		localChanged: Iterable<string>,
		remoteChanged: Iterable<string>,
		remoteDeleted: Iterable<string>,
	): Promise<ConflictReport> {
		const conflicts: ConflictRecord[] = [];
		const identical: IdenticalPaths = new Map();
		const remoteChangedPaths = new Set([...remoteChanged, ...remoteDeleted]);

		for (const path of localChanged) {
			if (!remoteChangedPaths.has(path)) continue;
			if (isIgnoredPath(path, this.settingsIgnoredPaths)) continue;

			const file = this.vault.getAbstractFileByPath(path);
			const bytes = file instanceof TFile ? await this.vault.readBinary(file) : null;
			const localHash = bytes ? await sha256(bytes) : null;
			const remoteEntry = remote.entries.get(path);

			if (
				bytes &&
				localHash &&
				remoteEntry &&
				remoteEntry.type === 'blob' &&
				remoteEntry.sha &&
				(await gitBlobSha(bytes)) === remoteEntry.sha
			) {
				identical.set(path, { localHash, remoteSha: remoteEntry.sha });
				continue;
			}

			conflicts.push({
				path,
				detectedAt: new Date().toISOString(),
				localHash,
				remoteSha: remoteEntry?.sha ?? null,
				remoteExists: Boolean(remoteEntry && remoteEntry.type === 'blob'),
				conflictCopyPath: null,
			});
		}

		return { conflicts, identical };
	}
}
