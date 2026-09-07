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

import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync } from 'fs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const PLUGIN_ID = manifest.id;
const REPO = 'msachet5/obsidian-ultisync';

const STATS_URL =
	'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';

/**
 * A token lifts the unauthenticated limit of 60 requests an hour, and the
 * traffic endpoints require one outright. Borrowed from the gh CLI when the
 * environment does not supply one, so this works with no setup.
 */
function githubToken() {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	try {
		return execFileSync('gh', ['auth', 'token'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

const TOKEN = githubToken();

async function getJson(url) {
	const headers = { 'User-Agent': 'ultisync-stats' };
	if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

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

/**
 * Views, clones and referrers. GitHub keeps only the last 14 days of this and
 * then discards it, so it is the one number here that is genuinely lost if
 * nobody writes it down. Needs push access; anyone else gets a 403.
 */
async function trafficStats() {
	console.log('\nTraffic (GitHub keeps 14 days only)');
	try {
		const [views, clones, referrers] = await Promise.all([
			getJson(`https://api.github.com/repos/${REPO}/traffic/views`),
			getJson(`https://api.github.com/repos/${REPO}/traffic/clones`),
			getJson(`https://api.github.com/repos/${REPO}/traffic/popular/referrers`),
		]);

		line('views', `${views.count} (${views.uniques} unique)`);
		line('clones', `${clones.count} (${clones.uniques} unique)`);

		if (!referrers.length) {
			line('referrers', 'none — nothing is linking here yet');
		} else {
			console.log('\n  where visitors came from');
			for (const source of referrers) {
				console.log(`    ${source.referrer.padEnd(24)} ${source.count} (${source.uniques} unique)`);
			}
		}
		return { views: views.count, viewsUnique: views.uniques, clones: clones.count };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		line('traffic', `unavailable (needs push access) — ${reason}`);
		return null;
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
		return { stars: repo.stargazers_count, assetDownloads: 0 };
	}

	let total = 0;
	console.log('\n  release asset downloads');
	for (const release of releases) {
		const count = release.assets.reduce((sum, asset) => sum + asset.download_count, 0);
		total += count;
		console.log(`    ${release.tag_name.padEnd(12)} ${count.toLocaleString()}`);
	}
	// BRAT fetches three files per install, so the headline figure overstates
	// installs by roughly three to one.
	console.log(`    ${'installs (approx)'.padEnd(12)} ~${Math.round(total / 3).toLocaleString()}`);

	return { stars: repo.stargazers_count, assetDownloads: total };
}

console.log(`\n${manifest.name} — adoption report`);
try {
	await directoryStats();
	const github = await githubStats();
	const traffic = await trafficStats();

	// --snapshot appends one dated line so a series survives GitHub's 14-day
	// window. Run it on a schedule and the history builds itself.
	if (process.argv.includes('--snapshot')) {
		const row = {
			date: new Date().toISOString().slice(0, 10),
			version: manifest.version,
			...github,
			...traffic,
		};
		appendFileSync('stats-history.jsonl', `${JSON.stringify(row)}\n`);
		console.log('\nAppended to stats-history.jsonl');
	}
} catch (error) {
	console.error(`\nFailed: ${error.message}`);
	process.exitCode = 1;
}
console.log();
