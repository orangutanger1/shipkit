// App Store keyword research: autocomplete harvest + live competition scoring.
//
// Ported and generalised from idea6/research/{locales,harvest,score}.py.
// Apple throttles this hard: four processes at ~3 req/s earned a wall of 403/429
// and scored zero terms for two locales. One request at a time, a floor between
// requests, and a long backoff on refusal is the only version that returns data.
// The throttle is per storefront though — DE refusing us says nothing about JP —
// so the limiter is a map keyed by country and N locales sweep at N req/s, not 1.
// Responses go to a TTL cache on disk because a walled sweep otherwise throws
// away every locale it had already paid for.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { c, note, warn } from '../log.mjs';
import { charCount, indexedWords, isNoSpaceLang, stopwordsFor, words } from './text.mjs';

const HINTS = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
const SEARCH = 'https://itunes.apple.com/search';
const LOOKUP = 'https://itunes.apple.com/lookup';

/** Storefront ids required by the hints endpoint's X-Apple-Store-Front header. */
export const STOREFRONT = {
	US: 143441, GB: 143444, AU: 143460, CA: 143455, FR: 143442, DE: 143443,
	ES: 143454, MX: 143468, BR: 143503, IT: 143450, NL: 143452, PL: 143478,
	JP: 143462, TR: 143480, SA: 143479, KR: 143466, SE: 143456, CZ: 143489,
	HU: 143482, IN: 143467, ID: 143476, RU: 143469, CN: 143465, TW: 143470,
	HK: 143463, TH: 143475, VN: 143471, DK: 143458, NO: 143457, FI: 143447,
	PT: 143453, GR: 143448, RO: 143487, UA: 143492, IL: 143491, AE: 143481,
};

/** ASC locale → { country, lang } for search + hints. */
export const LOCALE_MARKETS = {
	'en-US': { country: 'US', lang: 'en_us' }, 'en-GB': { country: 'GB', lang: 'en_gb' },
	'en-AU': { country: 'AU', lang: 'en_au' }, 'en-CA': { country: 'CA', lang: 'en_ca' },
	'fr-FR': { country: 'FR', lang: 'fr_fr' }, 'fr-CA': { country: 'CA', lang: 'fr_ca' },
	'de-DE': { country: 'DE', lang: 'de_de' }, 'es-ES': { country: 'ES', lang: 'es_es' },
	'es-MX': { country: 'MX', lang: 'es_mx' }, 'pt-BR': { country: 'BR', lang: 'pt_br' },
	'pt-PT': { country: 'PT', lang: 'pt_pt' }, it: { country: 'IT', lang: 'it_it' },
	'nl-NL': { country: 'NL', lang: 'nl_nl' }, pl: { country: 'PL', lang: 'pl_pl' },
	ja: { country: 'JP', lang: 'ja_jp' }, ko: { country: 'KR', lang: 'ko_kr' },
	sv: { country: 'SE', lang: 'sv_se' }, da: { country: 'DK', lang: 'da_dk' },
	no: { country: 'NO', lang: 'nb_no' }, fi: { country: 'FI', lang: 'fi_fi' },
	tr: { country: 'TR', lang: 'tr_tr' }, ru: { country: 'RU', lang: 'ru_ru' },
	'ar-SA': { country: 'SA', lang: 'ar_sa' }, hi: { country: 'IN', lang: 'hi_in' },
	id: { country: 'ID', lang: 'id_id' }, th: { country: 'TH', lang: 'th_th' },
	vi: { country: 'VN', lang: 'vi_vn' }, 'zh-Hans': { country: 'CN', lang: 'zh_cn' },
	'zh-Hant': { country: 'TW', lang: 'zh_tw' }, cs: { country: 'CZ', lang: 'cs_cz' },
	hu: { country: 'HU', lang: 'hu_hu' }, el: { country: 'GR', lang: 'el_gr' },
	ro: { country: 'RO', lang: 'ro_ro' }, uk: { country: 'UA', lang: 'uk_ua' },
	he: { country: 'IL', lang: 'he_il' },
};

export function marketFor(locale) {
	return LOCALE_MARKETS[locale] ?? LOCALE_MARKETS[locale?.split('-')[0]] ?? null;
}

/** Suggestions that are an app's marketed name rather than a query people type. */
const BRANDY = /[:：]|—|·|\bapp\b|\bpro$/i;
const STOP_SUFFIX = /\b(free|pro|app|apps)\s*$/i;

export const MIN_INTERVAL_MS = 1000;
const BACKOFF_MS = 20_000;

/** country → { last, until }. One gate per storefront, because that is how Apple counts. */
const gates = new Map();

export function gateFor(country) {
	let gate = gates.get(country);
	if (!gate) gates.set(country, (gate = { last: 0, until: 0 }));
	return gate;
}

/** ms one storefront still owes: its own request floor, or the rest of its own backoff. */
export const gateWait = (gate, now) => Math.max(gate.until - now, MIN_INTERVAL_MS - (now - gate.last));

/** Apple stopped answering for one storefront; the caller must save its work, not log zeros. */
export class StorefrontWall extends Error {
	constructor(country) {
		super(`App Store refused ${country} after ${BACKOFF_MS / 1000}s backoff (403/429)`);
		this.name = 'StorefrontWall';
		this.country = country;
	}
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const CACHE_TTL_MS = 7 * DAY_MS;

// Off until a command points it at a repo: a library has no business writing
// into whatever directory the process happens to have been started in.
let cache = { dir: null, ttl: CACHE_TTL_MS, read: false, write: false };

/**
 * Enable the on-disk response cache.
 * @param {{dir: string, ttlMs?: number, mode?: 'on'|'refresh'|'off'}} opts
 *   `refresh` re-fetches but still repopulates, so a wall mid-sweep is cheap to resume.
 */
export function useCache({ dir, ttlMs = CACHE_TTL_MS, mode = 'on' } = {}) {
	const off = mode === 'off' || !dir;
	cache = { dir: off ? null : dir, ttl: ttlMs, read: !off && mode === 'on', write: !off };
}

function cacheFile(endpoint, term, country) {
	const hash = createHash('sha1').update(`${endpoint}\n${term}\n${country}`).digest('hex').slice(0, 16);
	return join(cache.dir, country, `${endpoint}-${hash}.json`);
}

async function cacheRead(file) {
	try {
		const entry = JSON.parse(await readFile(file, 'utf8'));
		if (Date.now() - entry.at > cache.ttl) return null;
		return typeof entry.body === 'string' ? entry.body : null;
	} catch {
		return null;
	}
}

async function cacheWrite(file, meta, body) {
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ at: Date.now(), ...meta, body }));
	} catch {
		// A cache that cannot write is slow, not broken.
	}
}

/**
 * One HTTP GET, gated per storefront and cached on disk.
 * @param {string} url
 * @param {{headers?: object, country?: string, endpoint?: string, term?: string, tries?: number, hard?: boolean}} opts
 *   `endpoint`+`term` opt the call into the cache; `hard` throws {@link StorefrontWall}
 *   on refusal instead of returning null, for sweeps that must stop and save.
 */
async function throttledFetch(url, { headers = {}, country = 'US', endpoint, term, tries = 5, hard = false } = {}) {
	const file = endpoint && cache.dir ? cacheFile(endpoint, term ?? '', country) : null;
	if (file && cache.read) {
		const hit = await cacheRead(file);
		if (hit !== null) return hit;
	}
	const gate = gateFor(country);
	for (let attempt = 0; attempt < tries; attempt++) {
		const now = Date.now();
		const wait = gateWait(gate, now);
		if (wait > 0) await sleep(wait);
		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': 'iTunes-iPhone/12.0 (5; 16GB)', ...headers },
				signal: AbortSignal.timeout(25_000),
			});
			gate.last = Date.now();
			if (res.status === 429 || res.status === 403) {
				gate.until = gate.last + BACKOFF_MS;
				if (attempt === tries - 1) {
					if (hard) throw new StorefrontWall(country);
					return null;
				}
				continue;
			}
			if (!res.ok) {
				if (attempt === tries - 1) return null;
				await sleep(3000);
				continue;
			}
			const body = await res.text();
			if (file && cache.write) await cacheWrite(file, { endpoint, term, country }, body);
			return body;
		} catch (err) {
			if (err instanceof StorefrontWall) throw err;
			gate.last = Date.now();
			if (attempt === tries - 1) {
				warn(`request failed: ${err.message}`);
				return null;
			}
			await sleep(3000);
		}
	}
	return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Live App Store autocomplete suggestions for a prefix, in Apple's own order.
 * That order is the ranking signal {@link demand} reads — never sort it.
 */
export async function hints(term, country = 'US', { hard = false } = {}) {
	const storefront = STOREFRONT[country];
	if (!storefront) return [];
	const url = `${HINTS}?${new URLSearchParams({ clientApplication: 'Software', term, country })}`;
	const body = await throttledFetch(url, {
		headers: { 'X-Apple-Store-Front': `${storefront}-1,29` },
		country,
		endpoint: 'hints',
		term,
		hard,
	});
	if (!body) return [];
	return [...body.matchAll(/<key>term<\/key>\s*<string>(.*?)<\/string>/gs)].map((m) =>
		m[1].replaceAll('&amp;', '&').trim(),
	);
}

/** The seed plus two truncations, so autocomplete has room to complete. */
function* stems(seed) {
	yield seed;
	if (seed.length > 6) yield seed.slice(0, -2);
	if (seed.length > 9) yield seed.slice(0, -4);
}

/** @typedef {{seeds: string[], rank: number, stemDepth: number}} Candidate */

const candidates = (found) =>
	Object.fromEntries(
		[...found].map(([term, e]) => [term, { seeds: [...e.seeds].sort(), rank: e.rank, stemDepth: e.stemDepth }]),
	);

/**
 * Sweep autocomplete for every seed, keeping Apple's ordering.
 * `rank` is the best (lowest) 0-based position the term ever held in a hint
 * response and `stemDepth` whether it took the full seed (0) or a truncation
 * to surface it — both are demand signal the old Record<term, seeds[]> threw away.
 *
 * On a storefront wall the partial harvest is handed to `onPartial` before the
 * error propagates, so a locale that died at seed 9 of 12 still ships 9 seeds.
 * @param {string[]} seeds
 * @param {string} country
 * @param {{onProgress?: Function, onPartial?: (terms: Record<string, Candidate>) => any}} [opts]
 * @returns {Promise<Record<string, Candidate>>} term → candidate
 */
export async function harvest(seeds, country = 'US', { onProgress, onPartial } = {}) {
	const found = new Map();
	let i = 0;
	try {
		for (const seed of seeds) {
			let depth = 0;
			for (const stem of stems(seed)) {
				const suggestions = await hints(stem, country, { hard: true });
				for (const [rank, term] of suggestions.entries()) {
					if (BRANDY.test(term)) continue;
					const key = term.toLocaleLowerCase();
					const entry = found.get(key) ?? { seeds: new Set(), rank, stemDepth: depth };
					entry.seeds.add(seed);
					if (rank < entry.rank) {
						entry.rank = rank;
						entry.stemDepth = depth;
					}
					found.set(key, entry);
				}
				depth++;
				await sleep(300);
			}
			onProgress?.(++i, seeds.length, seed, found.size);
		}
	} catch (err) {
		err.partial = candidates(found);
		await onPartial?.(err.partial);
		throw err;
	}
	return candidates(found);
}

/** Drop brand names and malformed phrases; keep 1-4 word queries a human would type. */
export function pickCandidates(terms, { minWords = 1, maxWords = 4, exclude = [] } = {}) {
	const noise = exclude.length ? new RegExp(exclude.join('|'), 'i') : null;
	const out = new Set();
	for (const raw of terms) {
		const t = raw.replaceAll('&amp;', '&').trim().toLocaleLowerCase();
		if (!t || noise?.test(t)) continue;
		if (t.includes('&') || t.includes(':')) continue;
		const parts = t.split(/\s+/);
		if (parts.length < minWords || parts.length > maxWords) continue;
		if (STOP_SUFFIX.test(t)) continue;
		out.add(t);
	}
	return [...out].sort();
}

/** Seeds of a candidate, tolerating the legacy `term: string[]` artifact shape. */
const seedsOf = (entry) => (Array.isArray(entry) ? entry : (entry?.seeds ?? []));
const rankOf = (entry) => (Array.isArray(entry) || typeof entry?.rank !== 'number' ? null : entry.rank);
const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Ordinal demand for one harvested term, 0-100.
 *
 * Apple orders autocomplete by popularity, so the position a term holds is a
 * free volume proxy, and a term several different seeds surface is a hub term
 * rather than a long-tail accident. A legacy artifact carries no rank at all;
 * those get the neutral middle so seed count still orders them.
 * @param {Candidate|string[]} entry
 * @param {{maxRank?: number}} [opts] worst rank observed in this harvest
 */
export function demand(entry, { maxRank = 12 } = {}) {
	const rank = rankOf(entry);
	const position = rank === null ? 0.5 : Math.max(0, 1 - rank / (Math.max(maxRank, 1) + 1));
	const hub = 1 - 1 / (1 + Math.log2(1 + seedsOf(entry).length));
	return clamp100(100 * (0.75 * position + 0.25 * hub));
}

/**
 * Measured impressions beat every heuristic. `.asc/analytics/<locale>-terms.json`
 * is log-scaled against its own busiest term, so 0 impressions means 0 demand —
 * a term real users never typed is not an opportunity, it is a guess we disproved.
 */
function measuredDemand(analytics) {
	const out = new Map();
	const rows = analytics?.rows ?? [];
	const max = Math.max(0, ...rows.map((r) => Number(r.impressions) || 0));
	if (!max) return out;
	const top = Math.log10(1 + max);
	for (const row of rows) {
		if (!row?.term) continue;
		out.set(String(row.term).toLocaleLowerCase(), clamp100((100 * Math.log10(1 + (Number(row.impressions) || 0))) / top));
	}
	return out;
}

/**
 * Demand for every harvested term, 0-100, by source precedence:
 * measured impressions > hand/MCP volume file > autocomplete rank.
 * @param {Record<string, Candidate|string[]>} terms
 * @param {{volume?: object, analytics?: object}} [sources]
 * @returns {Map<string, {demand: number, source: 'analytics'|'volume'|'rank', difficulty?: number}>}
 */
export function demandTable(terms, { volume = null, analytics = null } = {}) {
	const entries = Object.entries(terms ?? {});
	const ranks = entries.map(([, e]) => rankOf(e)).filter((r) => r !== null);
	const maxRank = Math.max(10, ...ranks);
	const measured = measuredDemand(analytics);
	const out = new Map();
	for (const [term, entry] of entries) {
		const key = term.toLocaleLowerCase();
		const known = volume?.terms?.[term] ?? volume?.terms?.[key];
		const popularity = typeof known === 'number' ? known : known?.popularity;
		const difficulty = typeof known?.difficulty === 'number' ? known.difficulty : undefined;
		const seen = measured.get(key);
		if (seen !== undefined) out.set(term, { demand: seen, source: 'analytics', difficulty });
		else if (typeof popularity === 'number') out.set(term, { demand: clamp100(popularity), source: 'volume', difficulty });
		else out.set(term, { demand: demand(entry, { maxRank }), source: 'rank', difficulty });
	}
	return out;
}

export async function topResults(term, { country = 'US', lang = 'en_us', limit = 10 } = {}) {
	const url = `${SEARCH}?${new URLSearchParams({ term, country, lang, entity: 'software', limit: String(limit) })}`;
	const body = await throttledFetch(url, { country, endpoint: `search-${lang}-${limit}`, term });
	if (!body) return null;
	try {
		return JSON.parse(body).results ?? [];
	} catch {
		return null;
	}
}

function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Whole days since an ISO timestamp; null when the storefront gave us nothing to date. */
export function ageInDays(iso, now = Date.now()) {
	const t = Date.parse(iso ?? '');
	return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
}

/**
 * Release-date flood detection for one keyword's live top-10.
 *
 * Competition scoring reads review counts, and by that measure a keyword whose
 * top-10 is ten three-week-old apps with nine ratings each looks *ideal*: weak
 * incumbents, no moat. That is exactly the shape of a category twenty other
 * people shipped into last month after the same "high volume, low competition"
 * sweep pointed them at the same phrase. Glovebox launched into
 * "car maintenance log" and found a 1:1 clone — same feature set, same privacy
 * angle, even the same brand word — released weeks earlier.
 *
 * Weak *and old* is a real gap: incumbents had years and never earned reviews.
 * Weak *and new* is a stampede, and the reviews that decide next quarter's
 * ranking have not been written yet by anyone.
 *
 * `clones` is the sharpest of these numbers and the one that names the failure:
 * an app whose *title is the query*, that shipped inside `freshDays` and never
 * earned `tractionFloor` ratings, is the artifact of somebody else running this
 * exact pipeline. `car maintenance log` returns three of them — Vehix,
 * Steerlog, "Car Maintenance Log - Service", on 3, 0 and 0 ratings — beside
 * two 2012-era incumbents that keep the blended average respectable. Averages
 * hide that; a count does not.
 *
 * The window is a year, not a quarter: the wave that produces these does not
 * finish in ninety days, and an app from eleven months ago with two ratings is
 * still competing for the phrase you were going to buy.
 * @param {object[]} results live top-10 from {@link topResults}
 * @param {{term?:string, now?:number, freshDays?:number, tractionFloor?:number}} [opts]
 */
export function saturation(results, { term = '', now = Date.now(), freshDays = 365, tractionFloor = 25 } = {}) {
	if (!results?.length) return null;
	const needle = term.toLocaleLowerCase();
	const rows = results.map((r) => ({
		name: r.trackName ?? null,
		seller: r.sellerName ?? null,
		ratings: r.userRatingCount ?? 0,
		released: (r.releaseDate ?? '').slice(0, 10) || null,
		ageDays: ageInDays(r.releaseDate, now),
		titleMatch: needle ? (r.trackName ?? '').toLocaleLowerCase().includes(needle) : false,
	}));
	const n = rows.length;
	// An unknown release date is not evidence of a flood; it is excluded from
	// the ratio rather than counted as old, so a lookup gap cannot fake a pass.
	const dated = rows.filter((r) => r.ageDays !== null);
	const fresh = dated.filter((r) => r.ageDays <= freshDays);
	const quarter = dated.filter((r) => r.ageDays <= 90);
	const freshUnproven = fresh.filter((r) => r.ratings < tractionFloor);
	const clones = fresh.filter((r) => r.titleMatch);
	// Title = the query, shipped inside the window, and still unused. All three
	// matter: an app named after the query that is four years old with three
	// ratings is a dead category, not a stampede, and an undated row is not
	// evidence of either.
	const pipelineClones = fresh.filter((r) => r.titleMatch && r.ratings < tractionFloor);
	const denom = dated.length || n;

	const entrantShare = fresh.length / denom;
	const unprovenShare = freshUnproven.length / denom;
	const cloneShare = pipelineClones.length / n;
	return {
		results: n,
		dated: dated.length,
		freshDays,
		tractionFloor,
		newEntrants: fresh.length,
		newEntrantsQuarter: quarter.length,
		freshUnproven: freshUnproven.length,
		cloneTitles: clones.length,
		clones: pipelineClones.length,
		cloneApps: pipelineClones.map((r) => r.name),
		medianAgeDays: median(dated.map((r) => r.ageDays)),
		youngestDays: dated.length ? Math.min(...dated.map((r) => r.ageDays)) : null,
		distinctSellers: new Set(rows.map((r) => r.seller).filter(Boolean)).size,
		// Fresh entrants dominate; fresh-and-traction-less weigh more because that
		// is the vibecoded shape; and an app already named after the query is the
		// heaviest signal of all, because it is the app you were about to build.
		score: clamp100(100 * (0.3 * entrantShare + 0.3 * unprovenShare + 0.4 * cloneShare)),
		apps: rows,
	};
}

/**
 * Competition metrics for one keyword against its live top-10, fused with demand.
 *
 * `competition` (0-100) is the supply side alone: high = weak incumbents, few
 * exact-title matches, low review moat. `demand` (0-100) is how many people
 * actually type this, and the product `opportunity = demand/100 × competition`
 * is deliberate: an uncontested keyword nobody searches is worth nothing, so
 * demand 0 zeroes the term. But a keyword can score high on both and still be a
 * trap, so `saturation` (see {@link saturation}) measures how much of that
 * weakness is a fresh stampede rather than a durable gap, and `viability =
 * opportunity × (1 − saturation/100)` is what the sweep ranks by. `opportunity`
 * is unmodified because it is the number every earlier artifact recorded.
 * @param {string} term
 * @param {object[]} results live top-10 from {@link topResults}
 * @param {{demand?: number, now?: number}} [opts] demand 0-100; omitted means "unknown", i.e. no discount
 */
export function score(term, results, { demand: demandScore = 100, now = Date.now() } = {}) {
	if (!results?.length) return null;
	const titles = results.map((r) => (r.trackName ?? '').toLocaleLowerCase());
	const counts = results.map((r) => r.userRatingCount ?? 0);
	const exact = titles.filter((t) => t.includes(term)).length;
	const weak = counts.filter((n) => n < 1000).length;
	const med = median(counts);

	// Each term is 0-1, higher = easier to rank for.
	const weakness = weak / results.length;
	const moat = 1 - Math.min(1, Math.log10(Math.max(med, 1)) / 5); // 100k+ median reviews → 0
	const crowding = 1 - Math.min(1, exact / 5); // 5+ exact-title matches → 0
	const competition = Math.round(100 * (0.4 * weakness + 0.35 * moat + 0.25 * crowding));
	const demandValue = clamp100(demandScore);
	const flood = saturation(results, { term, now });
	const opportunity = Math.round((demandValue / 100) * competition);

	return {
		keyword: term,
		results: results.length,
		exactTitleMatches: exact,
		medianRatings: med,
		maxRatings: Math.max(...counts),
		weakAppsTop10: weak,
		paidTop10: results.filter((r) => (r.price ?? 0) > 0).length,
		competition,
		demand: demandValue,
		opportunity,
		saturation: flood.score,
		clones: flood.clones,
		newEntrants: flood.newEntrants,
		freshUnproven: flood.freshUnproven,
		medianAgeDays: flood.medianAgeDays,
		viability: Math.round(opportunity * (1 - flood.score / 100)),
		top3: results.slice(0, 3).map((r) => ({
			name: r.trackName,
			id: r.trackId,
			ratings: r.userRatingCount ?? 0,
			stars: r.averageUserRating,
			seller: r.sellerName,
		})),
	};
}

/**
 * Score many keywords sequentially (one storefront, so one request at a time).
 * @param {string[]} terms
 * @param {{country: string, lang: string}} market
 * @param {{onProgress?: Function, demands?: Map<string, any>|Record<string, any>}} [opts]
 *   `demands` takes a plain 0-100 number or a {@link demandTable} row per term.
 */
export async function scoreAll(terms, market, { onProgress, demands } = {}) {
	const demandOf = (term) => {
		const row = demands instanceof Map ? demands.get(term) : demands?.[term];
		return typeof row === 'object' && row !== null ? row.demand : row;
	};
	const out = [];
	let i = 0;
	for (const term of terms) {
		const results = await topResults(term, market);
		const known = demandOf(term);
		const s = score(term, results, typeof known === 'number' ? { demand: known } : {});
		if (s) out.push(s);
		onProgress?.(++i, terms.length, term, s?.viability);
	}
	// Viability first: a flooded term with a great opportunity score is the trap
	// this sweep exists to avoid handing back as row one.
	return out.sort((a, b) => b.viability - a.viability || b.opportunity - a.opportunity);
}

/** Look up apps by App Store id — used to mine competitor listings. */
export async function lookup(ids, { country = 'US' } = {}) {
	const id = [].concat(ids).join(',');
	const url = `${LOOKUP}?${new URLSearchParams({ id, country, entity: 'software' })}`;
	const body = await throttledFetch(url, { country, endpoint: 'lookup', term: id });
	if (!body) return [];
	try {
		return JSON.parse(body).results ?? [];
	} catch {
		return [];
	}
}

/**
 * Does a brand name already exist on the storefront?
 *
 * "Glovebox" read as an unused word for a car app; the storefront already had
 * `Car Maintenance Log - Glovebox`, which searching the *category* never
 * surfaces because the collision lives in a suffix. Whole-word matching is the
 * point: `Glovebox` collides with `... - Glovebox`, not with `Gloveboxes Inc`
 * substring noise, and an exact title equality is a different severity.
 * @param {string} name candidate brand word(s)
 * @param {object[]} results search results for that name
 * @param {{now?:number}} [opts]
 */
export function brandCollisions(name, results, { now = Date.now() } = {}) {
	const needle = String(name).trim().toLocaleLowerCase();
	if (!needle) return [];
	const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu');
	const out = [];
	for (const r of results ?? []) {
		const title = (r.trackName ?? '').toLocaleLowerCase();
		if (!bounded.test(title)) continue;
		out.push({
			name: r.trackName ?? null,
			id: r.trackId ?? null,
			seller: r.sellerName ?? null,
			ratings: r.userRatingCount ?? 0,
			released: (r.releaseDate ?? '').slice(0, 10) || null,
			ageDays: ageInDays(r.releaseDate, now),
			exact: title === needle,
			url: r.trackViewUrl ?? null,
		});
	}
	return out.sort((a, b) => Number(b.exact) - Number(a.exact) || b.ratings - a.ratings);
}

/**
 * Pack keywords into ASC's 100-char comma-separated field, highest value first.
 * Terms already covered by name/subtitle are dropped: Apple indexes those anyway.
 *
 * Locale-aware on both axes, because neither default is right outside English:
 * `カレンダー予定` is two tokens and no spaces, and the limit counts code points,
 * so a whitespace split plus `String.length` overspends a Japanese field twice over.
 */
export function packKeywords(scored, { limit = 100, alreadyIndexed = '', locale = 'en' } = {}) {
	const indexed = indexedWords(alreadyIndexed, locale);
	// The field is tokenised on commas AND spaces, so a multi-word phrase only
	// needs its unseen words; Apple recombines them at query time.
	const minLength = isNoSpaceLang(locale) ? 1 : 2;
	const chosen = [];
	const used = new Set([...indexed, ...stopwordsFor(locale)]);
	let length = 0;
	for (const entry of scored) {
		const term = typeof entry === 'string' ? entry : entry.keyword;
		for (const word of words(term, locale)) {
			if (used.has(word) || charCount(word) < minLength) continue;
			const cost = (length ? 1 : 0) + charCount(word);
			if (length + cost > limit) continue;
			used.add(word);
			chosen.push(word);
			length += cost;
		}
	}
	return { keywords: chosen.join(','), used: length, limit, dropped: indexed.size };
}

export function progressLine(i, total, label, extra) {
	const pct = String(Math.round((100 * i) / total)).padStart(3);
	note(`${c.dim(`[${pct}%]`)} ${label}${extra !== undefined ? c.dim(` → ${extra}`) : ''}`);
}
