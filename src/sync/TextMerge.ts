/**
 * Line-based three-way merge.
 *
 * Both sides are diffed against the common base, and the resulting changed
 * regions are replayed in base order. Non-overlapping regions are taken
 * verbatim from whichever side changed them. Overlapping regions merge only
 * when both sides made the identical edit; anything else returns null, which
 * the caller treats as a conflict rather than guessing at a winner.
 */

interface Region {
	baseStart: number;
	baseEnd: number;
	otherStart: number;
	otherEnd: number;
}

export interface MergeResult {
	merged: string;
	clean: boolean;
}

/**
 * Ceiling on the LCS table. The alignment is O(rows x columns), so two large
 * files that share almost nothing would otherwise stall the app. Past this the
 * merge declines rather than blocking.
 */
const MAX_ALIGNMENT_CELLS = 4_000_000;

export function merge3(base: string, ours: string, theirs: string): MergeResult | null {
	if (ours === theirs) return { merged: ours, clean: true };
	if (base === ours) return { merged: theirs, clean: true };
	if (base === theirs) return { merged: ours, clean: true };

	const baseLines = splitLines(base);
	const ourLines = splitLines(ours);
	const theirLines = splitLines(theirs);

	const ourRegions = diffRegions(baseLines, ourLines);
	const theirRegions = diffRegions(baseLines, theirLines);
	if (!ourRegions || !theirRegions) return null;

	const output: string[] = [];
	let cursor = 0;
	let ourIndex = 0;
	let theirIndex = 0;

	while (ourIndex < ourRegions.length || theirIndex < theirRegions.length) {
		const ourRegion = ourRegions[ourIndex];
		const theirRegion = theirRegions[theirIndex];

		const takeOurs =
			theirRegion === undefined ||
			(ourRegion !== undefined && ourRegion.baseStart <= theirRegion.baseStart);
		const region = takeOurs ? ourRegion : theirRegion;
		if (!region) break;

		const counterpart = takeOurs ? theirRegion : ourRegion;

		// Everything between the last region and this one is unchanged on both sides.
		for (let line = cursor; line < region.baseStart; line++) {
			output.push(baseLines[line] as string);
		}

		if (counterpart === undefined || !regionsCollide(region, counterpart)) {
			const source = takeOurs ? ourLines : theirLines;
			for (let line = region.otherStart; line < region.otherEnd; line++) {
				output.push(source[line] as string);
			}
			cursor = Math.max(cursor, region.baseEnd);
			if (takeOurs) ourIndex++;
			else theirIndex++;
			continue;
		}

		// Both sides rewrote the same span. Identical rewrites collapse to one
		// copy; anything else is a genuine conflict.
		if (!ourRegion || !theirRegion) break;
		const ourText = ourLines.slice(ourRegion.otherStart, ourRegion.otherEnd).join('\n');
		const theirText = theirLines.slice(theirRegion.otherStart, theirRegion.otherEnd).join('\n');
		if (ourText !== theirText) {
			return null;
		}

		output.push(...ourLines.slice(ourRegion.otherStart, ourRegion.otherEnd));
		cursor = Math.max(cursor, ourRegion.baseEnd, theirRegion.baseEnd);
		ourIndex++;
		theirIndex++;
	}

	for (let line = cursor; line < baseLines.length; line++) {
		output.push(baseLines[line] as string);
	}

	return { merged: output.join('\n'), clean: true };
}

function splitLines(value: string): string[] {
	return value.split('\n');
}

function regionsCollide(a: Region, b: Region): boolean {
	// Two insertions at the same point collide even though neither spans lines.
	if (a.baseStart === b.baseStart) return true;
	return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/** The spans where `other` differs from `base`, or null if alignment is too big. */
function diffRegions(base: string[], other: string[]): Region[] | null {
	let start = 0;
	while (start < base.length && start < other.length && base[start] === other[start]) {
		start++;
	}

	let baseEnd = base.length;
	let otherEnd = other.length;
	while (baseEnd > start && otherEnd > start && base[baseEnd - 1] === other[otherEnd - 1]) {
		baseEnd--;
		otherEnd--;
	}

	if (start === baseEnd && start === otherEnd) return [];

	const midBase = base.slice(start, baseEnd);
	const midOther = other.slice(start, otherEnd);
	if (midBase.length * midOther.length > MAX_ALIGNMENT_CELLS) return null;

	return alignedBlocks(midBase, midOther).map((block) => ({
		baseStart: block.baseStart + start,
		baseEnd: block.baseEnd + start,
		otherStart: block.otherStart + start,
		otherEnd: block.otherEnd + start,
	}));
}

/** Longest common subsequence, then the gaps between matches are the changes. */
function alignedBlocks(base: string[], other: string[]): Region[] {
	const rows = base.length;
	const columns = other.length;

	const table: number[][] = Array.from({ length: rows + 1 }, () =>
		new Array<number>(columns + 1).fill(0),
	);

	for (let row = rows - 1; row >= 0; row--) {
		const current = table[row] as number[];
		const next = table[row + 1] as number[];
		const baseLine = base[row];
		for (let column = columns - 1; column >= 0; column--) {
			current[column] =
				baseLine === other[column]
					? (next[column + 1] as number) + 1
					: Math.max(next[column] as number, current[column + 1] as number);
		}
	}

	const matches: [number, number][] = [];
	let row = 0;
	let column = 0;
	while (row < rows && column < columns) {
		if (base[row] === other[column]) {
			matches.push([row, column]);
			row++;
			column++;
		} else if (
			(table[row + 1]?.[column] as number) >= (table[row]?.[column + 1] as number)
		) {
			row++;
		} else {
			column++;
		}
	}

	const regions: Region[] = [];
	let baseCursor = 0;
	let otherCursor = 0;
	for (const [matchedBase, matchedOther] of matches) {
		if (matchedBase > baseCursor || matchedOther > otherCursor) {
			regions.push({
				baseStart: baseCursor,
				baseEnd: matchedBase,
				otherStart: otherCursor,
				otherEnd: matchedOther,
			});
		}
		baseCursor = matchedBase + 1;
		otherCursor = matchedOther + 1;
	}

	if (baseCursor < rows || otherCursor < columns) {
		regions.push({
			baseStart: baseCursor,
			baseEnd: rows,
			otherStart: otherCursor,
			otherEnd: columns,
		});
	}

	return regions;
}
