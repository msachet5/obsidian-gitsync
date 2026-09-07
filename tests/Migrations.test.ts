import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SCHEMA_VERSION, migrate } from '../src/sync/Migrations.ts';
import { DEFAULT_EXTENSIONS } from '../src/types.ts';

describe('migrate', () => {
	it('returns usable defaults for a missing data file', () => {
		const { settings, state, changed } = migrate(null);
		assert.equal(settings.githubOwner, '');
		assert.deepEqual(settings.pullExtensions, DEFAULT_EXTENSIONS);
		assert.equal(state.lastSyncedCommit, null);
		assert.equal(changed, true);
	});

	it('survives a corrupted file instead of throwing', () => {
		for (const raw of ['nonsense', 42, [], { settings: 'no' }, { state: 7 }]) {
			assert.doesNotThrow(() => migrate(raw));
		}
	});

	it('keeps values an older build wrote', () => {
		const { settings, state } = migrate({
			settings: { githubOwner: 'me', githubRepo: 'notes', token: 'x', branch: 'trunk' },
			state: { deviceId: 'desktop-abc', lastSyncedCommit: 'abc123' },
		});
		assert.equal(settings.githubOwner, 'me');
		assert.equal(settings.branch, 'trunk');
		assert.equal(state.deviceId, 'desktop-abc');
		assert.equal(state.lastSyncedCommit, 'abc123');
	});

	it('fills in a setting the older build did not have', () => {
		const { settings } = migrate({ settings: { githubOwner: 'me' }, state: {} });
		assert.equal(typeof settings.recycleBin, 'boolean');
		assert.equal(typeof settings.syncEnabled, 'boolean');
	});

	it('drops a setting the plugin no longer has', () => {
		const { settings } = migrate({
			settings: { githubOwner: 'me', autoPushSeconds: 30, legacyMode: true },
			state: {},
		});
		assert.equal('autoPushSeconds' in settings, false);
		assert.equal('legacyMode' in settings, false);
	});

	it('replaces values of the wrong type rather than trusting them', () => {
		const { settings } = migrate({
			settings: { pullExtensions: 'md', ignoredPaths: 5, branch: 42 },
			state: {},
		});
		assert.deepEqual(settings.pullExtensions, DEFAULT_EXTENSIONS);
		assert.deepEqual(settings.ignoredPaths, []);
		assert.equal(settings.branch, 'main');
	});

	it('discards malformed tracked files but keeps good ones', () => {
		const { state } = migrate({
			settings: {},
			state: {
				lastSyncedCommit: 'abc',
				trackedFiles: {
					'a.md': { localHash: 'h', remoteSha: 's', mtime: 1, size: 2 },
					'b.md': { localHash: 'h' },
					'c.md': 'nope',
				},
			},
		});
		assert.deepEqual(Object.keys(state.trackedFiles), ['a.md']);
		assert.equal(state.trackedFiles['a.md']?.mtime, 1);
	});

	it('caps a debug log that grew under an older build', () => {
		const { state } = migrate({
			settings: {},
			state: { debugLog: Array.from({ length: 900 }, (_, i) => `line ${i}`) },
		});
		assert.equal(state.debugLog.length, 200);
		assert.equal(state.debugLog.at(-1), 'line 899');
	});

	it('drops a recorded tree with no commit to anchor it', () => {
		const { state } = migrate({
			settings: {},
			state: { lastSyncedCommit: null, lastSyncedTree: { 'a.md': 'sha' } },
		});
		assert.deepEqual(state.lastSyncedTree, {});
	});

	it('does not rewrite a file already at the current version', () => {
		const current = migrate(null);
		const { changed } = migrate({
			schemaVersion: SCHEMA_VERSION,
			settings: current.settings,
			state: current.state,
		});
		assert.equal(changed, false);
	});
});
