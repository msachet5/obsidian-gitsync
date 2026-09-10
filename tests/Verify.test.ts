import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { pathsNeverPulled } from '../src/sync/Verify.ts';
import { setConfigDir } from '../src/vault/PathFilter.ts';
import type { TrackedFile } from '../src/types.ts';

// onload does this before anything runs; without it the config folder is not
// among the always-ignored prefixes and the plugin's own files look pullable.
setConfigDir('.obsidian');

const PULL = ['.md', '.canvas', '.png'];

function tracked(...paths: string[]): Record<string, TrackedFile> {
	return Object.fromEntries(paths.map((path) => [path, { localHash: 'h', remoteSha: 's' }]));
}

function input(over: Partial<Parameters<typeof pathsNeverPulled>[0]> = {}) {
	return {
		tree: {},
		tracked: {},
		pullExtensions: PULL,
		ignoredPaths: [],
		isWindows: false,
		onDisk: () => false,
		...over,
	};
}

describe('pathsNeverPulled', () => {
	// The case this exists for. A vault that started with "Upload this vault"
	// records the whole remote tree as synced without downloading any of it, so
	// the files only GitHub had are absent with nothing tracking them — and the
	// commit pointer says the two sides agree.
	it('finds files the recorded tree holds that never arrived', () => {
		const missing = pathsNeverPulled(
			input({
				tree: { 'a.md': 's1', 'Applications/b.md': 's2', 'c.md': 's3' },
				tracked: tracked('c.md'),
				onDisk: (path) => path === 'c.md',
			}),
		);
		assert.deepEqual(missing, ['a.md', 'Applications/b.md']);
	});

	it('says nothing when the vault holds everything', () => {
		const missing = pathsNeverPulled(
			input({
				tree: { 'a.md': 's1', 'b.md': 's2' },
				tracked: tracked('a.md', 'b.md'),
				onDisk: () => true,
			}),
		);
		assert.deepEqual(missing, []);
	});

	// The dangerous false positive: a deletion on its way to GitHub looks
	// exactly like a file that never arrived, apart from the tracking record.
	it('leaves a deleted file deleted rather than downloading it again', () => {
		const missing = pathsNeverPulled(
			input({
				tree: { 'gone.md': 's1' },
				tracked: tracked('gone.md'),
				onDisk: () => false,
			}),
		);
		assert.deepEqual(missing, []);
	});

	it('ignores what the pull would refuse to fetch anyway', () => {
		const missing = pathsNeverPulled(
			input({
				tree: {
					'notes.md': 's1',
					'paper.pdf': 's2',
					'Private/secret.md': 's3',
					'.obsidian/plugins/x/README.md': 's4',
				},
				ignoredPaths: ['Private'],
			}),
		);
		assert.deepEqual(missing, ['notes.md']);
	});

	it('reports nothing on an empty tree', () => {
		assert.deepEqual(pathsNeverPulled(input()), []);
	});
});
