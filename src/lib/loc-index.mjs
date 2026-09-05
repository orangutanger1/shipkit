// Index and cache helpers for `ship loc`: readers for a locale's research
// artifacts (`aso/<locale>/scored.json`, `aso/<locale>/candidates.json`,
// analytics terms) and the pure selection built on top of them — probe-term
// choice, seed mining from incumbent titles, noun extraction, keyword
// provenance. No network, no user-facing output.
import { join } from 'node:path';
import { hasTodo, supported } from './listing-audit.mjs';
import { readJSONIfExists } from './jsonio.mjs';
import { keywordList } from './locales.mjs';
import { isNoSpaceLang, stopwordsFor, words } from './text.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./locales.mjs').ListingData} ListingData */
/** @typedef {import('./listing-audit.mjs').Glossary} Glossary */

/** A term-evidence index: how many terms fed it, and the token set they produced. */
/** @typedef {{terms: number, index: Set<string>}} HarvestIndex */
/** One row of aso/<locale>/scored.json. */
/** @typedef {{term: string, opportunity: number}} ScoredTerm */

/**
 * aso/<locale>/scored.json, written by `ship aso score`. Files written before
 * the rename say `scored`; entries may be bare term strings.
 * @typedef {string|{term?: string, keyword?: string, opportunity?: number, top3?: {id?: string}[]}} ScoredRow
 */
/** @typedef {{terms?: ScoredRow[], scored?: ScoredRow[], [key: string]: Json|undefined}} ScoredFile */

/** aso/<locale>/candidates.json — the harvest artifact; only the `terms` keys matter here. */
/** @typedef {{terms?: JsonObject, [key: string]: Json|undefined}} CandidatesFile */

/** analytics/<locale>-terms.json, written by `ship aso volume`. */
/** @typedef {{rows?: {term: string}[], [key: string]: Json|undefined}} AnalyticsFile */

/** Key order for a staged file, so a regenerated draft diffs against the last one. */
const FIELD_ORDER = [
	'locale',
	'name',
	'subtitle',
	'keywords',
	'promotionalText',
	'description',
	'whatsNew',
	'privacyPolicyUrl',
	'supportUrl',
	'marketingUrl',
	'provenance',
	'notes',
];

/** @param {Config} cfg @param {string} locale @param {'scored'|'candidates'} kind */
const asoFile = (cfg, locale, kind) => join(cfg.paths.aso, locale, `${kind}.json`);
/** @param {Config} cfg @param {string} locale */
const analyticsFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-terms.json`);

/** Re-key a staged file into FIELD_ORDER, keeping any extra keys at the end. */
/**
 * @param {JsonObject} data
 * @returns {JsonObject}
 */
export function order(data) {
	/** @type {JsonObject} */
	const out = {};
	for (const k of FIELD_ORDER) if (data[k] !== undefined) out[k] = data[k];
	for (const k of Object.keys(data)) if (!(k in out)) out[k] = data[k];
	return out;
}

/**
 * `scored.json` is `{terms:[…]}`; files written before the rename say `{scored:[…]}`
 * and entries may be bare strings. Research is expensive — read every shape.
 * @param {Config} cfg
 * @param {string} locale
 * @returns {Promise<ScoredTerm[]>}
 */
export async function scoredTerms(cfg, locale) {
	const data = /** @type {ScoredFile|null} */ (await readJSONIfExists(asoFile(cfg, locale, 'scored')));
	const rows = data?.terms ?? data?.scored ?? [];
	return rows
		.map((r) =>
			typeof r === 'string'
				? { term: r, opportunity: 0 }
				: { term: r.term ?? r.keyword, opportunity: r.opportunity ?? 0 },
		)
		.filter(/** @param {{term: string|undefined, opportunity: number}} r @returns {r is ScoredTerm} */ (r) => typeof r.term === 'string');
}

/** Term strings plus their tokens, so a packed single word still matches the phrase it came from. */
/**
 * @param {string[]} names
 * @param {string} locale
 * @returns {HarvestIndex}
 */
function tokenIndex(names, locale) {
	const index = new Set();
	for (const name of names) {
		index.add(String(name).toLocaleLowerCase());
		for (const w of words(name, locale)) index.add(w);
	}
	return { terms: names.length, index };
}

/** What `ship aso harvest` actually saw in this locale's own storefront, or null if it never ran. */
/**
 * @param {Config} cfg
 * @param {string} locale
 * @returns {Promise<HarvestIndex|null>}
 */
export async function harvestIndex(cfg, locale) {
	const data = /** @type {CandidatesFile|null} */ (await readJSONIfExists(asoFile(cfg, locale, 'candidates')));
	// `terms` is `{term: {seeds, rank}}` now and `{term: [seeds]}` in older artifacts;
	// only the keys matter here, so both read the same.
	return data ? tokenIndex(Object.keys(data.terms ?? {}), locale) : null;
}

/** Search terms App Store Connect says real users arrived on. Never required. */
/**
 * @param {Config} cfg
 * @param {string} locale
 * @returns {Promise<HarvestIndex|null>}
 */
export async function analyticsIndex(cfg, locale) {
	const data = /** @type {AnalyticsFile|null} */ (await readJSONIfExists(analyticsFile(cfg, locale)));
	if (!data) return null;
	return tokenIndex((data.rows ?? []).map((r) => r.term).filter(Boolean), locale);
}

/** Source-locale terms worth probing a foreign storefront with, best research first. */
/**
 * @param {Config} cfg
 * @param {string} source
 * @param {ListingData} data
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function probeTerms(cfg, source, data, limit) {
	const scored = await scoredTerms(cfg, source);
	if (scored.length)
		return scored
			.sort((a, b) => b.opportunity - a.opportunity)
			.slice(0, limit)
			.map((s) => s.term);
	const fromKeywords = keywordList(data.keywords).filter((k) => !hasTodo(k));
	if (fromKeywords.length) return fromKeywords.slice(0, limit);
	const stop = stopwordsFor(source);
	return [...new Set(words(`${data.name ?? ''} ${data.subtitle ?? ''}`, source))]
		.filter((w) => w.length > 3 && !stop.has(w))
		.slice(0, limit);
}

/** Competitor ids the source-locale scoring already found; looked up abroad they answer in that language. */
/**
 * @param {Config} cfg
 * @param {string} source
 * @returns {Promise<string[]>}
 */
export async function competitorIds(cfg, source) {
	const data = /** @type {ScoredFile|null} */ (await readJSONIfExists(asoFile(cfg, source, 'scored')));
	const rows = data?.terms ?? data?.scored ?? [];
	const ids = new Set();
	for (const row of rows) {
		if (row === null || typeof row !== 'object') continue;
		for (const app of row.top3 ?? []) if (app?.id) ids.add(app.id);
	}
	return [...ids];
}

/**
 * Native vocabulary mined from the localized titles of a storefront's incumbents.
 * A word one app uses is that app's branding; a word two apps use is the market's
 * noun for the thing, which is what autocomplete will complete.
 * @param {string[]} titles
 * @param {{locale?: string, exclude?: string[], top?: number, minApps?: number}} [opts]
 * @returns {{term: string, apps: number}[]}
 */
function seedsFromTitles(titles, { locale = 'en', exclude = [], top = 8, minApps = 2 } = {}) {
	const stop = stopwordsFor(locale);
	const skip = new Set(exclude.flatMap((e) => words(e, locale)));
	const joiner = isNoSpaceLang(locale) ? '' : ' ';
	const minLen = isNoSpaceLang(locale) ? 2 : 3;
	/** @type {Map<string, number>} */
	const freq = new Map();
	for (const title of titles) {
		/** @type {Set<string>} */
		const seen = new Set();
		// Store titles are `Brand: the real pitch` far more often than not.
		// Both title sources filter on `trackName` before pushing, so a title here
		// is always a non-empty string.
		for (const segment of title.split(/[:：|—–,·・、]+|\s-\s/)) {
			const toks = words(segment, locale).filter((w) => w.length >= minLen && !stop.has(w) && !skip.has(w));
			for (let i = 0; i < toks.length; i++) {
				seen.add(toks[i]);
				if (i + 1 < toks.length) seen.add(toks[i] + joiner + toks[i + 1]);
			}
		}
		for (const term of seen) freq.set(term, (freq.get(term) ?? 0) + 1);
	}
	const entries = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shared = entries.filter(([, n]) => n >= minApps);
	return (shared.length ? shared : entries).slice(0, top).map(([term, apps]) => ({ term, apps }));
}

/**
 * Every seed source in priority order: glossary agreements first, then the
 * vocabulary mined from incumbent titles, then anything passed with --seeds.
 * First sighting of a term wins its origin; keys are lowercased and trimmed.
 * @param {{titles: string[], glossary: Glossary, locale: string, exclude: string[], extra: string[], top: number}} opts
 * @returns {{seeds: string[], from: Record<string, string>}}
 */
export function mineSeeds({ titles, glossary, locale, exclude, extra, top }) {
	/** @type {Record<string, string>} */
	const from = {};
	/** @type {string[]} */
	const seeds = [];
	/**
	 * @param {string} term
	 * @param {string} origin
	 */
	const push = (term, origin) => {
		const key = String(term).toLocaleLowerCase().trim();
		if (!key || from[key]) return;
		from[key] = origin;
		seeds.push(key);
	};
	for (const [srcTerm, row] of Object.entries(glossary.terms ?? {}))
		if (row?.[locale]) push(row[locale], `glossary: ${srcTerm}`);
	for (const { term, apps } of seedsFromTitles(titles, { locale, exclude, top }))
		push(term, `top results (${apps} app${apps === 1 ? '' : 's'})`);
	for (const term of extra) push(term, '--seeds');
	return { seeds, from };
}

/**
 * Words a translator must leave alone: the app's own name, plus any capitalised
 * token in the source name/subtitle that is not the field's first word. Sentence
 * case makes the first word ambiguous, so it only counts when it is the app name.
 * @param {Config} cfg
 * @param {ListingData} data
 * @returns {string[]}
 */
export function brandNouns(cfg, data) {
	const out = new Set();
	if (cfg.name) out.add(cfg.name);
	for (const field of ['name', 'subtitle']) {
		const tokens = String(data[field] ?? '').split(/\s+/).filter(Boolean);
		tokens.forEach((token, i) => {
			const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
			if (word.length < 2) return;
			if (word[0] === word[0].toLocaleLowerCase()) return;
			if (i > 0 || word === cfg.name) out.add(word);
		});
	}
	return [...out];
}

/** The nouns a listing is actually about — what a translator has to agree on once. */
/**
 * @param {ListingData} data
 * @param {{locale: string, exclude: string[]}} opts
 * @returns {string[]}
 */
export function productNouns(data, { locale, exclude }) {
	const stop = stopwordsFor(locale);
	const skip = new Set(exclude.flatMap((t) => words(t, locale)));
	const out = new Set();
	for (const field of ['name', 'subtitle']) {
		const text = String(data[field] ?? '').trim();
		if (text) out.add(text);
		for (const w of words(text, locale)) if (w.length >= 3 && !stop.has(w) && !skip.has(w)) out.add(w);
	}
	return [...out];
}

/** Where each keyword's evidence comes from. `manual` means a human asserted it and nothing corroborates it. */
/**
 * @param {string[]} terms
 * @param {{harvest: HarvestIndex|null, analytics: HarvestIndex|null, locale: string}} opts
 * @returns {Record<string, 'analytics'|'harvest'|'manual'>}
 */
export function provenanceFor(terms, { harvest, analytics, locale }) {
	/** @type {Record<string, 'analytics'|'harvest'|'manual'>} */
	const out = {};
	for (const term of terms) {
		if (hasTodo(term)) continue;
		out[term] =
			analytics && supported(term, analytics.index, locale)
				? 'analytics'
				: harvest && supported(term, harvest.index, locale)
					? 'harvest'
					: 'manual';
	}
	return out;
}
