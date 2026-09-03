// iTunes/App Store HTTP client: per-storefront throttle, disk TTL cache, retry.
//
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
import { warn } from '../log.mjs';

const HINTS = 'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints';
const SEARCH = 'https://itunes.apple.com/search';
const LOOKUP = 'https://itunes.apple.com/lookup';

/** Storefront ids required by the hints endpoint's X-Apple-Store-Front header. */
const STOREFRONT = {
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

export const MIN_INTERVAL_MS = 1000;
const BACKOFF_MS = 20_000;

/** The two statuses Apple refuses with; everything else is a plain retry. */
const REFUSED = new Set([403, 429]);

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
 * @param {{headers?: object, country?: string, endpoint?: string, term?: string, tries?: number, hard?: boolean, bytes?: boolean}} opts
 *   `endpoint`+`term` opt the call into the cache; `hard` throws {@link StorefrontWall}
 *   on refusal instead of returning null, for sweeps that must stop and save.
 *   `bytes` returns a Buffer and skips the cache: screenshots are committed as
 *   research assets, so a second copy under .cache buys nothing.
 * @returns {Promise<any>} body, or null when Apple never answered
 */
export async function throttledFetch(url, { headers = {}, country = 'US', endpoint, term, tries = 5, hard = false, bytes = false } = {}) {
	const file = endpoint && cache.dir && !bytes ? cacheFile(endpoint, term ?? '', country) : null;
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
			if (REFUSED.has(res.status)) {
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
			if (bytes) return Buffer.from(await res.arrayBuffer());
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
 * That order is the ranking signal {@link import('./appstore-score.mjs').demand} reads — never sort it.
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

/** Suggestions that are an app's marketed name rather than a query people type. */
const BRANDY = /[:：]|—|·|\bapp\b|\bpro$/i;

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
