/**
 * Renames are recorded in the commit message rather than inferred, because a
 * rename reaches the other device as one path vanishing and another appearing.
 * The declaration lets the receiver move the file instead of deleting and
 * re-downloading identical content.
 */

const PREFIX = 'Renamed: ';

export type RenamePair = [from: string, to: string];

export function formatRenameLine(pairs: RenamePair[]): string {
	return `${PREFIX}${JSON.stringify(pairs)}`;
}

/**
 * Every rename declared across a range of commits, collapsed so that a file
 * renamed more than once maps from its original path straight to its final
 * one, and a file renamed back to where it started drops out entirely.
 */
export function renamesDeclaredIn(commits: { message: string }[]): Map<string, string> {
	const renames = new Map<string, string>();

	for (const commit of commits) {
		for (const line of commit.message.split('\n')) {
			if (!line.startsWith(PREFIX)) continue;

			for (const [from, to] of parseRenameLine(line)) {
				const origin = [...renames].find(([, current]) => current === from)?.[0];
				if (origin) {
					if (origin === to) renames.delete(origin);
					else renames.set(origin, to);
					continue;
				}
				renames.set(from, to);
			}
		}
	}

	return renames;
}

/** Commit messages are untrusted input, so a malformed line yields nothing. */
function parseRenameLine(line: string): RenamePair[] {
	try {
		const parsed: unknown = JSON.parse(line.slice(PREFIX.length));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(pair): pair is RenamePair =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				typeof pair[0] === 'string' &&
				typeof pair[1] === 'string' &&
				pair[0].length > 0 &&
				pair[1].length > 0 &&
				pair[0] !== pair[1],
		);
	} catch {
		return [];
	}
}
