// App Store keyword research: autocomplete harvest + live competition scoring.
//
// Ported and generalised from idea6/research/{locales,harvest,score}.py.
// Apple throttles this hard: four processes at ~3 req/s earned a wall of 403/429
// and scored zero terms for two locales. One request at a time, a floor between
// requests, and a long backoff on refusal is the only version that returns data.
import { c, note, warn } from '../log.mjs';

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

const MIN_INTERVAL_MS = 1000;
let lastRequest = 0;

async function throttledFetch(url, headers = {}, tries = 5) {
	for (let attempt = 0; attempt < tries; attempt++) {
		const wait = MIN_INTERVAL_MS - (Date.now() - lastRequest);
		if (wait > 0) await sleep(wait);
		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': 'iTunes-iPhone/12.0 (5; 16GB)', ...headers },
				signal: AbortSignal.timeout(25_000),
			});
			lastRequest = Date.now();
			if (res.status === 429 || res.status === 403) {
				if (attempt === tries - 1) return null;
				await sleep(20_000);
				continue;
			}
			if (!res.ok) {
				if (attempt === tries - 1) return null;
				await sleep(3000);
				continue;
			}
			return await res.text();
		} catch (err) {
			lastRequest = Date.now();
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

/** Live App Store autocomplete suggestions for a prefix. */
export async function hints(term, country = 'US') {
	const storefront = STOREFRONT[country];
	if (!storefront) return [];
	const url = `${HINTS}?${new URLSearchParams({ clientApplication: 'Software', term, country })}`;
	const body = await throttledFetch(url, { 'X-Apple-Store-Front': `${storefront}-1,29` });
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

/**
 * Sweep autocomplete for every seed.
 * @returns {Promise<Record<string, string[]>>} term → seeds that surfaced it
 */
export async function harvest(seeds, country = 'US', { onProgress } = {}) {
	const found = new Map();
	let i = 0;
	for (const seed of seeds) {
		for (const stem of stems(seed)) {
			for (const term of await hints(stem, country)) {
				if (BRANDY.test(term)) continue;
				const key = term.toLocaleLowerCase();
				if (!found.has(key)) found.set(key, new Set());
				found.get(key).add(seed);
			}
			await sleep(300);
		}
		onProgress?.(++i, seeds.length, seed, found.size);
	}
	return Object.fromEntries([...found].map(([t, s]) => [t, [...s].sort()]));
}

/** Drop brand names and malformed phrases; keep 1-4 word queries a human would type. */
export function pickCandidates(terms, { minWords = 1, maxWords = 4, exclude = [] } = {}) {
	const noise = exclude.length ? new RegExp(exclude.join('|'), 'i') : null;
	const out = new Set();
	for (const raw of terms) {
		const t = raw.replaceAll('&amp;', '&').trim().toLocaleLowerCase();
		if (!t || noise?.test(t)) continue;
		if (t.includes('&') || t.includes(':')) continue;
		const words = t.split(/\s+/);
		if (words.length < minWords || words.length > maxWords) continue;
		if (STOP_SUFFIX.test(t)) continue;
		out.add(t);
	}
	return [...out].sort();
}

export async function topResults(term, { country = 'US', lang = 'en_us', limit = 10 } = {}) {
	const url = `${SEARCH}?${new URLSearchParams({ term, country, lang, entity: 'software', limit: String(limit) })}`;
	const body = await throttledFetch(url);
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

/**
 * Competition metrics for one keyword against its live top-10.
 * `opportunity` (0-100) is the ranking signal: high = weak incumbents,
 * few exact-title matches, low review moat. This is the number to sort by.
 */
export function score(term, results) {
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
	const opportunity = Math.round(100 * (0.4 * weakness + 0.35 * moat + 0.25 * crowding));

	return {
		keyword: term,
		results: results.length,
		exactTitleMatches: exact,
		medianRatings: med,
		maxRatings: Math.max(...counts),
		weakAppsTop10: weak,
		paidTop10: results.filter((r) => (r.price ?? 0) > 0).length,
		opportunity,
		top3: results.slice(0, 3).map((r) => ({
			name: r.trackName,
			id: r.trackId,
			ratings: r.userRatingCount ?? 0,
			stars: r.averageUserRating,
			seller: r.sellerName,
		})),
	};
}

/** Score many keywords sequentially (throttling is global). */
export async function scoreAll(terms, market, { onProgress } = {}) {
	const out = [];
	let i = 0;
	for (const term of terms) {
		const results = await topResults(term, market);
		const s = score(term, results);
		if (s) out.push(s);
		onProgress?.(++i, terms.length, term, s?.opportunity);
	}
	return out.sort((a, b) => b.opportunity - a.opportunity);
}

/** Look up apps by App Store id — used to mine competitor listings. */
export async function lookup(ids, { country = 'US' } = {}) {
	const url = `${LOOKUP}?${new URLSearchParams({ id: [].concat(ids).join(','), country, entity: 'software' })}`;
	const body = await throttledFetch(url);
	if (!body) return [];
	try {
		return JSON.parse(body).results ?? [];
	} catch {
		return [];
	}
}

/**
 * Pack keywords into ASC's 100-char comma-separated field, highest value first.
 * Terms already covered by name/subtitle are dropped: Apple indexes those anyway.
 */
export function packKeywords(scored, { limit = 100, alreadyIndexed = '' } = {}) {
	const indexed = new Set(
		alreadyIndexed
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 2),
	);
	// The field is tokenised on commas AND spaces, so a multi-word phrase only
	// needs its unseen words; Apple recombines them at query time.
	const chosen = [];
	const used = new Set(indexed);
	let length = 0;
	for (const entry of scored) {
		const term = typeof entry === 'string' ? entry : entry.keyword;
		for (const word of term.split(/\s+/)) {
			const key = word.toLocaleLowerCase();
			if (used.has(key) || key.length < 2) continue;
			const cost = (length ? 1 : 0) + word.length;
			if (length + cost > limit) continue;
			used.add(key);
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
