// storefront-scout — the storefront half of `ship scout`: everything that
// talks to Apple or to the scout artifact tree. The subcommands in
// commands/scout.mjs compose these; the pure scoring they feed lives in
// lib/scout-scoring.mjs. Nothing here prints a report — progress callbacks
// and artifact writes are handed in or returned, so the command keeps its
// `--json` contract.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { ShipError } from '../log.mjs';
import {
	LOCALE_MARKETS,
	StorefrontWall,
	demand as demandOf,
	demandTable,
	harvest,
	hints,
	lookup,
	pickCandidates,
	scoreAll,
	useCache,
} from './appstore.mjs';
import { daysElapsed } from './dates.mjs';
import { round1 } from './fmt.mjs';
import { slugifyAscii } from './scout-scoring.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').Flags} Flags */

/** A storefront: the country code the iTunes API wants and its language tag. */
/** @typedef {{country: string, lang: string}} Market */

/**
 * The `terms` artifact `ship scout terms` writes, as `priorSweep` reads it
 * back. Candidate entries are either the current `{seeds, rank, stemDepth}`
 * shape or the legacy bare `string[]`.
 * @typedef {{
 *   candidates?: Record<string, import('./appstore-client.mjs').Candidate | string[]>,
 *   terms?: import('./scout-scoring.mjs').ScoredTerm[],
 * }} TermsArtifact
 */

/** What a prior `ship scout terms` sweep already knows about one term. */
/** @typedef {{file: string, seeds: string[], rank: number|null, demand: number|null,
 *             cohort: string[], apps: {name: string|null, seller: string|null}[]}} PriorSweep */

/** Storefront code (`us`, `de`) → the { country, lang } pair search and hints need. */
/** @type {Map<string, Market>} */
const MARKETS = new Map();
for (const m of Object.values(LOCALE_MARKETS)) if (!MARKETS.has(m.country)) MARKETS.set(m.country, m);

/**
 * @param {string|boolean|undefined} code
 * @returns {Market}
 */
export function marketOf(code) {
	const key = String(code ?? 'us').toUpperCase();
	const market = MARKETS.get(key);
	if (!market)
		throw new ShipError(`scout: no App Store storefront "${code}"`, {
			hint: `supported: ${[...MARKETS.keys()].join(' ').toLowerCase()}`,
		});
	return market;
}

/** @param {Flags} flags @returns {string} */
const outRoot = (flags) => resolve(String(flags.out ?? 'scout'));
/**
 * @param {Flags} flags
 * @param {Market} market
 * @param {string} slug
 * @param {'terms'|'brief'|'names'} kind
 * @returns {string}
 */
export const artifactFile = (flags, market, slug, kind) =>
	join(outRoot(flags), market.country.toLowerCase(), `${slug}-${kind}.json`);

/**
 * The one artifact writer: tab-indented JSON, directories created on demand.
 * @param {string} file
 * @param {Json} data
 * @returns {Promise<string>}
 */
export async function writeArtifact(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

/**
 * Autocomplete and top-10 answers are stable for days and Apple throttles to
 * one request per storefront per second. Scout is iterative by nature — you
 * brief five terms before you like one — so every response is cached.
 * @param {Flags} flags
 * @returns {void}
 */
export const enableCache = (flags) =>
	useCache({ dir: join(outRoot(flags), '.cache'), mode: flags.refresh ? 'refresh' : 'on' });

/**
 * The terms sweep's storefront half: harvest the seeds, keep the partial
 * result when Apple walls mid-sweep, score the picked candidates. Scoring
 * that partial is strictly better than throwing the paid-for requests away;
 * telling the user about the wall belongs to the caller.
 * @param {{seeds: string[], market: Market, maxWords: number, limit: number,
 *          onProgress?: import('./scout-scoring.mjs').ProgressFn|undefined}} opts
 * @returns {Promise<{candidates: Record<string, import('./appstore-client.mjs').Candidate>,
 *                     walled: {message: string, kept: number}|null,
 *                     scored: import('./scout-scoring.mjs').ScoredTerm[]}>}
 */
export async function sweepTerms({ seeds, market, maxWords, limit, onProgress }) {
	let candidates;
	let walled = null;
	try {
		candidates = await harvest(seeds, market.country, { onProgress });
	} catch (err) {
		if (!(err instanceof StorefrontWall)) throw err;
		// `harvest` attaches the candidates it had already harvested to the wall
		// before throwing (see its JSDoc); `in` proves it is there, and the cast
		// recovers the shape this codebase's own harvest() put on it.
		if (!('partial' in err) || !err.partial) throw err;
		candidates = /** @type {Record<string, import('./appstore-client.mjs').Candidate>} */ (err.partial);
		walled = { message: err.message, kept: Object.keys(candidates).length };
	}

	const demands = demandTable(candidates);
	/** @param {string} a @param {string} b */
	const byDemand = (a, b) => (demands.get(b)?.demand ?? 0) - (demands.get(a)?.demand ?? 0) || a.length - b.length;
	const picked = pickCandidates(Object.keys(candidates), { maxWords }).sort(byDemand).slice(0, limit);
	const scored = await scoreAll(picked, market, { demands, onProgress });
	return { candidates, walled, scored };
}

/**
 * The term's own autocomplete row. Apple orders it by popularity, so the
 * position the term holds in it is the demand signal, and the rest of the row
 * is the keyword pool — those are the queries people actually finish typing.
 * @param {string} term
 * @param {string} country
 * @returns {Promise<{rank: number|null, suggestions: string[]}>}
 */
async function autocomplete(term, country) {
	const probes = term.length > 6 ? [term, term.slice(0, -2)] : [term];
	/** @type {string[]} */
	const pool = [];
	/** @type {number|null} */
	let rank = null;
	for (const probe of probes) {
		const list = await hints(probe, country);
		for (const [i, suggestion] of list.entries()) {
			pool.push(suggestion);
			if (suggestion.toLocaleLowerCase() === term && (rank === null || i < rank)) rank = i;
		}
		if (rank === 0) break;
	}
	return { rank, suggestions: [...new Set(pool)] };
}

/** A terms sweep already paid for this term's rank and demand; reuse it before asking Apple again. */
/**
 * @param {Flags} flags
 * @param {Market} market
 * @param {string} term
 * @returns {Promise<PriorSweep|null>}
 */
async function priorSweep(flags, market, term) {
	const dir = join(outRoot(flags), market.country.toLowerCase());
	if (!existsSync(dir)) return null;
	for (const name of (await readdir(dir)).filter((f) => f.endsWith('-terms.json')).sort()) {
		const file = join(dir, name);
		let doc;
		try {
			doc = /** @type {TermsArtifact} */ (JSON.parse(await readFile(file, 'utf8')));
		} catch {
			continue;
		}
		const entry = doc?.candidates?.[term];
		if (!entry) continue;
		const scored = (doc.terms ?? []).find((t) => t.keyword === term);
		// The whole sweep, best first: `scout terms` already paid for these scores,
		// and the neighbours of the head term are exactly what belongs in the
		// keyword field. Drafting from one term's autocomplete row alone left
		// 91 of the 100 characters empty.
		const cohort = (doc.terms ?? [])
			.filter((t) => t.keyword && t.keyword !== term)
			.sort((a, b) => (b.opportunity ?? 0) - (a.opportunity ?? 0))
			.map((t) => t.keyword);
		// Every incumbent the sweep ever saw, so `brandTokens` has the whole
		// storefront's publisher vocabulary and not just the head term's top-10.
		const apps = (doc.terms ?? []).flatMap((t) => (t.top3 ?? []).map((a) => ({ name: a.name, seller: a.seller })));
		return {
			file,
			seeds: Array.isArray(entry) ? entry : (entry.seeds ?? []),
			rank: Array.isArray(entry) ? null : (entry.rank ?? null),
			demand: scored?.demand ?? null,
			cohort,
			apps,
		};
	}
	return null;
}

/**
 * The evidence pool `brief` drafts from: a prior sweep's paid answers when it
 * has them, a live autocomplete otherwise. The sweep is returned too, so the
 * caller can cite it as the demand source and reuse its app vocabulary.
 * @param {Flags} flags
 * @param {Market} market
 * @param {string} term
 * @returns {Promise<{prior: PriorSweep|null, seeds: string[], rank: number|null,
 *                     demand: number, suggestions: string[], pool: string[]}>}
 */
export async function termPool(flags, market, term) {
	const prior = await priorSweep(flags, market, term);
	const live = prior?.demand === null || prior === null ? await autocomplete(term, market.country) : null;
	const seeds = prior?.seeds?.length ? prior.seeds : [term];
	const rank = prior?.rank ?? live?.rank ?? null;
	const demand = prior?.demand ?? demandOf({ seeds, rank }, { maxRank: 12 });
	const suggestions = live?.suggestions ?? (await autocomplete(term, market.country)).suggestions;
	// Scored neighbours from the sweep outrank raw autocomplete: they already
	// carry demand × competition, and packKeywords takes the pool in order.
	const pool = [...new Set([...(prior?.cohort ?? []), ...suggestions])];
	return { prior, seeds, rank, demand, suggestions, pool };
}

const PAGE_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * Whether an incumbent sells anything inside the app.
 *
 * The iTunes lookup API has no in-app-purchase field of any kind, so this reads
 * the storefront product page and takes the offer block the page was rendered
 * for — `data[0].data.titleOfferDisplayProperties` — never a neighbouring
 * "you might also like" lockup, which carries the same key for another app.
 * Best effort by design: an unknown answer is null and gates nothing.
 * @param {string|null|undefined} url
 * @returns {Promise<boolean|null>}
 */
async function sellsInApp(url) {
	if (!url) return null;
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': PAGE_UA, 'Accept-Language': 'en-US,en;q=0.9' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) return null;
		const html = await res.text();
		const block = html.match(/<script type="application\/json" id="serialized-server-data">(.*?)<\/script>/s);
		if (!block) return null;
		const offer = JSON.parse(block[1])?.data?.[0]?.data?.titleOfferDisplayProperties;
		return typeof offer?.hasInAppPurchases === 'boolean' ? offer.hasInAppPurchases : null;
	} catch {
		return null;
	}
}

/**
 * Top-3 incumbents, refreshed through lookup and annotated with monetization
 * evidence.
 * @param {import('./scout-scoring.mjs').ScoutApp[]} results
 * @param {Market} market
 * @returns {Promise<import('./scout-scoring.mjs').Incumbent[]>}
 */
export async function incumbentsOf(results, market) {
	const top3 = results.slice(0, 3);
	/** @type {import('./scout-scoring.mjs').ScoutApp[]} */
	const freshApps = await lookup(top3.map((r) => r.trackId), { country: market.country });
	const fresh = new Map(freshApps.map((a) => [a.trackId, a]));
	/** @type {import('./scout-scoring.mjs').Incumbent[]} */
	const out = [];
	for (const r of top3) {
		const app = fresh.get(r.trackId) ?? r;
		out.push({
			name: app.trackName ?? null,
			id: app.trackId ?? null,
			seller: app.sellerName ?? null,
			ratings: app.userRatingCount ?? 0,
			stars: app.averageUserRating == null ? null : round1(app.averageUserRating),
			price: app.price ?? 0,
			formattedPrice: app.formattedPrice ?? null,
			updated: (app.currentVersionReleaseDate ?? '').slice(0, 10) || null,
			daysSinceUpdate: daysElapsed(app.currentVersionReleaseDate),
			hasIap: await sellsInApp(app.trackViewUrl),
			url: app.trackViewUrl ?? null,
		});
	}
	return out;
}

/**
 * The positioning claims a category has already made.
 *
 * The second failure Glovebox hit: "car maintenance log, but private and
 * offline" was not a differentiator, it was the third-most common sentence in
 * the category — because every other solo dev asked the same model for an angle
 * and got the same list. Reading it off the incumbents' own descriptions turns
 * "my angle" into a countable fact before a line of code exists.
 *
 * Not exhaustive by design: it is a list of the positions LLM-generated app
 * ideas converge on, which is exactly the list you must not pick from blind.
 */
/** @type {[string, RegExp][]} */
const CLAIMS = [
	['offline', /\boffline\b|\bwithout (?:an? )?internet\b|\bno (?:internet|wifi|connection)\b/i],
	['privacy / on-device', /\bprivac|\bprivate\b|\bon[- ]device\b|\bnever (?:sold|shared|leaves)\b|\bno tracking\b/i],
	['no account', /\bno (?:account|sign[- ]?up|signup|login|log[- ]in|registration)\b/i],
	['no ads', /\bno ads\b|\bad[- ]free\b|\bwithout ads\b/i],
	['free / one-time', /\b(?:100%|completely|totally) free\b|\bone[- ]time (?:purchase|payment)\b|\bno subscription/i],
	['icloud sync', /\bicloud\b|\bsyncs? across\b|\bcross[- ]device\b/i],
	['export (csv/pdf)', /\bcsv\b|\bexport\b|\bpdf\b/i],
	['reminders', /\bremind|\bnotif/i],
	['widgets', /\bwidget/i],
	['siri / shortcuts', /\bsiri\b|\bshortcuts\b/i],
	['apple watch', /\bapple watch\b|\bwatchos\b/i],
	['scan / ocr', /\bscan(?:ner|ning|s)?\b|\bocr\b/i],
	['ai', /\b(?:ai|a\.i\.|gpt|chatgpt|machine learning)\b/i],
	['multi-item / family', /\bmultiple (?:vehicles|cars|items|pets|properties)\b|\bfamily sharing\b|\bunlimited\b/i],
];

/**
 * Which of those claims the live top-10 already makes, most-taken first.
 * One lookup call for ten ids — descriptions are only in `lookup`, not `search`.
 * @param {import('./scout-scoring.mjs').ScoutApp[]} results
 * @param {Market} market
 * @returns {Promise<import('./scout-scoring.mjs').ClaimsAudit>}
 */
export async function claimsAudit(results, market) {
	const ids = results.map((r) => r.trackId).filter(Boolean);
	if (!ids.length) return { corpus: 0, claims: [] };
	/** @type {import('./scout-scoring.mjs').ScoutApp[]} */
	const apps = await lookup(ids, { country: market.country });
	const texts = apps.map((a) => `${a.trackName ?? ''} ${a.description ?? ''}`);
	if (!texts.length) return { corpus: 0, claims: [] };
	const claims = CLAIMS.map(([label, re]) => {
		const holders = apps.filter((_, i) => re.test(texts[i])).map((a) => a.trackName ?? null);
		return { claim: label, apps: holders.length, share: Math.round((100 * holders.length) / texts.length), holders };
	})
		.filter((r) => r.apps > 0)
		.sort((a, b) => b.apps - a.apps);
	return { corpus: texts.length, claims };
}

/**
 * Read and validate a brief artifact. One owner for the format
 * `ship new --from` consumes; resolves to the parsed document with `file`
 * added, or throws a {@link ShipError} on a missing, unparseable or
 * malformed brief.
 * @param {string|boolean|undefined} path
 */
export async function readBrief(path) {
	const file = isAbsolute(String(path)) ? String(path) : resolve(process.cwd(), String(path));
	if (!existsSync(file))
		throw new ShipError(`no scout brief at ${file}`, {
			hint: 'run `ship scout brief "your keyword"` — it writes one under scout/<market>/',
		});
	let data;
	try {
		data = JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err instanceof Error ? err.message : String(err) });
	}
	if (!data?.term || !data?.listing?.name)
		throw new ShipError(`${file} is not a scout brief`, {
			hint: 'expected { term, listing: { name, subtitle, keywords, description } } — regenerate it with `ship scout brief`',
		});
	return { ...data, file };
}

/** `--from`, else `--term`, else the only brief under --out. Guessing between two is worse than asking. */
/**
 * @param {Flags} flags
 * @param {Market} market
 * @returns {Promise<string>}
 */
export async function resolveBrief(flags, market) {
	if (flags.from) return String(flags.from);
	if (flags.term) return artifactFile(flags, market, slugifyAscii(String(flags.term)), 'brief');
	const dir = join(outRoot(flags), market.country.toLowerCase());
	const found = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('-brief.json')).sort() : [];
	if (found.length === 1) return join(dir, found[0]);
	if (!found.length)
		throw new ShipError(`scout new: no brief under ${dir}`, {
			hint: 'run `ship scout brief "your keyword"` first — the brief is what names the app',
		});
	throw new ShipError(`scout new: ${found.length} briefs under ${dir}`, {
		hint: `pick one: --from ${join(dir, found[0])}`,
	});
}
