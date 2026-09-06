import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	isIgnoredPath,
	isSafeVaultPath,
	matchesExtensions,
	normalizeExtension,
	normalizePath,
	setConfigDir,
} from '../src/vault/PathFilter.ts';

describe('normalizePath', () => {
	it('converts separators and strips leading slashes', () => {
		assert.equal(normalizePath('notes\\daily\\today.md'), 'notes/daily/today.md');
		assert.equal(normalizePath('///notes/a.md'), 'notes/a.md');
	});
});

describe('isSafeVaultPath', () => {
	it('accepts ordinary vault paths', () => {
		assert.equal(isSafeVaultPath('notes/a.md'), true);
	});

	it('rejects traversal and empty segments', () => {
		for (const path of ['../secret.md', 'notes/../../secret.md', '..', '', 'a//b.md']) {
			assert.equal(isSafeVaultPath(path), false, `expected ${JSON.stringify(path)} unsafe`);
		}
	});
});

describe('isIgnoredPath', () => {
	it('always ignores the trash and config folders', () => {
		assert.equal(isIgnoredPath('.trash/old.md', []), true);
		assert.equal(isIgnoredPath('.obsidian/workspace.json', []), true);
	});

	it('matches a configured prefix but not a lookalike sibling', () => {
		assert.equal(isIgnoredPath('private/notes/a.md', ['private']), true);
		assert.equal(isIgnoredPath('private-notes/a.md', ['private']), false);
	});

	it('honours a renamed config folder', () => {
		setConfigDir('.my-config');
		assert.equal(isIgnoredPath('.my-config/workspace.json', []), true);
		setConfigDir('.obsidian');
		assert.equal(isIgnoredPath('.obsidian/workspace.json', []), true);
	});

	it('ignores blank entries rather than matching everything', () => {
		assert.equal(isIgnoredPath('notes/a.md', ['', '   ']), false);
	});
});

describe('matchesExtensions', () => {
	it('matches case-insensitively and tolerates a missing dot', () => {
		assert.equal(matchesExtensions('Notes/A.MD', ['.md']), true);
		assert.equal(matchesExtensions('notes/a.md', ['md']), true);
	});

	it('does not match an unlisted extension', () => {
		assert.equal(matchesExtensions('notes/a.png', ['.md']), false);
	});

	it('matches nothing when no extensions are selected', () => {
		assert.equal(matchesExtensions('notes/a.md', []), false);
	});
});

describe('normalizeExtension', () => {
	it('lowercases and adds the leading dot', () => {
		assert.equal(normalizeExtension(' MD '), '.md');
		assert.equal(normalizeExtension('.PNG'), '.png');
		assert.equal(normalizeExtension('  '), '');
	});
});
