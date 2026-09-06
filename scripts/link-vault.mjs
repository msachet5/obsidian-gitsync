#!/usr/bin/env node
/**
 * Points a vault's plugin folder at this repo with a symlink, so `npm run dev`
 * writes main.js straight into the vault and there is nothing to copy by hand.
 *
 * Usage: npm run link -- "/path/to/test vault"
 */

import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginId = JSON.parse(
	await import('fs').then((fs) => fs.promises.readFile(join(repoRoot, 'manifest.json'), 'utf8')),
).id;

const vault = process.argv[2] ? resolve(process.argv[2]) : null;
if (!vault) {
	console.error('Usage: npm run link -- "/path/to/test vault"');
	process.exit(1);
}

const configDir = join(vault, '.obsidian');
if (!existsSync(configDir)) {
	console.error(
		`No .obsidian folder in ${vault}\n` +
			'Open the folder as a vault in Obsidian once, then run this again.',
	);
	process.exit(1);
}

const pluginsDir = join(configDir, 'plugins');
mkdirSync(pluginsDir, { recursive: true });

const target = join(pluginsDir, pluginId);
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
	const stat = lstatSync(target);
	if (!stat.isSymbolicLink()) {
		console.error(
			`${target} already exists and is a real folder, not a link.\n` +
				'Move or delete it first so nothing of yours is thrown away.',
		);
		process.exit(1);
	}
	rmSync(target);
}

symlinkSync(repoRoot, target, 'dir');

// pjeby/hot-reload watches for this file and reloads the plugin when main.js
// changes, which turns the loop into: save, look at Obsidian.
writeFileSync(join(repoRoot, '.hotreload'), '');

console.log(`Linked ${basename(vault)} -> ${repoRoot}`);
console.log('\nNext:');
console.log('  1. npm run dev          (rebuilds main.js on every save)');
console.log(`  2. Enable "${pluginId}" in Settings -> Community plugins`);
console.log('  3. Optional: install pjeby/hot-reload for automatic reloads,');
console.log('     otherwise toggle the plugin off and on to pick up a build.');
