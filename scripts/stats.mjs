#!/usr/bin/env node
/**
 * Adoption report for this plugin.
 *
 * Before the plugin is listed in the community directory, GitHub is the only
 * signal: stars and release asset downloads. Once it is listed, the number
 * that matters is in obsidianmd/obsidian-releases/community-plugin-stats.json,
 * which is the same source every third-party Obsidian stats site reads.
 *
 * Usage: npm run stats
 */

import { readFileSync } from 'fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const PLUGIN_ID = manifest.id;
const REPO = 'msachet5/obsidian-gitsync';

const STATS_URL =
	'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';

async function getJson(url) {
	const headers = { 'User-Agent': 'gitsync-stats' };
	// A token lifts the unauthenticated GitHub limit of 60 requests an hour.
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return response.json();
}

function line(label, value) {
	console.log(`  ${label.padEnd(22)} ${value}`);
}

async function directoryStats() {
	console.log('\nCommunity directory');
	const all = await getJson(STATS_URL);
	const mine = all[PLUGIN_ID];

	if (!mine) {
		line('status', `not listed yet (id "${PLUGIN_ID}")`);
		line('plugins listed', Object.keys(all).length.toLocaleString());
		return;
	}

	const totals = Object.values(all)
		.map((entry) => entry.downloads ?? 0)
		.sort((a, b) => b - a);
	const rank = totals.findIndex((value) => value <= mine.downloads) + 1;
	const percentile = ((1 - rank / totals.length) * 100).toFixed(1);

	line('total downloads', mine.downloads.toLocaleString());
	line('rank', `${rank.toLocaleString()} of ${totals.length.toLocaleString()} (top ${percentile}%)`);
	line('stats updated', new Date(mine.updated).toISOString().slice(0, 10));

	const versions = Object.entries(mine)
		.filter(([key]) => /^\d+\.\d+\.\d+/.test(key))
		.sort((a, b) => b[1] - a[1]);
	if (versions.length) {
		console.log('\n  by version');
		for (const [version, count] of versions.slice(0, 8)) {
			console.log(`    ${version.padEnd(12)} ${count.toLocaleString()}`);
		}
	}
}

async function githubStats() {
	console.log('\nGitHub');
	const repo = await getJson(`https://api.github.com/repos/${REPO}`);
	line('stars', repo.stargazers_count);
	line('forks', repo.forks_count);
	line('open issues', repo.open_issues_count);

	const releases = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
	if (!releases.length) {
		line('releases', 'none published yet');
		return;
	}

	let total = 0;
	console.log('\n  release asset downloads');
	for (const release of releases) {
		const count = release.assets.reduce((sum, asset) => sum + asset.download_count, 0);
		total += count;
		console.log(`    ${release.tag_name.padEnd(12)} ${count.toLocaleString()}`);
	}
	line('\n  total', total.toLocaleString());
}

console.log(`\n${manifest.name} — adoption report`);
try {
	await directoryStats();
	await githubStats();
} catch (error) {
	console.error(`\nFailed: ${error.message}`);
	process.exitCode = 1;
}
console.log();
