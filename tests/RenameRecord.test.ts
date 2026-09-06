import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { formatRenameLine, renamesDeclaredIn } from '../src/sync/RenameRecord.ts';

const commit = (...lines: string[]) => ({ message: lines.join('\n') });

describe('rename declarations', () => {
	it('round-trips through a commit message', () => {
		const message = commit('Sync from desktop', formatRenameLine([['old.md', 'new.md']]));
		assert.deepEqual([...renamesDeclaredIn([message])], [['old.md', 'new.md']]);
	});

	it('collapses a chain to original and final path', () => {
		const commits = [
			commit(formatRenameLine([['a.md', 'b.md']])),
			commit(formatRenameLine([['b.md', 'c.md']])),
		];
		assert.deepEqual([...renamesDeclaredIn(commits)], [['a.md', 'c.md']]);
	});

	it('drops a file renamed back to where it started', () => {
		const commits = [
			commit(formatRenameLine([['a.md', 'b.md']])),
			commit(formatRenameLine([['b.md', 'a.md']])),
		];
		assert.equal(renamesDeclaredIn(commits).size, 0);
	});

	it('ignores commits with no declaration', () => {
		assert.equal(renamesDeclaredIn([commit('Sync from mobile at 2026-01-01 00:00:00')]).size, 0);
	});

	it('rejects malformed payloads instead of throwing', () => {
		for (const line of [
			'Renamed: not json',
			'Renamed: {"a":"b"}',
			'Renamed: [["only-one"]]',
			'Renamed: [["a.md","a.md"]]',
			'Renamed: [["",""]]',
			'Renamed: [[1,2]]',
		]) {
			assert.equal(renamesDeclaredIn([commit(line)]).size, 0, `expected ${line} ignored`);
		}
	});

	it('reads several declarations across one message', () => {
		const message = commit(
			'Sync from desktop',
			formatRenameLine([
				['a.md', 'b.md'],
				['c.md', 'd.md'],
			]),
		);
		assert.equal(renamesDeclaredIn([message]).size, 2);
	});
});
