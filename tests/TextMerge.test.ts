import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { merge3 } from '../src/sync/TextMerge.ts';

const lines = (...values: string[]): string => values.join('\n');

describe('merge3', () => {
	it('returns either side when both made the same edit', () => {
		assert.deepEqual(merge3('a', 'b', 'b'), { merged: 'b', clean: true });
	});

	it('takes the other side when only it changed', () => {
		assert.deepEqual(merge3('a', 'a', 'b'), { merged: 'b', clean: true });
		assert.deepEqual(merge3('a', 'b', 'a'), { merged: 'b', clean: true });
	});

	it('combines edits made in different regions', () => {
		const base = lines('one', 'two', 'three', 'four', 'five');
		const ours = lines('ONE', 'two', 'three', 'four', 'five');
		const theirs = lines('one', 'two', 'three', 'four', 'FIVE');
		assert.deepEqual(merge3(base, ours, theirs), {
			merged: lines('ONE', 'two', 'three', 'four', 'FIVE'),
			clean: true,
		});
	});

	it('keeps insertions from both sides', () => {
		const base = lines('a', 'b', 'c');
		const ours = lines('a', 'inserted', 'b', 'c');
		const theirs = lines('a', 'b', 'c', 'appended');
		const result = merge3(base, ours, theirs);
		assert.equal(result?.clean, true);
		assert.equal(result?.merged, lines('a', 'inserted', 'b', 'c', 'appended'));
	});

	it('refuses when both sides rewrote the same line differently', () => {
		const base = lines('a', 'target', 'c');
		assert.equal(merge3(base, lines('a', 'ours', 'c'), lines('a', 'theirs', 'c')), null);
	});

	it('accepts an identical rewrite of the same region', () => {
		const base = lines('a', 'target', 'c');
		const edited = lines('a', 'same', 'c');
		assert.deepEqual(merge3(base, edited, edited), { merged: edited, clean: true });
	});

	it('treats two insertions at the same point as a conflict', () => {
		const base = lines('a', 'b');
		assert.equal(merge3(base, lines('a', 'ours', 'b'), lines('a', 'theirs', 'b')), null);
	});

	it('merges deletions made on one side only', () => {
		const base = lines('a', 'b', 'c', 'd');
		const result = merge3(base, lines('a', 'c', 'd'), base);
		assert.equal(result?.merged, lines('a', 'c', 'd'));
	});

	it('declines rather than stalling when alignment would be enormous', () => {
		const big = (token: string): string =>
			Array.from({ length: 2100 }, (_, i) => `${token}${i}`).join('\n');
		assert.equal(merge3(big('base'), big('ours'), big('theirs')), null);
	});

	it('preserves trailing content after the last change', () => {
		const base = lines('head', 'body', 'tail');
		const result = merge3(base, lines('HEAD', 'body', 'tail'), base);
		assert.equal(result?.merged, lines('HEAD', 'body', 'tail'));
	});
});
