#!/usr/bin/env node
/**
 * Copies the three runtime files into a vault's plugin folder.
 *
 * Use this where a symlink will not do: an iCloud or Dropbox vault that syncs
 * to a phone has to hold real files, because the sync client will not follow a
 * link. For a local desktop vault prefer `npm run link`, which needs no copy
 * step at all.
 *
 * Usage: npm run deploy -- "/path/to/vault"
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const RUNTIME_FILES = ['main.js', 'manifest.json', 'styles.css'];

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));

const vault = process.argv[2] ? resolve(process.argv[2]) : null;
if (!vault) {
	console.error('Usage: npm run deploy -- "/path/to/vault"');
	process.exit(1);
}

if (!existsSync(join(vault, '.obsidian'))) {
	console.error(
		`No .obsidian folder in ${vault}\n` +
			'Open the folder as a vault in Obsidian once, then run this again.',
	);
	process.exit(1);
}

const missing = RUNTIME_FILES.filter((file) => !existsSync(join(repoRoot, file)));
if (missing.length) {
	console.error(`Missing ${missing.join(', ')}. Run "npm run build" first.`);
	process.exit(1);
}

const target = join(vault, '.obsidian', 'plugins', manifest.id);
mkdirSync(target, { recursive: true });

for (const file of RUNTIME_FILES) {
	copyFileSync(join(repoRoot, file), join(target, file));
	const { size } = statSync(join(target, file));
	console.log(`  ${file.padEnd(14)} ${(size / 1024).toFixed(1)} KB`);
}

console.log(`\nCopied ${manifest.name} ${manifest.version} into ${basename(vault)}`);
console.log(`  ${target}`);
console.log('\nOn the phone: let the vault finish syncing, then Settings ->');
console.log(`Community plugins -> enable "${manifest.name}". If it was already`);
console.log('enabled, toggle it off and on to load the new build.');
