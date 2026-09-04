// Pure ASO report logic, split out of src/commands/aso.mjs: the volume
// importer, seed-source resolution, candidate scoring, the keyword-packing
// proposal, the competitor assembly, the audit findings and the stage
// renderings. Nothing here calls App Store Connect or touches the filesystem —
// aso.mjs stays the pipeline over artifacts and these functions decide what
// they say. The one lazy read (seeds falling back to the staged listing) takes
// its reader injected, so the module stays honest and the command stays lazy.
import { LIMITS } from '../config.mjs';
import { POPULARITY_FLOOR } from './ads-v1.mjs';
import { packKeywords, progressLine } from './appstore.mjs';
import { c, good, heading, info, note, table, warn } from '../log.mjs';
import { charCount, indexedWords, isCovered, isNoSpaceLang } from './text.mjs';
import { keywordList, lintListing } from './locales.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./locales.mjs').StagedListing} StagedListing */
/** @typedef {import('./locales.mjs').ListingData} ListingData */
/** @typedef {import('./util.mjs').Flags} Flags */
/** @typedef {import('./appstore-client.mjs').Market} Market */
/** @typedef {{id?: string|number|null, name?: string}} CompetitorRef */
/** A scored candidate, tolerating the bare-string legacy shape. */
/** @typedef {{keyword: string, opportunity?: number, demand?: number, demandSource?: string, competition?: number, medianRatings?: number, weakAppsTop10?: number, difficulty?: number, top3?: CompetitorRef[]}} ScoredTerm */
/** @typedef {{name?: string, trackName?: string, sellerName?: string, userRatingCount?: number, averageUserRating?: number, price?: number, primaryGenreName?: string, subtitle?: string, trackId?: string|number}} StoreApp */

/** Shortest first: one- and two-word queries are the high-volume heads. */
/** @type {(a: string, b: string) => number} */
export const byLength = (a, b) => a.length - b.length || a.localeCompare(b);

/**
 * Terms scored by an earlier run, tolerating the pre-demand `scored` key.
 * @param {{terms?: ScoredTerm[], scored?: ScoredTerm[]}|null|undefined} artifact
 * @returns {ScoredTerm[]}
 */
export const scoredTerms = (artifact) => artifact?.terms ?? artifact?.scored ?? [];

/**
 * Scored terms whose every word is already covered by name/subtitle.
 * @param {(ScoredTerm|string)[]} scored
 * @param {string} alreadyIndexed
 * @param {string} locale
 * @returns {string[]}
 */
function coveredTerms(scored, alreadyIndexed, locale) {
	const indexed = indexedWords(alreadyIndexed, locale);
	if (!indexed.size) return [];
	return scored
		.map((e) => (typeof e === 'string' ? e : e.keyword))
		.filter((t) => isCovered(t, indexed, locale));
}

/**
 * Annotate scored terms with where their demand came from, and difficulty when known.
 * @param {ScoredTerm[]} scored
 * @param {Map<string, {source: string, difficulty?: number}>} demands
 * @returns {void}
 */
export function mergeDemands(scored, demands) {
	for (const entry of scored) {
		const row = demands.get(entry.keyword);
		if (!row) continue;
		entry.demandSource = row.source;
		if (row.difficulty !== undefined) entry.difficulty = row.difficulty;
	}
}

// --- harvest seeds ----------------------------------------------------------

/**
 * The locale the app is authored in; everything else is a translation.
 * @param {Config} cfg
 * @returns {string}
 */
export const sourceLocale = (cfg) => cfg.loc.sourceLocale ?? cfg.asc.primaryLocale;

/**
 * Where this locale's seeds come from, and whether they are the wrong language.
 * Feeding English seeds to the German storefront returns Apple's translation of
 * our own copy, not what Germans type into search — the single most expensive
 * mistake in a multi-market harvest, so it warns instead of quietly proceeding.
 * `listingFor` is injected (the command's staged-listing reader) and only paid
 * for when the config provides no seeds at all.
 * @param {Config} cfg
 * @param {string} locale
 * @param {Flags} flags
 * @param {(cfg: Config, locale: string) => Promise<StagedListing|null>} listingFor
 * @returns {Promise<{seeds: string[], origin: string, mismatch: boolean}>}
 */
export async function seedsFor(cfg, locale, flags, listingFor) {
	/** @type {(s: unknown) => string[]} */
	const split = (s) =>
		String(s ?? '')
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);

	let seeds = split(flags.seeds);
	let origin = '--seeds';
	let translated = seeds.length > 0;
	if (!seeds.length && cfg.aso.seedsByLocale?.[locale]?.length) {
		seeds = [...cfg.aso.seedsByLocale[locale]];
		origin = `aso.seedsByLocale.${locale}`;
		translated = false;
	}
	if (!seeds.length && cfg.aso.seeds?.length) {
		seeds = [...cfg.aso.seeds];
		origin = `aso.seeds in ${cfg.file}`;
		translated = true;
	}
	if (!seeds.length) {
		// Last resort: the listing itself. Short words are stop words in every
		// market we support and return junk from autocomplete — except where the
		// script has no spaces and a two-character token is a whole word.
		const listing = await listingFor(cfg, locale);
		const text = `${listing?.data.name ?? ''} ${listing?.data.subtitle ?? ''}`;
		const min = isNoSpaceLang(locale) ? 1 : 4;
		seeds = [...indexedWords(text, locale)].filter((w) => charCount(w) >= min);
		origin = listing ? `staged ${locale} name + subtitle` : 'nothing';
		translated = false;
	}
	const mismatch = translated && locale !== sourceLocale(cfg);
	return { seeds, origin, mismatch };
}

// --- volume import ----------------------------------------------------------

export const VOLUME_TEMPLATE = {
	terms: {
		'car maintenance log': { popularity: 62, difficulty: 30 },
		'service reminder': { popularity: 41 },
	},
};

/**
 * A Platform API v1 response wraps its payload in `result`, and the popularity
 * report wraps it again in `rows`. Unwrapping here rather than at the call site is
 * what lets `--file` take a saved API response with no editing.
 * @param {any} raw
 * @returns {any}
 */
const unwrapResult = (raw) => {
	const result = raw?.result ?? raw;
	return result?.rows ?? result;
};

/**
 * `term`/`keyword` are ours, `text` is v1 keyword suggestions, `searchTerm` is the popularity report.
 * @param {any} row
 * @returns {any}
 */
const termOf = (row) => row?.term ?? row?.keyword ?? row?.text ?? row?.searchTerm;

/**
 * v1 reports popularity on three scales. `searchPopularity1to100` is the same 0-100
 * axis `demandTable` already fuses with autocomplete rank, so it reads as `popularity`
 * unchanged. `searchPopularityInGenre` is genre-relative and is the fallback when the
 * absolute column is absent. `searchPopularity1to5` is deliberately not read: on a
 * 0-100 axis a 5 would bury the term under every rank-estimated candidate.
 * @param {any} value
 * @returns {any}
 */
const popularityOf = (value) =>
	typeof value === 'object' && value !== null
		? (value.popularity ?? value.volume ?? value.searchPopularity1to100 ?? value.searchPopularityInGenre)
		: value;

/**
 * WEEKLY_SUN_SAT rows are keyed `week`; MONTHLY rows and our own dumps vary.
 * @param {any} row
 * @returns {string}
 */
const dateOf = (row) => String(row?.week ?? row?.date ?? row?.month ?? '');

/**
 * Accept a hand-written map, an MCP dump, one of our own files, or a raw Apple Ads
 * Platform API v1 response, and return our shape. Popularity is Apple-style 0-100;
 * anything unparseable is dropped rather than defaulted, because a fabricated 50
 * outranks real terms.
 *
 * Two v1 payloads carry popularity and both land here unmodified, because the
 * alternative — a bespoke importer per endpoint — is three parsers for one number:
 *   POST /v1/suggestions/keywords/query           → {result: [{text, popularity}]}
 *   POST /v1/insights/apps/search-term-popularity → {result: {rows: [{searchTerm, …}]}}
 * @param {any} raw
 * @param {string} locale
 * @returns {{generatedAt: string, locale: string, terms: Record<string, {popularity: number, difficulty?: number}>}}
 */
export function normaliseVolume(raw, locale) {
	/** @type {Record<string, {popularity: number, difficulty?: number}>} */
	const terms = {};
	/** @type {Map<string, string>} */
	const dated = new Map();
	/** @param {any} term @param {any} value @param {string} [at] */
	const add = (term, value, at = '') => {
		const key = String(term ?? '').trim().toLocaleLowerCase();
		if (!key) return;
		const popularity = Number(popularityOf(value));
		if (!Number.isFinite(popularity)) return;
		// A multi-week popularity pull repeats every term once per week, and nothing
		// promises the rows arrive in date order. Newest wins; undated rows keep the
		// old last-one-read behaviour.
		const seen = dated.get(key);
		if (seen !== undefined && seen > at) return;
		dated.set(key, at);
		/** @type {{popularity: number, difficulty?: number}} */
		const row = { popularity: Math.max(0, Math.min(100, popularity)) };
		const difficulty = Number(value?.difficulty);
		if (Number.isFinite(difficulty)) row.difficulty = difficulty;
		terms[key] = row;
	};
	const body = unwrapResult(raw);
	const rows = Array.isArray(body) ? body : Array.isArray(body?.terms) ? body.terms : null;
	if (rows) for (const row of rows) add(termOf(row), row, dateOf(row));
	else for (const [term, value] of Object.entries(body?.terms ?? body ?? {})) add(term, value);
	return { generatedAt: new Date().toISOString(), locale, terms };
}

// --- suggest / apply --------------------------------------------------------

/**
 * The shared suggest/apply computation, given the staged listing's data: pack
 * the best terms into the 100-char field and diff against what is authored now.
 * @param {ScoredTerm[]} scored
 * @param {Partial<ListingData>} data
 * @param {string} locale
 * @param {number} minVolume
 */
export function packedProposal(scored, data, locale, minVolume) {
	const alreadyIndexed = `${data.name ?? ''} ${data.subtitle ?? ''}`.trim();
	const packed = packKeywords(scored, { limit: LIMITS.keywords, alreadyIndexed, locale });
	const current = keywordList(data.keywords ?? '');
	const next = packed.keywords ? packed.keywords.split(',') : [];
	const currentLower = new Set(current.map((k) => k.toLocaleLowerCase()));
	const nextLower = new Set(next.map((k) => k.toLocaleLowerCase()));

	return {
		locale,
		name: data.name ?? '',
		subtitle: data.subtitle ?? '',
		current: data.keywords ?? '',
		keywords: packed.keywords,
		used: packed.used,
		limit: packed.limit,
		minVolume,
		covered: coveredTerms(scored, alreadyIndexed, locale),
		added: next.filter((k) => !currentLower.has(k.toLocaleLowerCase())),
		removed: current.filter((k) => !nextLower.has(k.toLocaleLowerCase())),
	};
}

// --- competitors ------------------------------------------------------------

/**
 * Top competitor ids off scored terms, in first-seen order (the `--ids` default).
 * @param {ScoredTerm[]} scored
 * @param {number} [max]
 * @returns {string[]}
 */
export function topCompetitorIds(scored, max = 3) {
	/** @type {Set<string>} */
	const seen = new Set();
	for (const s of scored) {
		for (const t of s.top3 ?? []) if (t.id) seen.add(String(t.id));
		if (seen.size >= max) break;
	}
	return [...seen].slice(0, max);
}

/**
 * The competitor artifact's per-app rows, projected off the iTunes lookup result.
 * @param {StoreApp[]} apps
 */
export function competitorRows(apps) {
	return apps.map((a) => ({
		id: a.trackId,
		name: a.trackName,
		seller: a.sellerName,
		ratings: a.userRatingCount ?? 0,
		stars: a.averageUserRating,
		price: a.price ?? 0,
		genre: a.primaryGenreName,
	}));
}

/**
 * Words the competing apps index, most-shared first.
 * @param {StoreApp[]} apps
 * @param {string} locale
 * @returns {{word: string, apps: number}[]}
 */
export function competitorVocabulary(apps, locale) {
	// The lookup endpoint has no subtitle field, so the marketing subtitle only
	// shows up as the tail of trackName ("Glovebox: Car Maintenance Log").
	/** @type {Map<string, number>} */
	const freq = new Map();
	for (const a of apps)
		for (const w of indexedWords(`${a.trackName ?? ''} ${a.subtitle ?? ''}`, locale))
			freq.set(w, (freq.get(w) ?? 0) + 1);
	return [...freq]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([word, count]) => ({ word, apps: count }));
}

// --- audit findings ---------------------------------------------------------

/** Apple maps audit severity onto a report level; anything unknown reads as a warning. */
/** @type {Record<string, 'fail'|'warn'|undefined>} */
const LEVELS = { error: 'fail', fail: 'fail', failed: 'fail', critical: 'fail', warning: 'warn', warn: 'warn' };

/** Display names for Apple's generated app tags, across raw rows and JSON:API resources. */
/** @type {(rows: any[]) => string[]} */
export const tagNames = (rows) => rows.map((t) => t.name ?? t.displayName ?? t.attributes?.name ?? t.id).filter(Boolean);

/** One report entry per keyword-audit row, with level/name/detail already resolved. */
/** @param {any[]} rows @returns {{level: 'ok'|'warn'|'fail', name: string, detail: string}[]} */
export function auditFindings(rows) {
	return rows.map((/** @type {any} */ row) => ({
		level: LEVELS[String(row.level ?? row.severity ?? row.status ?? '').toLocaleLowerCase()] ?? 'warn',
		name: `asc ${row.locale ?? row.field ?? 'keywords'}`,
		detail: row.message ?? row.detail ?? row.description ?? JSON.stringify(row),
	}));
}

/** The offline keywords lint as report entries: an ok per clean listing, one per problem. */
/** @param {StagedListing[]} staged @returns {{level: 'ok'|'warn'|'fail', name: string, detail: string}[]} */
export function keywordLintFindings(staged) {
	/** @type {{level: 'ok'|'warn'|'fail', name: string, detail: string}[]} */
	const findings = [];
	for (const listing of staged) {
		const problems = lintListing(listing).filter((p) => p.field === 'keywords');
		if (!problems.length) {
			findings.push({
				level: 'ok',
				name: `keywords ${listing.locale}`,
				detail: `${charCount(listing.data.keywords ?? '')}/${LIMITS.keywords} chars`,
			});
			continue;
		}
		for (const p of problems) findings.push({ level: p.level, name: `keywords ${p.locale}`, detail: p.message });
	}
	return findings;
}

// --- stage renderings -------------------------------------------------------

/** Progress belongs on stdout, which --json owns exclusively. */
/** @type {(flags: Flags) => typeof progressLine|undefined} */
export const reporter = (flags) => (flags.json ? undefined : progressLine);

/** Who we tell where the seeds came from, plus the cross-language warning. */
/**
 * @param {Config} cfg
 * @param {{locale: string, market: Market, seeds: string[], origin: string, mismatch: boolean, json: boolean}} ctx
 * @returns {void}
 */
export function announceSeeds(cfg, { locale, market, seeds, origin, mismatch, json }) {
	if (!json) {
		heading(`Harvest ${locale} ${c.dim(`(${market.country})`)}`);
		info(`${seeds.length} seed${seeds.length === 1 ? '' : 's'} from ${origin}: ${c.cyan(seeds.join(', '))}`);
	}
	if (mismatch) {
		warn(`${locale} is being harvested with ${sourceLocale(cfg)} seeds — autocomplete will answer with`);
		warn('translations of your own copy, not the queries locals type');
		note(c.dim(`fix: ship loc seed --locale ${locale}, or set aso.seedsByLocale.${locale}`));
	}
}

/** @typedef {{locale: string, file: string, terms: Record<string, {seeds: string[]}>}} HarvestReport */
/** @param {HarvestReport} out @returns {void} */
export function printHarvest(out) {
	const names = Object.keys(out.terms);
	good(`${names.length} candidate terms → ${c.dim(out.file)}`);
	for (const term of names.slice(0, 15)) note(`${term} ${c.dim(`← ${out.terms[term].seeds.join(', ')}`)}`);
	if (names.length > 15) note(c.dim(`… ${names.length - 15} more`));
	if (!names.length) warn('autocomplete returned nothing — Apple may be throttling; retry in a minute');
	note(c.dim(`next: ship aso score --locale ${out.locale}`));
}

/**
 * @typedef {{popularity?: number, difficulty?: number}} VolumeTerm
 * @typedef {{
 *   locale: string, file: string,
 *   artifact: {locale?: string, generatedAt?: string, source?: string, terms?: Record<string, VolumeTerm>},
 *   template?: boolean, source?: string|null, imported?: number,
 *   floor?: string[], unanswered?: string[], overBudget?: string[], wanted?: number,
 * }} VolumeReport
 */
/** @param {VolumeReport} out @returns {void} */
export function printVolume(out) {
	const rows = Object.entries(out.artifact.terms ?? {}).sort((a, b) => (b[1].popularity ?? 0) - (a[1].popularity ?? 0));
	if (out.template) {
		heading(`No volume data for ${out.locale}`);
		info(`write ${c.dim(out.file)} by hand, or import one with ${c.cyan('--file <f>')}:`);
		process.stdout.write(`\n${JSON.stringify(out.artifact, null, '\t')}\n\n`);
		note(c.dim(`popularity is ${POPULARITY_FLOOR}-100 and overrides the autocomplete-rank estimate for that term`));
	note(c.dim(`or measure it: ${c.cyan('ship aso volume --fetch')} (needs an Apple Ads ad account)`));
		return;
	}
	if (out.source) good(`imported ${out.imported} terms from ${c.dim(out.source)} → ${c.dim(out.file)}`);
	// A floor reading is Apple saying "no data", not "no demand" — recording it
	// would flatten every long-tail term onto one number. Say so rather than
	// leaving the gap between candidates and imported terms unexplained.
	if (out.floor?.length) note(c.dim(`${out.floor.length} terms sit at Apple's floor (${POPULARITY_FLOOR}) — left to the autocomplete-rank estimate`));
	if (out.unanswered?.length) note(c.dim(`${out.unanswered.length} terms Apple would not answer at all`));
	if (out.overBudget?.length) warn(`${out.overBudget.length} terms never asked about — rerun with --max ${out.wanted}`);
	table(rows.slice(0, 25), [
		{ header: 'term', get: (r) => r[0] },
		{ header: 'popularity', get: (r) => String(r[1].popularity ?? '') },
		{ header: 'difficulty', get: (r) => (r[1].difficulty === undefined ? '' : String(r[1].difficulty)) },
	]);
	if (rows.length > 25) note(c.dim(`… ${rows.length - 25} more`));
	note(c.dim(`next: ship aso score --locale ${out.locale}`));
}

/** @typedef {{locale: string, file: string, count: number, scored: ScoredTerm[]}} ScoreReport */
/** @param {ScoreReport} out @returns {void} */
export function printScore(out) {
	heading(`Top ${Math.min(20, out.count)} of ${out.count} — ${out.locale}`);
	table(out.scored.slice(0, 20), [
		{ header: 'keyword', get: (s) => s.keyword },
		{ header: 'opp', get: (s) => String(s.opportunity) },
		{ header: 'demand', get: (s) => `${s.demand}${s.demandSource === 'rank' ? '' : '*'}` },
		{ header: 'comp', get: (s) => String(s.competition) },
		{ header: 'medRatings', get: (s) => String(s.medianRatings) },
		{ header: 'weak/10', get: (s) => String(s.weakAppsTop10) },
		{ header: 'top competitor', get: (s) => s.top3?.[0]?.name ?? '' },
	]);
	note(c.dim('* demand measured from analytics or volume.json rather than autocomplete rank'));
	good(`scored ${out.count} terms → ${c.dim(out.file)}`);
	note(c.dim(`next: ship aso suggest --locale ${out.locale}`));
}

/**
 * @typedef {{locale: string, name?: string, subtitle?: string, keywords: string, limit: number, used: number, covered: string[], added: string[], removed: string[]}} Proposal
 */
/** @param {Proposal} p @returns {void} */
export function printProposal(p) {
	heading(`Keywords for ${p.locale}`);
	if (p.name || p.subtitle) info(`indexed free via listing: ${c.cyan(`${p.name} — ${p.subtitle}`)}`);
	process.stdout.write(`\n  ${c.bold(p.keywords || c.dim('(empty)'))}\n\n`);
	const slack = p.limit - p.used;
	info(`${p.used}/${p.limit} chars${slack ? c.dim(` — ${slack} unused`) : c.green(' — full')}`);
	if (p.covered.length) info(`dropped, already indexed by name/subtitle: ${c.dim(p.covered.join(', '))}`);
	if (p.added.length) note(`${c.green('+')} ${p.added.join(', ')}`);
	if (p.removed.length) note(`${c.red('-')} ${p.removed.join(', ')}`);
	if (!p.added.length && !p.removed.length) good('identical to the current field');
}

/**
 * @param {{locale: string, market: Market, ids: (string|number)[], apps: {name?: string, seller?: string, ratings: number, price?: number, genre?: string}[], vocabulary: {apps: number, word: string}[], file: string}} ctx
 * @returns {number} 1 when the lookup came back empty, so the command exits non-zero
 */
export function printCompetitors({ locale, market, ids, apps, vocabulary, file }) {
	heading(`Competitors ${locale} ${c.dim(`(${market.country})`)}`);
	if (!apps.length) {
		warn(`lookup returned nothing for ${ids.join(', ')}`);
		return 1;
	}
	table(apps, [
		{ header: 'app', get: (a) => a.name ?? '' },
		{ header: 'seller', get: (a) => a.seller ?? '' },
		{ header: 'ratings', get: (a) => String(a.ratings) },
		{ header: 'price', get: (a) => (a.price ? `$${a.price}` : 'free') },
		{ header: 'genre', get: (a) => a.genre ?? '' },
	]);
	heading('Vocabulary they buy');
	for (const v of vocabulary.slice(0, 25)) note(`${c.cyan(String(v.apps))}× ${v.word}`);
	good(`→ ${c.dim(file)}`);
	return 0;
}
