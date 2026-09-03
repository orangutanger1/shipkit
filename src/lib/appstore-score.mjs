// App Store keyword scoring: candidate filtering, demand from three sources,
// competition/commodity/saturation heuristics, and ASC keyword packing.
import { c, note } from '../log.mjs';
import { clamp } from './fmt.mjs';
import { DAY_MS } from './dates.mjs';
import { median } from './util.mjs';
import { charCount, indexedWords, isNoSpaceLang, stopwordsFor, words } from './text.mjs';
import { topResults } from './appstore-client.mjs';

/** A live storefront search/lookup result, viewed loosely — the fields this module reads. */
/** @typedef {{trackName?: string, sellerName?: string, userRatingCount?: number, releaseDate?: string, trackId?: number, averageUserRating?: number, trackViewUrl?: string, price?: number}} AppRow */
/** One harvested term's artifact entry, or the legacy `string[]` seed-list shape. */
/** @typedef {{seeds?: string[], rank?: number}} TermEntry */
/** `.asc/aso/*-volume.json`: hand or MCP-sourced popularity per term. */
/** @typedef {{terms?: Record<string, number|{popularity?: number, difficulty?: number}>}} VolumeFile */
/** `.asc/analytics/<locale>-terms.json`: measured impressions per term. */
/** @typedef {{rows?: {term?: string, impressions?: number}[]}} AnalyticsFile */
/** One row of {@link demandTable}'s output. */
/** @typedef {{demand: number, source: 'analytics'|'volume'|'rank', difficulty?: number}} DemandRow */

/** @param {number} n */
const clamp100 = (n) => clamp(Math.round(n), 0, 100);

/**
 * Drop brand names and malformed phrases; keep 1-4 word queries a human would type.
 * @param {string[]} terms
 * @param {{minWords?: number, maxWords?: number, exclude?: string[]}} [opts]
 */
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

const STOP_SUFFIX = /\b(free|pro|app|apps)\s*$/i;

/**
 * Seeds of a candidate, tolerating the legacy `term: string[]` artifact shape.
 * @param {TermEntry|string[]} entry
 */
const seedsOf = (entry) => (Array.isArray(entry) ? entry : (entry?.seeds ?? []));
/** @param {TermEntry|string[]} entry */
const rankOf = (entry) => (Array.isArray(entry) || typeof entry?.rank !== 'number' ? null : entry.rank);

/**
 * Whole days since an ISO timestamp; null when the storefront gave us nothing to date.
 * @param {string|null|undefined} iso
 * @param {number} [now]
 */
function ageInDays(iso, now = Date.now()) {
	const t = Date.parse(iso ?? '');
	return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY_MS)) : null;
}

/**
 * Ordinal demand for one harvested term, 0-100.
 *
 * Apple orders autocomplete by popularity, so the position a term holds is a
 * free volume proxy, and a term several different seeds surface is a hub term
 * rather than a long-tail accident. A legacy artifact carries no rank at all;
 * those get the neutral middle so seed count still orders them.
 * @param {TermEntry|string[]} entry
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
 * @param {AnalyticsFile|null} [analytics]
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
 * @param {Record<string, TermEntry|string[]>} terms
 * @param {{volume?: VolumeFile|null, analytics?: AnalyticsFile|null}} [sources]
 * @returns {Map<string, DemandRow>}
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
		const knownDifficulty = /** @type {{difficulty?: number}|undefined} */ (known)?.difficulty;
		const difficulty = typeof knownDifficulty === 'number' ? knownDifficulty : undefined;
		const seen = measured.get(key);
		if (seen !== undefined) out.set(term, { demand: seen, source: 'analytics', difficulty });
		else if (typeof popularity === 'number') out.set(term, { demand: clamp100(popularity), source: 'volume', difficulty });
		else out.set(term, { demand: demand(entry, { maxRank }), source: 'rank', difficulty });
	}
	return out;
}

/**
 * Nouns that name the *artifact* rather than the subject: the half of a title
 * that says what kind of app this is. Two apps sharing one of these and a
 * subject word are the same product in different vocabulary, which is the
 * distinction `titleMatch` cannot make — "Aquarium Manager: Tank Log" does not
 * contain the string "aquarium water log", and is that app exactly.
 *
 * Both families are here on purpose. A list of storage nouns alone scores 0%
 * on every computational category, because "Concrete Calculator" records
 * nothing — which would hand back exactly the false pass this function was
 * written to remove, one term shape over.
 */
const ARTIFACT_NOUNS = [
	// Stores something.
	'logbook', 'log', 'logs', 'logger', 'journal', 'diary', 'tracker', 'tracking',
	'track', 'manager', 'monitor', 'record', 'records', 'reminder', 'reminders',
	'planner', 'notebook', 'keeper', 'checklist', 'inspection', 'maintenance',
	'service', 'history', 'inventory', 'book',
	// Computes something.
	'calculator', 'calc', 'calculators', 'converter', 'conversion', 'estimator',
	'estimate', 'sizer', 'solver', 'timer', 'counter',
];
const ARTIFACT_RE = new RegExp(`\\b(${ARTIFACT_NOUNS.join('|')})\\b`, 'i');

/**
 * Split camel and digit runs so a word-boundary match can see inside a brand
 * word. "DiverLog+" → "diver log+", "AquaLens" → "aqua lens": the storefront's
 * convention is to jam the category noun onto the brand, and a plain `\blog\b`
 * never fires on it. Splitting first also keeps "Catalog" and "Biology" out,
 * which a bare substring test would wrongly count.
 * @param {string|null|undefined} s
 */
const camelSplit = (s) =>
	String(s ?? '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])([0-9])/g, '$1 $2')
		.toLocaleLowerCase();

/**
 * Whether a title names the same subject as one of the term's subject words.
 * Compounds are why this is not equality: "beehive" has to match both "Bee
 * Plus" and "HiveLog", so a title word counts when it is a prefix or a suffix
 * of the subject word, or the subject starts with it. Three characters is the
 * floor — below it ("ac", "rv") a prefix match is noise, so those compare whole.
 * @param {string[]} titleWords
 * @param {string} subject
 */
function subjectHit(titleWords, subject) {
	for (const w of titleWords) {
		if (w.length < 3 || subject.length < 3) {
			if (w === subject) return true;
			continue;
		}
		if (w.startsWith(subject) || subject.startsWith(w) || subject.endsWith(w)) return true;
	}
	return false;
}

/**
 * Share of a top-10 that is *the same product* the term describes, at any age
 * and any rating count.
 *
 * This is the number `clones` was mistaken for. `clones` asks a narrower
 * question — did somebody run this exact pipeline last year and ship the query
 * as a title — and answers it with a literal substring of the whole phrase. So
 * it reports 0 for "aquarium water log", whose top 10 is Aquarium Manager,
 * AquaLens, Aquarium Log, Tank Snap, ReefDrift and AquaLog: every one of them
 * the app the brief would have drafted, not one containing the phrase.
 * Permuted tokens are the naming convention in every `<subject> log` category,
 * so the gate was blind exactly where it was load-bearing.
 *
 * Deliberately separate from {@link saturation}'s `score`. That score is a
 * stampede meter and its age window is intentional: weak *and old* is a real
 * gap. Commodity is the orthogonal question — how many people have already
 * built this, ever — and a term dies to either. Read together they name which:
 * high commodity with ratings is a served market (no room), high commodity
 * without them is a race (no payoff).
 * @param {AppRow[]} results live top-10 from {@link topResults}
 * @param {{term?:string, locale?:string, tractionFloor?:number}} [opts]
 */
export function commodity(results, { term = '', locale = 'en', tractionFloor = 25 } = {}) {
	if (!results?.length) return null;
	const stop = stopwordsFor(locale);
	const termWords = words(camelSplit(term), locale);
	const subjects = termWords.filter((w) => !stop.has(w) && !ARTIFACT_NOUNS.includes(w));
	// What the *term* is shaped like decides the rule, not what the titles are
	// shaped like. Getting this backwards is how the same false pass appeared
	// three times in three different term shapes.
	//
	// A term that names an artifact ("car maintenance log", "concrete
	// calculator") is a subject plus a kind of app, so a title has to show
	// both — any artifact noun, not the term's own, because "Tank Manager" and
	// "water log" are one product. Insisting on the term's noun is the original
	// bug: it made `clones` read 0 on a page of nothing but clones.
	//
	// A term that names no artifact is itself the product's name, and its
	// incumbents feel no need to add a noun saying so: the top 10 for "sudoku"
	// is eight sudoku games, none of which is a "sudoku tracker", and the top
	// 10 for "feeds and speeds calculator" is Walter Feeds & Speeds and Feeds n
	// Speeds. Both scored 0% while being wholly solved. For those, covering
	// every subject word is the match.
	const termNamesArtifact = termWords.some((w) => ARTIFACT_NOUNS.includes(w));
	const rows = results.map((r) => {
		const split = camelSplit(r.trackName);
		const titleWords = words(split, locale);
		const covered = subjects.filter((s) => subjectHit(titleWords, s)).length;
		const all = covered === subjects.length;
		// The multi-subject clause survives for artifact-naming terms too: a
		// title carrying every subject word is that product whether or not it
		// admits to a category noun.
		const match =
			subjects.length > 0 &&
			(termNamesArtifact
				? (ARTIFACT_RE.test(split) && covered > 0) || (all && subjects.length >= 2)
				: all);
		return { name: r.trackName ?? null, ratings: r.userRatingCount ?? 0, match };
	});
	const hits = rows.filter((r) => r.match);
	const proven = hits.filter((r) => r.ratings >= tractionFloor);
	return {
		results: rows.length,
		matches: hits.length,
		share: Math.round((100 * hits.length) / rows.length),
		// Both halves are reported rather than a verdict: the two diagnoses have
		// different remedies, and only the caller knows which it is asking about.
		proven: proven.length,
		unproven: hits.length - proven.length,
		subjects,
		apps: hits.map((r) => ({ name: r.name, ratings: r.ratings })),
	};
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
 * @param {AppRow[]} results live top-10 from {@link topResults}
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
	const dated = /** @type {Array<typeof rows[number] & {ageDays: number}>} */ (rows.filter((r) => r.ageDays !== null));
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
		// null, not 0: with no dated rows the median is unknown, and 0 would
		// print "median age 0d" — i.e. "the whole page shipped today" — which is
		// the opposite of what a lookup gap means. `youngestDays` already says
		// null here for the same reason.
		medianAgeDays: dated.length ? median(dated.map((r) => r.ageDays)) : null,
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
 * @param {AppRow[]} results live top-10 from {@link topResults}
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
	const flood = /** @type {NonNullable<ReturnType<typeof saturation>>} */ (saturation(results, { term, now }));
	const same = /** @type {NonNullable<ReturnType<typeof commodity>>} */ (commodity(results, { term }));
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
		commodity: same.share,
		commodityMatches: same.matches,
		commodityProven: same.proven,
		newEntrants: flood.newEntrants,
		freshUnproven: flood.freshUnproven,
		medianAgeDays: flood.medianAgeDays,
		viability: Math.round(opportunity * (1 - flood.score / 100) * (1 - same.share / 100)),
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
 * @param {{onProgress?: Function, demands?: Map<string, DemandRow|number>|Record<string, DemandRow|number>}} [opts]
 *   `demands` takes a plain 0-100 number or a {@link demandTable} row per term.
 */
export async function scoreAll(terms, market, { onProgress, demands } = {}) {
	/** @param {string} term */
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

/**
 * Does a brand name already exist on the storefront?
 *
 * "Glovebox" read as an unused word for a car app; the storefront already had
 * `Car Maintenance Log - Glovebox`, which searching the *category* never
 * surfaces because the collision lives in a suffix. Whole-word matching is the
 * point: `Glovebox` collides with `... - Glovebox`, not with `Gloveboxes Inc`
 * substring noise, and an exact title equality is a different severity.
 * @param {string} name candidate brand word(s)
 * @param {AppRow[]} results search results for that name
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
 * @param {Array<string|{keyword: string}>} scored
 * @param {{limit?: number, alreadyIndexed?: string, locale?: string}} [opts]
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

/**
 * @param {number} i
 * @param {number} total
 * @param {string} label
 * @param {*} [extra]
 */
export function progressLine(i, total, label, extra) {
	const pct = String(Math.round((100 * i) / total)).padStart(3);
	note(`${c.dim(`[${pct}%]`)} ${label}${extra !== undefined ? c.dim(` → ${extra}`) : ''}`);
}
