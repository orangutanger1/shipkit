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

/** Key order for a staged file, so a regenerated draft diffs against the last one. */
export const FIELD_ORDER = [
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

export const asoFile = (cfg, locale, kind) => join(cfg.paths.aso, locale, `${kind}.json`);
const analyticsFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-terms.json`);

/** Re-key a staged file into FIELD_ORDER, keeping any extra keys at the end. */
export function order(data) {
	const out = {};
	for (const k of FIELD_ORDER) if (data[k] !== undefined) out[k] = data[k];
	for (const k of Object.keys(data)) if (!(k in out)) out[k] = data[k];
	return out;
}

/**
 * `scored.json` is `{terms:[…]}`; files written before the rename say `{scored:[…]}`
 * and entries may be bare strings. Research is expensive — read every shape.
 */
export async function scoredTerms(cfg, locale) {
	const data = await readJSONIfExists(asoFile(cfg, locale, 'scored'));
	const rows = data?.terms ?? data?.scored ?? [];
	return rows
		.map((r) =>
			typeof r === 'string'
				? { term: r, opportunity: 0 }
				: { term: r.term ?? r.keyword, opportunity: r.opportunity ?? 0 },
		)
		.filter((r) => r.term);
}

/** Term strings plus their tokens, so a packed single word still matches the phrase it came from. */
export function tokenIndex(names, locale) {
	const index = new Set();
	for (const name of names) {
		index.add(String(name).toLocaleLowerCase());
		for (const w of words(name, locale)) index.add(w);
	}
	return { terms: names.length, index };
}

/** What `ship aso harvest` actually saw in this locale's own storefront, or null if it never ran. */
export async function harvestIndex(cfg, locale) {
	const data = await readJSONIfExists(asoFile(cfg, locale, 'candidates'));
	// `terms` is `{term: {seeds, rank}}` now and `{term: [seeds]}` in older artifacts;
	// only the keys matter here, so both read the same.
	return data ? tokenIndex(Object.keys(data.terms ?? {}), locale) : null;
}

/** Search terms App Store Connect says real users arrived on. Never required. */
export async function analyticsIndex(cfg, locale) {
	const data = await readJSONIfExists(analyticsFile(cfg, locale));
	if (!data) return null;
	return tokenIndex((data.rows ?? []).map((r) => r.term).filter(Boolean), locale);
}

/** Source-locale terms worth probing a foreign storefront with, best research first. */
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
export async function competitorIds(cfg, source) {
	const data = await readJSONIfExists(asoFile(cfg, source, 'scored'));
	const rows = data?.terms ?? data?.scored ?? [];
	const ids = new Set();
	for (const row of rows) for (const app of row?.top3 ?? []) if (app?.id) ids.add(app.id);
	return [...ids];
}

/**
 * Native vocabulary mined from the localized titles of a storefront's incumbents.
 * A word one app uses is that app's branding; a word two apps use is the market's
 * noun for the thing, which is what autocomplete will complete.
 * @returns {{term:string, apps:number}[]}
 */
export function seedsFromTitles(titles, { locale = 'en', exclude = [], top = 8, minApps = 2 } = {}) {
	const stop = stopwordsFor(locale);
	const skip = new Set(exclude.flatMap((e) => words(e, locale)));
	const joiner = isNoSpaceLang(locale) ? '' : ' ';
	const minLen = isNoSpaceLang(locale) ? 2 : 3;
	const freq = new Map();
	for (const title of titles) {
		const seen = new Set();
		// Store titles are `Brand: the real pitch` far more often than not.
		for (const segment of String(title ?? '').split(/[:：|—–,·・、]+|\s-\s/)) {
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
 */
export function mineSeeds({ titles, glossary, locale, exclude, extra, top }) {
	const from = {};
	const seeds = [];
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
export function provenanceFor(terms, { harvest, analytics, locale }) {
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
