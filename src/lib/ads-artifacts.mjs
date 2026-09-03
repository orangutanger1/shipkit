// dated artifact tree for `ship ads`: every generated file lands in
// cfg.paths.asa with the parameters it was produced under, and an index.json
// keeps the newest `ads.retain` of each kind. The retention exists because a
// stale mining file generated under different flags once masqueraded as
// current state.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { num } from './fmt.mjs';
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./ads-plan.mjs').ScoredRowInput} ScoredRowInput */
/** @typedef {import('./ads-plan.mjs').ScoredRow} ScoredRow */
/** @typedef {import('./ads-plan.mjs').TermScore} TermScore */
/** @typedef {import('./ads-plan.mjs').ConvertingTerm} ConvertingTerm */

/**
 * @param {string|ScoredRowInput} r
 * @returns {ScoredRow}
 */
const asScoredRow = (r) => (typeof r === 'string' ? { term: r } : { ...r, term: r.term ?? r.keyword });

/**
 * The scored-keyword rows `plan` reads, tolerating both artifact shapes.
 * @param {{terms?: (string|ScoredRowInput)[], scored?: (string|ScoredRowInput)[]}|null|undefined} doc
 * @returns {TermScore[]}
 */
export function scoredTerms(doc) {
	const raw = Array.isArray(doc?.terms) ? doc.terms : Array.isArray(doc?.scored) ? doc.scored : [];
	return raw
		.map(asScoredRow)
		.filter((r) => r.term)
		.map((r) => ({
			term: String(r.term).toLocaleLowerCase(),
			demand: r.demand === undefined || r.demand === null ? 100 : num(r.demand),
			competition: num(r.competition), opportunity: num(r.opportunity),
			medianRatings: r.medianRatings ?? null, weakAppsTop10: r.weakAppsTop10 ?? null,
			exactTitleMatches: r.exactTitleMatches ?? null, top3: r.top3 ?? [],
		}));
}

/** @param {Config} cfg @param {string} name @param {Json} body @returns {Promise<string>} */
export async function writeArtifact(cfg, name, body) {
	await mkdir(cfg.paths.asa, { recursive: true });
	const file = join(cfg.paths.asa, name);
	await writeFile(file, `${JSON.stringify(body, null, '\t')}\n`);
	await reindexArtifacts(cfg);
	return file;
}

const DATED = /^(mining|snapshot)-\d{4}-\d{2}-\d{2}\.json$/;

/** @param {string} dir @param {string[]} dated @param {number} keep @param {string[]} pruned @returns {Promise<void>} */
const pruneOld = async (dir, dated, keep, pruned) => {
	const byKind = new Map();
	for (const n of dated) byKind.set(n.split('-')[0], [...(byKind.get(n.split('-')[0]) ?? []), n]);
	for (const [, list] of byKind)
		for (const n of list.slice(0, Math.max(0, list.length - keep))) {
			await unlink(join(dir, n)).catch(() => {});
			pruned.push(n);
		}
};

/** @param {string} dir @param {string} n @returns {Promise<{file: string, kind: string, generatedAt: string|null, params: Json|null, killRule: Json|null}|null>} */
const indexEntry = async (dir, n) => {
	const file = join(dir, n);
	if (!existsSync(file)) return null;
	let doc = null;
	try {
		doc = JSON.parse(await readFile(file, 'utf8'));
	} catch {
		doc = null;
	}
	const st = await stat(file).catch(() => null);
	return {
		file: n, kind: n.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '').replace(/\.json$/, ''),
		generatedAt: doc?.generatedAt ?? st?.mtime?.toISOString() ?? null,
		params: doc?.params ?? null, killRule: doc?.killRule ?? null,
	};
};

/** @param {Config} cfg @returns {Promise<{generatedAt: string, retain: number, pruned: string[], artifacts: {file: string, kind: string, generatedAt: string|null, params: Json|null, killRule: Json|null}[]}|null>} */
async function reindexArtifacts(cfg) {
	const dir = cfg.paths.asa;
	/** @type {string[]} */
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	const dated = names.filter((n) => DATED.test(n)).sort();
	const keep = Math.max(1, num(cfg.ads?.retain, 12));
	/** @type {string[]} */
	const pruned = [];
	await pruneOld(dir, dated, keep, pruned);

	const kept = dated.filter((n) => !pruned.includes(n));
	/** @type {{file: string, kind: string, generatedAt: string|null, params: Json|null, killRule: Json|null}[]} */
	const entries = [];
	for (const n of [...kept, 'campaign-plan.json', 'snapshot.json']) {
		const entry = await indexEntry(dir, n);
		if (entry) entries.push(entry);
	}
	const index = {
		generatedAt: new Date().toISOString(), retain: keep, pruned,
		artifacts: entries.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))),
	};
	await writeFile(join(dir, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
	return index;
}

/** Rows of paid-terms.json, as this function writes them. */
/** @typedef {{term: string, installs: number, spend: number, cpi: number, firstSeen: string, lastSeen: string}} PaidTerm */
/**
 * Converting paid search terms, merged into the running paid-terms.json.
 * @param {Config} cfg
 * @param {string} locale
 * @param {ConvertingTerm[]} converting
 * @returns {Promise<{file: string, count: number}>}
 */
export async function writePaidTerms(cfg, locale, converting) {
	const dir = join(cfg.paths.aso, locale);
	const file = join(dir, 'paid-terms.json');
	const today = new Date().toISOString().slice(0, 10);
	/** @type {{terms?: PaidTerm[]}|null} */
	const before = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
	/** @type {Map<string, PaidTerm>} */
	const merged = new Map((before?.terms ?? []).map((t) => [String(t.term).toLocaleLowerCase(), t]));
	for (const t of converting) {
		const prev = merged.get(t.term);
		merged.set(t.term, {
			term: t.term, installs: Math.max(num(prev?.installs), t.installs), spend: t.spend, cpi: t.cpi,
			firstSeen: prev?.firstSeen ?? today, lastSeen: today,
		});
	}
	const artifact = {
		generatedAt: new Date().toISOString(), locale, source: 'apple-ads-search-terms',
		terms: [...merged.values()].sort((a, b) => num(b.installs) - num(a.installs) || a.term.localeCompare(b.term)),
	};
	await mkdir(dir, { recursive: true });
	await writeFile(file, `${JSON.stringify(artifact, null, '\t')}\n`);
	return { file, count: artifact.terms.length };
}
