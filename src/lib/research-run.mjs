// Disk layout of one research run. Every command after `plan` reads the same
// six things, so the walk lives here once rather than in four subcommands.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ShipError } from '../log.mjs';
import { readJSONOrNull, readJSONStrict } from './jsonio.mjs';

/** @typedef {{dir: string, slug: string, plan: any, references: any[], corpora: any[], themes: any, patterns: any, hashes: Map<string, string>}} Run */

/** @type {(dir: string) => Promise<string[]>} */
const jsonFiles = async (dir) =>
	existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')).sort() : [];

/**
 * The run to act on: `--slug` if given, else the newest one on disk. Newest by
 * name, because the slug leads with the date it was planned on.
 * @type {(researchDir: string, slug?: string) => Promise<string>}
 */
export async function resolveSlug(researchDir, slug) {
	if (slug) {
		if (!existsSync(join(researchDir, slug, 'plan.json')))
			throw new ShipError(`research: no run "${slug}"`, { hint: `expected ${join(researchDir, slug, 'plan.json')}` });
		return slug;
	}
	const entries = existsSync(researchDir)
		? (await readdir(researchDir, { withFileTypes: true }))
				.filter((e) => e.isDirectory() && existsSync(join(researchDir, e.name, 'plan.json')))
				.map((e) => e.name)
				.sort()
		: [];
	const latest = entries.at(-1);
	if (!latest) throw new ShipError('research: no run to read', { hint: 'run `ship research plan` first' });
	return latest;
}

/**
 * Load a run whole. Asset bytes are hashed rather than kept: the gate only asks
 * whether the image on disk is still the image a reference was written about.
 * @type {(researchDir: string, slug: string) => Promise<Run>}
 */
export async function loadRun(researchDir, slug) {
	const dir = join(researchDir, slug);
	const plan = await readJSONStrict(join(dir, 'plan.json'));
	const references = [];
	for (const file of await jsonFiles(join(dir, 'references')))
		references.push(await readJSONStrict(join(dir, 'references', file)));
	const corpora = [];
	for (const file of await jsonFiles(join(dir, 'reviews')))
		corpora.push(await readJSONStrict(join(dir, 'reviews', file)));

	/** @type {Map<string, string>} */
	const hashes = new Map();
	const assets = join(dir, 'assets');
	if (existsSync(assets))
		for (const file of (await readdir(assets)).sort())
			hashes.set(`assets/${file}`, createHash('sha256').update(await readFile(join(assets, file))).digest('hex'));

	return {
		dir,
		slug,
		plan,
		references,
		corpora,
		themes: await readJSONOrNull(join(dir, 'themes.json')),
		patterns: await readJSONOrNull(join(dir, 'patterns.json')),
		hashes,
	};
}

/**
 * Review pages a corpus must have cost, for the budget check.
 * @type {(corpora: any[], perPage?: number) => number}
 */
export const reviewPagesUsed = (corpora, perPage = 50) =>
	corpora.reduce((n, c) => n + Math.ceil((c?.count ?? 0) / perPage), 0);
