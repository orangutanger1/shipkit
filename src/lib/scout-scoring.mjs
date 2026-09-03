// scout-scoring — the pure half of `ship scout`: the go/no-go gates, the CPI
// band, and the listing drafts the evidence feeds. Nothing in this module
// reads a config, a credential, a repo or the network, so the thresholds —
// which are the product decision — get unit tests instead of a live
// storefront at 1 req/s. The storefront and filesystem half lives in
// lib/storefront-scout.mjs; the subcommands that print stay in
// commands/scout.mjs.
import { createHash } from 'node:crypto';
import { packKeywords } from './appstore.mjs';
import { round2 } from './fmt.mjs';
import { normaliseKeywords } from './locales.mjs';
import { brandTokens, charCount, indexedWords, stopwordsFor, tokenSupport, words } from './text.mjs';
import { median } from './util.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').Flags} Flags */

/**
 * One iTunes search/lookup row, narrowed to the fields scout reads. The
 * payload is unvalidated JSON off the storefront API, so every field is
 * optional and nullable; consumers read through `??` fallbacks.
 * @typedef {{
 *   trackName?: string|null, sellerName?: string|null, trackId?: number|null,
 *   userRatingCount?: number|null, averageUserRating?: number|null,
 *   price?: number|null, formattedPrice?: string|null,
 *   currentVersionReleaseDate?: string|null, trackViewUrl?: string|null,
 *   description?: string|null,
 * }} ScoutApp
 */

/** Shape of the progress callback sweeps hand to the storefront layer. */
/** @typedef {(i: number, total: number, label: string, extra?: Json) => void} ProgressFn */

/**
 * The gate thresholds, as `verdict` reads them: every cap a flag can move.
 * @typedef {{
 *   moat: number, minVolume: number, exactCap: number,
 *   saturationCap: number, cloneCap: number, commodityCap: number,
 * }} GateThresholds
 */

/**
 * The metrics block the gates read — everything `brief` can say about one
 * term's top-10 in numbers. The six gate metrics are required; the rest is
 * the context the messages print.
 * @typedef {{
 *   term: string, results: number, demand: number, exactTitleMatches: number,
 *   top3MedianRatings: number, freeTop10: number,
 *   weakAppsTop10: number, medianRatings: number, paidTop10: number, iapTop3: number,
 *   saturation: number, newEntrants: number, freshUnproven: number,
 *   cloneTitles: number, clones: number, cloneApps: (string|null)[], freshDays: number,
 *   commodity: number, commodityMatches: number, commodityProven: number,
 *   commodityApps: (string|null)[],
 * }} VerdictMetrics
 */

/** One tripped gate: the number that tripped it and the threshold it beat. */
/** @typedef {{gate: string, value: number, threshold: number, message: string}} VerdictReason */

/** @typedef {{go: boolean, reasons: VerdictReason[]}} VerdictResult */

/**
 * One row of the gate table: the test that fires, the metric that tripped,
 * the threshold it beat, and the message that prints both numbers.
 * @typedef {{
 *   gate: string,
 *   metric: 'top3MedianRatings'|'demand'|'exactTitleMatches'|'saturation'|'clones'|'commodity',
 *   flag: (t: GateThresholds) => number,
 *   test: (m: VerdictMetrics, t: GateThresholds) => boolean,
 *   message: (m: VerdictMetrics, t: GateThresholds) => string,
 * }} Gate
 */

/** What a paid install may cost before Search Ads stops paying for itself. */
/** @typedef {{
 *   subPrice: number, netPerMonth: number, assumedMonthsRetained: number, ltv: number,
 *   installToSubscriber: {low: number, high: number}, cpi: {low: number, high: number},
 *   derivation: string,
 * }} CpiBand */

/**
 * One scored row of a terms sweep, as `scoreAll` ranks them (viability first).
 * `top3` rides along so a prior sweep can be mined for incumbent names.
 * @typedef {{
 *   keyword: string, results: number, demand: number, competition: number,
 *   opportunity: number, viability: number, saturation: number, clones: number,
 *   medianRatings: number, exactTitleMatches: number, newEntrants: number,
 *   weakAppsTop10: number, paidTop10: number,
 *   top3?: {name: string|null, id: number|null, ratings: number, stars: number|null, seller: string|null}[],
 * }} ScoredTerm
 */

/** One row of the top-10 as the flood check scored it. */
/** @typedef {{name: string|null, seller: string|null, ratings: number, released: string|null, ageDays: number|null, titleMatch: boolean}} FloodApp */

/**
 * The flood block `saturation()` returns for a non-empty top-10.
 * @typedef {{
 *   results: number, dated: number, freshDays: number, tractionFloor: number,
 *   newEntrants: number, newEntrantsQuarter: number, freshUnproven: number,
 *   cloneTitles: number, clones: number, cloneApps: (string|null)[],
 *   medianAgeDays: number|null, youngestDays: number|null, distinctSellers: number,
 *   score: number, apps: FloodApp[],
 * }} Flood
 */

/** One incumbent the same-product check matched. */
/** @typedef {{name: string|null, ratings: number}} CommodityApp */

/**
 * The same-product block `commodity()` returns for a non-empty top-10.
 * @typedef {{
 *   results: number, matches: number, share: number, proven: number, unproven: number,
 *   subjects: string[], apps: CommodityApp[],
 * }} Commodity
 */

/** One top-3 incumbent as `incumbentsOf` annotates it. */
/** @typedef {{
 *   name: string|null, id: number|null, seller: string|null, ratings: number,
 *   stars: number|null, price: number, formattedPrice: string|null, updated: string|null,
 *   daysSinceUpdate: number|null, hasIap: boolean|null, url: string|null,
 * }} Incumbent */

/** One positioning claim and how much of the top-10 already makes it. */
/** @typedef {{claim: string, apps: number, share: number, holders: (string|null)[]}} ClaimRow */

/** @typedef {{corpus: number, claims: ClaimRow[]}} ClaimsAudit */

/** The listing fields `draftListing` fills from evidence. */
/** @typedef {{
 *   name: string, subtitle: string, keywords: string, description: string,
 *   keywordField: {used: number, limit: number}, coversTerm: boolean,
 * }} ListingDraft */

/** The listing fields a brief artifact carries. */
/** @typedef {{name?: string, subtitle?: string, keywords?: string, description?: string}} BriefListing */

/**
 * The brief artifact `ship scout brief` writes, as `listingFromBrief` reads
 * it. Every field is optional — the reader fills `null`/`''` for whatever an
 * older brief lacks — and every field carries the JSON type the writer emits.
 * @typedef {{
 *   term?: string, file?: string, generatedAt?: string,
 *   market?: {country?: string},
 *   listing?: BriefListing,
 *   verdict?: {go?: boolean, reasons?: VerdictReason[]},
 *   metrics?: VerdictMetrics,
 *   claims?: {claims?: {share: number, claim: string}[]},
 *   incumbents?: {name: string|null, ratings: number}[],
 *   demand?: number, competition?: number, opportunity?: number, viability?: number,
 *   saturation?: {score?: number}, commodity?: {share?: number},
 * }} ScoutBrief
 */

/**
 * The staged listing `listingFromBrief` drafts for `ship new --from`, with the
 * research notes that outlive it.
 * @typedef {{
 *   locale: string, name: string, subtitle: string, keywords: string, description: string,
 *   promotionalText: string, whatsNew: string, privacyPolicyUrl: string,
 *   supportUrl: string, marketingUrl: string,
 *   notes: {
 *     term: string|null, brief: string|null, market: string|null, researchedAt: string|null,
 *     scores: {demand: number|null, competition: number|null, opportunity: number|null,
 *              saturation: number|null, commodity: number|null, viability: number|null},
 *     evidence: {top3MedianRatings: number|null, exactTitleMatches: number|null,
 *                freeTop10: number|null, newEntrants: number|null, freshUnproven: number|null,
 *                claimsAlreadyTaken: string[], incumbents: string[]},
 *     verdict: string|null,
 *     rewrite: string[],
 *   },
 * }} StagedDraft
 */

const NUM = new Intl.NumberFormat('en-US');
/**
 * Grouped integers for verdict and report text: 82,000, not 82000.
 * @param {string|number|boolean|null|undefined} n
 * @returns {string}
 */
export const fmt = (n) => NUM.format(Math.round(Number(n) || 0));

/**
 * The gates. Defaults are the thresholds a one-person launch survives.
 *
 * `saturation` and `clones` are the two newest and the pair that would have
 * stopped Glovebox: every other gate reads the incumbents' *strength*, so a
 * category being speed-run by twenty other solo devs this month reads as
 * weakness to all of them. `clones` is a count, not an average, because two
 * decade-old incumbents in the same top-10 are enough to keep any blended score
 * respectable while page one fills up with apps named after the query.
 */
export const GATES = {
	moat: 50_000,
	minVolume: 10,
	exactTitleMatches: 6,
	saturation: 40,
	clones: 2,
	// Three of ten is where a category stops having a gap and starts having a
	// convention. Under it the matches are adjacent products; at it and above,
	// the storefront page for the term is a column of the same app.
	commodity: 25,
};

/**
 * A free incumbent with a review moat cannot be beaten on price or on trust,
 * and you have neither. Paid-only incumbents leave "the free one" open.
 * @param {VerdictMetrics} m
 * @param {GateThresholds} t
 * @returns {string}
 */
const moatMessage = (m, t) =>
	`top-3 median ${fmt(m.top3MedianRatings)} ratings is over the ${fmt(t.moat)} moat, and ${m.freeTop10} of the top ${m.results ?? 10} are free — you would have to out-review an incumbent and undercut free`;

/**
 * The flood gate. Every strength gate reads incumbent strength, so a category
 * twenty other people shipped into last month passes all of them: no moat, no
 * reviews, weak apps. What it does not have is room, and the reviews that
 * decide the ranking six months out have not been written for anyone yet.
 * @param {VerdictMetrics} m
 * @param {GateThresholds} t
 * @returns {string}
 */
const saturationMessage = (m, t) =>
	`saturation ${m.saturation} is over the ${t.saturationCap} cap — ${m.newEntrants ?? 0} of the top ${m.results ?? 10} first shipped inside ${m.freshDays ?? 365} days, ${m.freshUnproven ?? 0} of those still have under 25 ratings and ${m.cloneTitles ?? 0} already put "${m.term}" in the title. This is not an unserved niche, it is a race that started before you; the weak incumbents this term scores well on are other people's launches from last year`;

/**
 * The clone gate: not "is this category crowded" but "has somebody already
 * shipped the app this brief would produce". An app titled after the query
 * with no ratings is that, whatever its release date, and the count survives
 * two entrenched incumbents keeping the blended saturation score down.
 * @param {VerdictMetrics} m
 * @param {GateThresholds} t
 * @returns {string}
 */
const clonesMessage = (m, t) =>
	`${m.clones} of the top ${m.results ?? 10} are already this app — titled after "${m.term}", shipped inside ${m.freshDays ?? 365} days, still under 25 ratings${m.cloneApps?.length ? ` (${m.cloneApps.slice(0, 4).join(', ')})` : ''} — over the ${t.cloneCap} cap. The pipeline that handed you this term handed it to them first; building it again competes with your own idea`;

/**
 * The commodity gate: is this app already the category? `clones` only sees a
 * literal substring of the whole query, so it reads 0 on a page of Aquarium
 * Manager / AquaLens / Tank Log — permuted tokens are the naming convention
 * in every `<subject> log` category, and that is where the term is deadest.
 * Traction decides which sentence gets printed, because the two failures
 * have opposite shapes and only one of them is survivable by shipping early.
 * @param {VerdictMetrics} m
 * @param {GateThresholds} t
 * @returns {string}
 */
const commodityMessage = (m, t) =>
	`${m.commodityMatches ?? 0} of the top ${m.results ?? 10} are already this product — a subject word plus a logging noun, in any order, at any age (${m.commodityApps?.slice(0, 4).join(', ') ?? ''}) — ${m.commodity}% of the page, over the ${t.commodityCap}% cap. ` +
	((m.commodityProven ?? 0) > 0
		? `${m.commodityProven} of them carry real ratings, so this is a served market, not a gap: the category is solved and you would be the next identical entry on a page that already converts`
		: `none of them has traction, so the category is a race nobody has won — the demand that was supposed to justify it has not paid anyone yet`);

/**
 * The gate table behind `verdict`. One row per way a keyword kills a solo
 * launch: `test` reads the metrics against the caller's thresholds, `metric`
 * names the number that tripped it, `flag` is the threshold it tripped
 * against, and `message` prints that number — "too competitive" is not a
 * finding anybody can act on. Order is print order: strength gates first,
 * then the flood gates a strength-only read would miss.
 */
/** @type {Gate[]} */
const GATE_TABLE = [
	{
		gate: 'moat',
		metric: 'top3MedianRatings',
		flag: (t) => t.moat,
		test: (m, t) => m.top3MedianRatings > t.moat && m.freeTop10 > 0,
		message: moatMessage,
	},
	{
		gate: 'demand',
		metric: 'demand',
		flag: (t) => t.minVolume,
		test: (m, t) => m.demand < t.minVolume,
		message: (m, t) =>
			`demand ${m.demand} is under the ${t.minVolume} floor — autocomplete barely surfaces "${m.term}", so ranking first for it wins nothing`,
	},
	{
		gate: 'crowding',
		metric: 'exactTitleMatches',
		flag: (t) => t.exactCap,
		test: (m, t) => m.exactTitleMatches > t.exactCap,
		message: (m, t) =>
			`${m.exactTitleMatches} of the top ${m.results ?? 10} put "${m.term}" in the title, over the ${t.exactCap} cap — the phrase is the category's naming convention, not a gap`,
	},
	{
		gate: 'saturation',
		metric: 'saturation',
		flag: (t) => t.saturationCap,
		test: (m, t) => (m.saturation ?? 0) > t.saturationCap,
		message: saturationMessage,
	},
	{
		gate: 'clones',
		metric: 'clones',
		flag: (t) => t.cloneCap,
		test: (m, t) => (m.clones ?? 0) > t.cloneCap,
		message: clonesMessage,
	},
	{
		gate: 'commodity',
		metric: 'commodity',
		flag: (t) => t.commodityCap,
		test: (m, t) => (m.commodity ?? 0) > t.commodityCap,
		message: commodityMessage,
	},
];

/** @type {GateThresholds} */
const THRESHOLD_DEFAULTS = {
	moat: GATES.moat,
	minVolume: GATES.minVolume,
	exactCap: GATES.exactTitleMatches,
	saturationCap: GATES.saturation,
	cloneCap: GATES.clones,
	commodityCap: GATES.commodity,
};

/**
 * Go/no-go on one term. Pure and exported: the thresholds are the product
 * decision, so they get unit tests rather than a live storefront at 1 req/s.
 * The gates themselves are data — see GATE_TABLE.
 * @param {VerdictMetrics} m
 * @param {Partial<GateThresholds>} [thresholds]
 * @returns {VerdictResult}
 */
export function verdict(m, thresholds = {}) {
	// The Record half is index-signature bookkeeping so the `t[k] = v` loop
	// below typechecks; the values are always the GateThresholds defaults.
	/** @type {GateThresholds & Record<string, number>} */
	const t = { ...THRESHOLD_DEFAULTS };
	// An explicitly-undefined threshold falls back to the default, exactly as a
	// destructured parameter default would.
	for (const [k, v] of Object.entries(thresholds)) if (v !== undefined) t[k] = v;
	/** @type {VerdictReason[]} */
	const reasons = [];
	for (const g of GATE_TABLE) {
		if (!g.test(m, t)) continue;
		reasons.push({ gate: g.gate, value: m[g.metric], threshold: g.flag(t), message: g.message(m, t) });
	}
	return { go: reasons.length === 0, reasons };
}

/**
 * What a paid install may cost before Search Ads stops paying for itself.
 * Apple keeps 30% in year one, a solo subscription app's median subscriber is
 * gone inside three months, and 2-5% of installs ever subscribe. Above the top
 * of this band ASA is a marketing expense, not acquisition.
 * @param {number} subPrice
 * @returns {CpiBand}
 */
export function cpiBand(subPrice) {
	const net = subPrice * 0.7;
	const ltv = net * 3;
	return {
		subPrice: round2(subPrice),
		netPerMonth: round2(net),
		assumedMonthsRetained: 3,
		ltv: round2(ltv),
		installToSubscriber: { low: 0.02, high: 0.05 },
		cpi: { low: round2(ltv * 0.02), high: round2(ltv * 0.05) },
		derivation: 'subPrice × 0.70 Apple cut × 3 months retained × 2-5% install→subscriber',
	};
}

/**
 * @param {string} s
 * @returns {string}
 */
const titleCase = (s) =>
	String(s)
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w[0].toLocaleUpperCase() + w.slice(1))
		.join(' ');

/**
 * Longest leading run of whole words that fits `limit` code points; hard-cut
 * if even one does not.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function fitWords(text, limit) {
	const parts = String(text).split(/\s+/).filter(Boolean);
	/** @type {string[]} */
	const kept = [];
	for (const part of parts) {
		if (charCount([...kept, part].join(' ')) > limit) break;
		kept.push(part);
	}
	return kept.length ? kept.join(' ') : Array.from(String(text)).slice(0, limit).join('');
}

/**
 * Category vocabulary: tokens the live top-10 titles *share*, most common first.
 *
 * Two exclusions, both learned from a draft that proposed
 * `carfax,cariq,myautolog,rovo,utilities,lifestyle`:
 *  - a token appearing in exactly one title is that app's brand, not the
 *    category's language. Targeting a competitor's name is a deliberate ASA
 *    decision (`ship ads plan` builds a Competitor campaign for it), never a
 *    default in your own keyword field.
 *  - `primaryGenreName` is Apple's shelf label, not a query. Nobody searches
 *    "utilities", and it cost a subtitle slot every time it was mined.
 */
/**
 * @param {ScoutApp[]} results
 * @param {string} locale
 * @returns {string[]}
 */
export function categoryVocabulary(results, locale) {
	/** @type {Set<string>} */
	const brands = new Set();
	for (const r of results) for (const w of indexedWords(r.sellerName ?? '', locale)) brands.add(w);

	/** @type {Map<string, number>} */
	const freq = new Map();
	for (const r of results)
		for (const w of indexedWords(r.trackName ?? '', locale)) freq.set(w, (freq.get(w) ?? 0) + 1);

	return [...freq]
		.filter(([w, n]) => n >= 2 && !brands.has(w))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([w]) => w);
}

/** Separators Apple's autocomplete uses between an app's name and its category phrase. */
const NAME_SEPARATOR = /\s*(?:::|:|—|–|-|\||·)\s*/;

/**
 * Brand tokens visible only in the harvest, not in the top-10.
 *
 * The hints endpoint does not return queries; it returns *rows*, and a row is
 * as often a product name as a search. For "car maintenance log" the live row
 * is `autoteca: car maintenance log`, `glovebox: car maintenance log`,
 * `car maintenance log :: autolog`, `carbook: car maintenance log` — nine of
 * ten entries are somebody's App Store title wrapped around the phrase.
 *
 * `brandTokens` cannot see these: it reads publisher and app names off the
 * top-10, and none of these apps is in the top-10 for the term. So the drafted
 * keyword field came out `autolog,glovebox` — a hundred characters of
 * indexable space, and the first two spent naming competitors.
 *
 * The tell is structural rather than lexical. When a row splits on a separator
 * and one side is exactly the term, the other side is the product's name. A
 * token is only judged a brand when *every* one of its appearances is on that
 * name side: `car` sits left of the separator in `car cave - car maintenance
 * log` and is still a category word, because it also appears in a row that is
 * a plain query. `cave` never does.
 *
 * Returned rather than filtered here, so `keywordPool`'s existing brand floor
 * still applies: a "brand" the market types often enough is a category word,
 * whatever its origin, and that judgement belongs in one place.
 *
 * Limit, by construction: this reads structure, so a product name with no
 * separator is invisible to it. `valvoline instant oil change` and
 * `take 5 oil change` are chains, not queries, and they look exactly like
 * `car oil change tracker` to a splitter. Those are caught — when they are
 * caught — by `brandTokens` off the publisher names, and otherwise by the
 * keyword-coverage warning in `meta lint`. Two narrow detectors that each say
 * why they fired beat one that guesses at brand-ness from text alone.
 */
/**
 * @param {string[]} suggestions
 * @param {string} term
 * @param {string} [locale]
 * @returns {Set<string>}
 */
export function harvestBrands(suggestions, term, locale = 'en-US') {
	const needle = String(term ?? '').trim().toLocaleLowerCase();
	if (!needle) return new Set();
	/** @type {Set<string>} */
	const nameSide = new Set();
	/** @type {Set<string>} */
	const querySide = new Set();
	for (const row of suggestions ?? []) {
		const text = String(row ?? '').toLocaleLowerCase();
		const parts = text.split(NAME_SEPARATOR).filter(Boolean);
		// A row with no separator, or one that is only the term, is a query.
		// Everything in it is vocabulary the market actually typed.
		const isName = parts.length > 1 && parts.some((p) => p.trim() === needle);
		if (!isName) {
			for (const w of words(text, locale)) querySide.add(w);
			continue;
		}
		for (const part of parts) {
			const target = part.trim() === needle ? querySide : nameSide;
			for (const w of words(part, locale)) target.add(w);
		}
	}
	for (const w of querySide) nameSide.delete(w);
	return nameSide;
}

/**
 * The keyword pool: harvested tokens, best-supported first, minus the brands.
 *
 * Two rules, both learned from drafts this produced:
 *  - Tokens, not phrases. Filtering whole queries threw away `vehicle` and
 *    `tracker` because `mileage` beside them was rare — but Apple indexes the
 *    keyword field word by word and recombines, so the unit of value is the
 *    token.
 *  - A publisher-name token is a brand *unless the market types it*. Every
 *    token of `sellerName` cannot simply be banned: publishers are legal
 *    entities called "Express Oil Change Service Company LLC", and banning
 *    their words banned the category. So a seller token survives only when its
 *    query support reaches a quarter of the strongest token's. `service`
 *    (12 queries) lives; `valvoline` (2) does not.
 *
 * Targeting a competitor's name is a deliberate ASA decision — `ship ads plan`
 * builds a Competitor campaign for exactly that — never a listing default.
 */
/**
 * @param {string[]} suggestions
 * @param {{brands?: ReadonlySet<string>, locale?: string, floor?: number, min?: number}} [opts]
 * @returns {string[]}
 */
export function keywordPool(suggestions, { brands = new Set(), locale = 'en-US', floor = 10, min = 2 } = {}) {
	const support = tokenSupport(suggestions, locale);
	const stop = stopwordsFor(locale);
	const thin = suggestions.length < floor;
	const peak = Math.max(0, ...support.values());
	const brandFloor = thin ? 1 : Math.max(min + 1, Math.ceil(peak / 4));
	const need = thin ? 1 : min;
	return [...support]
		.filter(([w, n]) => !stop.has(w) && n >= need && (!brands.has(w) || n >= brandFloor))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([w]) => w);
}

/**
 * Harvested queries every token of which the market actually types, for the
 * subtitle draft. A one-query token is somebody's product name — `service link`
 * read like a category phrase and is a company.
 */
/**
 * @param {string[]} suggestions
 * @param {string} [locale]
 * @param {{brands?: ReadonlySet<string>, floor?: number, min?: number}} [opts]
 * @returns {string[]}
 */
export function supportedPhrases(suggestions, locale = 'en-US', { brands = new Set(), floor = 10, min = 2 } = {}) {
	const keep = new Set(keywordPool(suggestions, { brands, locale, floor, min }));
	const stop = stopwordsFor(locale);
	return suggestions.filter((phrase) => {
		const toks = words(phrase, locale);
		return toks.length > 0 && toks.every((w) => keep.has(w) || stop.has(w));
	});
}

/**
 * A first listing drafted from evidence only: the name is the term, the
 * subtitle is the strongest phrase the name does not already index, and the
 * keywords are the rest of the autocomplete row plus the category's own
 * vocabulary, packed to 100 code points. Pure — the network happens in `brief`.
 *
 * The description is deliberately a skeleton whose last sentence says what to
 * replace it with: it is the one listing field search does not index, so
 * generating prose for it would be writing for nobody.
 * @param {{term: string, suggestions?: string[], results?: ScoutApp[],
 *          brands?: ReadonlySet<string>, locale?: string}} opts
 * @returns {ListingDraft}
 */
export function draftListing({ term, suggestions = [], results = [], brands = new Set(), locale = 'en-US' }) {
	const name = fitWords(titleCase(term), 30);
	const nameTokens = indexedWords(name, locale);
	const known = brands.size ? brands : brandTokens(results.map((r) => ({ name: r.trackName, seller: r.sellerName })), locale);
	const vocab = categoryVocabulary(results, locale).filter((w) => !nameTokens.has(w) && !known.has(w));
	// The subtitle is 30 indexed characters of prime real estate, so it holds to
	// a higher bar than the keyword field: every token has to be typed by three
	// separate queries. At two, `service titan` — a company — won the slot.
	const phrases = supportedPhrases(suggestions, locale, { brands: known, min: 3 });
	const tokens = keywordPool(suggestions, { brands: known, locale });

	// A subtitle that repeats the name spends 30 indexed characters on nothing,
	// so the draft is the first suggestion sharing no token with it.
	const alternative = phrases.find((s) => {
		const toks = words(s, locale);
		return toks.length > 1 && toks.every((w) => !nameTokens.has(w)) && charCount(titleCase(s)) <= 30;
	});
	const subtitle = alternative
		? titleCase(alternative)
		: vocab.length
			? fitWords(titleCase(vocab.slice(0, 3).join(' ')), 30)
			: fitWords(titleCase(term), 30);

	const pool = [...tokens, ...vocab];
	const packed = packKeywords(pool, { alreadyIndexed: `${name} ${subtitle}`, locale });

	const ratings = results.map((r) => r.userRatingCount ?? 0);
	const paid = results.filter((r) => (r.price ?? 0) > 0).length;
	const leader = results[0]?.trackName;
	const description = [
		`${name} is a ${term} app with one screen and one job.`,
		leader
			? `The top ${results.length} results for "${term}" carry a median of ${fmt(median(ratings))} ratings, are led by ${leader}, and ${paid ? `${paid} of them charge up front` : 'every one of them is free to download'}.`
			: '',
		'Replace this paragraph before you submit: say what the app finishes in one sitting, name the screen it happens on, and say plainly what it does not do. Search does not index the description, so it is the only field you are writing for a human instead of for the indexer.',
	]
		.filter(Boolean)
		.join(' ');

	return {
		name,
		subtitle,
		keywords: normaliseKeywords(packed.keywords),
		description,
		keywordField: { used: packed.used, limit: packed.limit },
		coversTerm: name.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()),
	};
}

/**
 * The six numbers the staged record keeps, exactly as the brief scored them.
 * @param {ScoutBrief} brief
 * @returns {{demand: number|null, competition: number|null, opportunity: number|null,
 *            saturation: number|null, commodity: number|null, viability: number|null}}
 */
const briefScores = (brief) => ({
	demand: brief.demand ?? null,
	competition: brief.competition ?? null,
	opportunity: brief.opportunity ?? null,
	saturation: brief.saturation?.score ?? null,
	// The number that decides most verdicts belongs in the record that
	// survives: six weeks on, "why did we not build this" is answered
	// by the share, not by the fact that a gate fired.
	commodity: brief.commodity?.share ?? null,
	viability: brief.viability ?? null,
});

/**
 * The evidence block: the numbers a rewrite argument needs, six weeks later.
 * @param {ScoutBrief} brief
 * @returns {{top3MedianRatings: number|null, exactTitleMatches: number|null,
 *            freeTop10: number|null, newEntrants: number|null, freshUnproven: number|null,
 *            claimsAlreadyTaken: string[], incumbents: string[]}}
 */
const briefEvidence = (brief) => {
	/** @type {Partial<VerdictMetrics>} */
	const m = brief.metrics ?? {};
	return {
		top3MedianRatings: m.top3MedianRatings ?? null,
		exactTitleMatches: m.exactTitleMatches ?? null,
		freeTop10: m.freeTop10 ?? null,
		newEntrants: m.newEntrants ?? null,
		freshUnproven: m.freshUnproven ?? null,
		claimsAlreadyTaken: (brief.claims?.claims ?? []).filter((r) => r.share >= 40).map((r) => r.claim),
		incumbents: (brief.incumbents ?? []).map((a) => `${a.name} · ${fmt(a.ratings)} ratings`),
	};
};

/**
 * `GO`, the NO-GO with its reasons joined, or null when the gates never ran.
 * @param {Partial<VerdictResult>} v
 * @returns {string|null}
 */
const verdictLine = (v) =>
	v.go === undefined ? null : v.go ? 'GO' : `NO-GO — ${(v.reasons ?? []).map((r) => r.message).join('; ')}`;

/**
 * The rewrite instructions, which outlive the research that produced them.
 * @param {{keywords?: string}} listing
 * @param {string|undefined} term
 * @returns {string[]}
 */
const rewriteNotes = (listing, term) => [
	`name, subtitle and keywords are drafted from "${term}" — edit them, then \`ship meta lint\``,
	`keywords use ${charCount(listing.keywords ?? '')}/100 characters; every space after a comma costs one`,
	'the description is a skeleton — its last sentence says what to replace it with',
	'differentiation must be something not in notes.evidence.claimsAlreadyTaken — those sentences are already in every competitor listing',
];

/**
 * Brief → the staged listing `ship new --from` writes. The notes block is the
 * point: six weeks later the only surviving record of why these 100 characters
 * were chosen is the one that shipped inside the file they live in.
 * @param {ScoutBrief} brief
 * @param {{locale?: string}} [opts]
 * @returns {StagedDraft}
 */
export function listingFromBrief(brief, { locale = 'en-US' } = {}) {
	/** @type {BriefListing} */
	const l = brief.listing ?? {};
	return {
		locale,
		name: l.name ?? '',
		subtitle: l.subtitle ?? '',
		keywords: normaliseKeywords(l.keywords ?? ''),
		description: l.description ?? '',
		promotionalText: '',
		whatsNew: '',
		privacyPolicyUrl: '',
		supportUrl: '',
		marketingUrl: '',
		notes: {
			term: brief.term ?? null,
			brief: brief.file ?? null,
			market: brief.market?.country ?? null,
			researchedAt: brief.generatedAt ?? null,
			scores: briefScores(brief),
			evidence: briefEvidence(brief),
			verdict: verdictLine(brief.verdict ?? {}),
			rewrite: rewriteNotes(l, brief.term),
		},
	};
}

/**
 * Filename stem for a term. Non-Latin scripts leave nothing to slugify, so they
 * get a stable hash rather than every Japanese term colliding on one file.
 *
 * Named `slugifyAscii` here because lib/cpp.mjs exports a *different*
 * `slugify` (Unicode-preserving, for custom-product-page slugs). The two are
 * deliberately not unified: one is an ASCII file stem with a hash fallback,
 * the other a directory-safe page name.
 * @param {string} term
 * @returns {string}
 */
export function slugifyAscii(term) {
	const ascii = String(term ?? '')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (ascii) return ascii.slice(0, 48).replace(/-+$/, '');
	return `t-${createHash('sha1').update(String(term ?? '')).digest('hex').slice(0, 8)}`;
}
