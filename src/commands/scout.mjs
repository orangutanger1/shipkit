// ship scout — the front door, for the day before there is a repo.
//
// `ship aso` loads ship.config.json, which needs an app, which needs a name:
// the keyword research that is supposed to justify building the thing was
// gated behind the thing. Nothing in this module reads a config, a credential
// or a repo — it is public storefront data only, written under ./scout/ from
// whatever directory you happen to be standing in.
//
// `brief` is the artifact that ends the argument. Its three gates are the ways
// a keyword actually kills a solo launch, and every verdict line prints the
// number that triggered it, because "too competitive" is not a finding anyone
// can act on. Monetization evidence is part of the same call: a category where
// every incumbent is free and sells nothing inside is a category you cannot
// charge in — and the iTunes lookup API has no in-app-purchase field at all,
// so that one fact is read off the storefront product page instead.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import {
	LOCALE_MARKETS,
	StorefrontWall,
	brandCollisions,
	commodity as commodityOf,
	demandTable,
	demand as demandOf,
	harvest,
	hints,
	lookup,
	packKeywords,
	pickCandidates,
	progressLine,
	saturation as saturationOf,
	score,
	scoreAll,
	topResults,
	useCache,
} from '../lib/appstore.mjs';
import { normaliseKeywords } from '../lib/locales.mjs';
import { brandTokens, charCount, indexedWords, stopwordsFor, tokenSupport, words } from '../lib/text.mjs';

export const help = `
${c.bold('ship scout')} ${c.dim('— research a keyword before the app exists')}

${c.dim('usage:')} ship scout <subcommand> [flags]

  ${c.cyan('terms')} ${c.dim('<seed…>')}   sweep autocomplete across a category and score every candidate
  ${c.cyan('brief')} ${c.dim('<term>')}    go/no-go on one term: demand, incumbents, flood check, drafted listing
  ${c.cyan('names')} ${c.dim('<name>')}    is this brand word already on the storefront ${c.dim('(run before you name it)')}
  ${c.cyan('new')} ${c.dim('<slug>')}      scaffold the app from a brief ${c.dim('(ship new --from)')}

${c.bold('Flags')}
  ${c.cyan('--market <cc>')}     storefront to research ${c.dim('(default: us)')}
  ${c.cyan('--out <dir>')}       artifact root ${c.dim('(default: ./scout)')}
  ${c.cyan('--limit <n>')}       terms to score ${c.dim('(terms, default 40)')}
  ${c.cyan('--words <n>')}       max words per candidate ${c.dim('(terms, default 4)')}
  ${c.cyan('--moat <n>')}        top-3 median ratings that count as defended ${c.dim('(default 50000)')}
  ${c.cyan('--min-volume <n>')}  demand floor, 0-100 ${c.dim('(default 10)')}
  ${c.cyan('--max-saturation <n>')} flood cap, 0-100 ${c.dim('(default 40)')}
  ${c.cyan('--max-clones <n>')}  top-10 apps already named after the term ${c.dim('(default 2)')}
  ${c.cyan('--max-commodity <n>')} % of the top-10 that is already this product, any age ${c.dim('(default 25)')}
  ${c.cyan('--fresh-days <n>')}  how new counts as a new entrant ${c.dim('(default 365)')}
  ${c.cyan('--sub-price <n>')}   monthly subscription price → the ASA CPI band you can afford
  ${c.cyan('--strict')}          a NO-GO verdict exits 1 ${c.dim('(default: prints and exits 0)')}
  ${c.cyan('--refresh')}         ignore the cached storefront responses
  ${c.cyan('--from <file>')}     brief to scaffold from ${c.dim('(new; default: the only brief in --out)')}
  ${c.cyan('--json')}            emit the artifact and nothing else

${c.dim('Artifacts: scout/<market>/<slug>-{terms,brief,names}.json — no repo, no config, no credentials.')}
${c.dim('Order: terms → brief → names → new')}
`;

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

const NUM = new Intl.NumberFormat('en-US');
const fmt = (n) => NUM.format(Math.round(Number(n) || 0));
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};
const round2 = (n) => Math.round(n * 100) / 100;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const daysSince = (iso) => {
	const t = Date.parse(iso ?? '');
	return Number.isNaN(t) ? null : Math.round((Date.now() - t) / 86_400_000);
};

/** Storefront code (`us`, `de`) → the { country, lang } pair search and hints need. */
const MARKETS = new Map();
for (const m of Object.values(LOCALE_MARKETS)) if (!MARKETS.has(m.country)) MARKETS.set(m.country, m);

function marketOf(code) {
	const key = String(code ?? 'us').toUpperCase();
	const market = MARKETS.get(key);
	if (!market)
		throw new ShipError(`scout: no App Store storefront "${code}"`, {
			hint: `supported: ${[...MARKETS.keys()].join(' ').toLowerCase()}`,
		});
	return market;
}

/**
 * Filename stem for a term. Non-Latin scripts leave nothing to slugify, so they
 * get a stable hash rather than every Japanese term colliding on one file.
 */
export function slugify(term) {
	const ascii = String(term ?? '')
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (ascii) return ascii.slice(0, 48).replace(/-+$/, '');
	return `t-${createHash('sha1').update(String(term ?? '')).digest('hex').slice(0, 8)}`;
}

const outRoot = (flags) => resolve(String(flags.out ?? 'scout'));
const artifactFile = (flags, market, slug, kind) =>
	join(outRoot(flags), market.country.toLowerCase(), `${slug}-${kind}.json`);

async function writeArtifact(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

/**
 * Autocomplete and top-10 answers are stable for days and Apple throttles to
 * one request per storefront per second. Scout is iterative by nature — you
 * brief five terms before you like one — so every response is cached.
 */
const enableCache = (flags) =>
	useCache({ dir: join(outRoot(flags), '.cache'), mode: flags.refresh ? 'refresh' : 'on' });

/** Progress belongs on stdout, which --json owns exclusively. */
const reporter = (flags) => (flags.json ? undefined : progressLine);

// ─── gates ───────────────────────────────────────────────────────────────────

/**
 * Go/no-go on one term. Pure and exported: the thresholds are the product
 * decision, so they get unit tests rather than a live storefront at 1 req/s.
 * @param {{term:string, results:number, demand:number, exactTitleMatches:number,
 *          top3MedianRatings:number, freeTop10:number, saturation?:number,
 *          newEntrants?:number, freshUnproven?:number, cloneTitles?:number,
 *          clones?:number, cloneApps?:string[], freshDays?:number}} m
 * @param {{moat?:number, minVolume?:number, exactCap?:number, saturationCap?:number,
 *          cloneCap?:number}} [thresholds]
 * @returns {{go:boolean, reasons:{gate:string, value:number, threshold:number, message:string}[]}}
 */
export function verdict(
	m,
	{
		moat = GATES.moat,
		minVolume = GATES.minVolume,
		exactCap = GATES.exactTitleMatches,
		saturationCap = GATES.saturation,
		cloneCap = GATES.clones,
		commodityCap = GATES.commodity,
	} = {},
) {
	const reasons = [];
	const top = m.results ?? 10;

	// A free incumbent with a review moat cannot be beaten on price or on trust,
	// and you have neither. Paid-only incumbents leave "the free one" open.
	if (m.top3MedianRatings > moat && m.freeTop10 > 0)
		reasons.push({
			gate: 'moat',
			value: m.top3MedianRatings,
			threshold: moat,
			message: `top-3 median ${fmt(m.top3MedianRatings)} ratings is over the ${fmt(moat)} moat, and ${m.freeTop10} of the top ${top} are free — you would have to out-review an incumbent and undercut free`,
		});

	if (m.demand < minVolume)
		reasons.push({
			gate: 'demand',
			value: m.demand,
			threshold: minVolume,
			message: `demand ${m.demand} is under the ${minVolume} floor — autocomplete barely surfaces "${m.term}", so ranking first for it wins nothing`,
		});

	if (m.exactTitleMatches > exactCap)
		reasons.push({
			gate: 'crowding',
			value: m.exactTitleMatches,
			threshold: exactCap,
			message: `${m.exactTitleMatches} of the top ${top} put "${m.term}" in the title, over the ${exactCap} cap — the phrase is the category's naming convention, not a gap`,
		});

	// The flood gate. Every gate above reads incumbent strength, so a category
	// twenty other people shipped into last month passes all of them: no moat,
	// no reviews, weak apps. What it does not have is room, and the reviews that
	// decide the ranking six months out have not been written for anyone yet.
	if ((m.saturation ?? 0) > saturationCap)
		reasons.push({
			gate: 'saturation',
			value: m.saturation,
			threshold: saturationCap,
			message: `saturation ${m.saturation} is over the ${saturationCap} cap — ${m.newEntrants ?? 0} of the top ${top} first shipped inside ${m.freshDays ?? 365} days, ${m.freshUnproven ?? 0} of those still have under 25 ratings and ${m.cloneTitles ?? 0} already put "${m.term}" in the title. This is not an unserved niche, it is a race that started before you; the weak incumbents this term scores well on are other people's launches from last year`,
		});

	// The clone gate: not "is this category crowded" but "has somebody already
	// shipped the app this brief would produce". An app titled after the query
	// with no ratings is that, whatever its release date, and the count survives
	// two entrenched incumbents keeping the blended saturation score down.
	if ((m.clones ?? 0) > cloneCap)
		reasons.push({
			gate: 'clones',
			value: m.clones,
			threshold: cloneCap,
			message: `${m.clones} of the top ${top} are already this app — titled after "${m.term}", shipped inside ${m.freshDays ?? 365} days, still under 25 ratings${m.cloneApps?.length ? ` (${m.cloneApps.slice(0, 4).join(', ')})` : ''} — over the ${cloneCap} cap. The pipeline that handed you this term handed it to them first; building it again competes with your own idea`,
		});

	// The commodity gate: is this app already the category? `clones` only sees a
	// literal substring of the whole query, so it reads 0 on a page of Aquarium
	// Manager / AquaLens / Tank Log — permuted tokens are the naming convention
	// in every `<subject> log` category, and that is where the term is deadest.
	// Traction decides which sentence gets printed, because the two failures
	// have opposite shapes and only one of them is survivable by shipping early.
	if ((m.commodity ?? 0) > commodityCap)
		reasons.push({
			gate: 'commodity',
			value: m.commodity,
			threshold: commodityCap,
			message:
				`${m.commodityMatches ?? 0} of the top ${top} are already this product — a subject word plus a logging noun, in any order, at any age (${m.commodityApps?.slice(0, 4).join(', ') ?? ''}) — ${m.commodity}% of the page, over the ${commodityCap}% cap. ` +
				((m.commodityProven ?? 0) > 0
					? `${m.commodityProven} of them carry real ratings, so this is a served market, not a gap: the category is solved and you would be the next identical entry on a page that already converts`
					: `none of them has traction, so the category is a race nobody has won — the demand that was supposed to justify it has not paid anyone yet`),
		});

	return { go: reasons.length === 0, reasons };
}

/**
 * What a paid install may cost before Search Ads stops paying for itself.
 * Apple keeps 30% in year one, a solo subscription app's median subscriber is
 * gone inside three months, and 2-5% of installs ever subscribe. Above the top
 * of this band ASA is a marketing expense, not acquisition.
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

// ─── drafted listing ─────────────────────────────────────────────────────────

const titleCase = (s) =>
	String(s)
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w[0].toLocaleUpperCase() + w.slice(1))
		.join(' ');

/** Longest leading run of whole words that fits `limit` code points; hard-cut if even one does not. */
function fitWords(text, limit) {
	const parts = String(text).split(/\s+/).filter(Boolean);
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
export function categoryVocabulary(results, locale) {
	const brands = new Set();
	for (const r of results) for (const w of indexedWords(r.sellerName ?? '', locale)) brands.add(w);

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
export function harvestBrands(suggestions, term, locale = 'en-US') {
	const needle = String(term ?? '').trim().toLocaleLowerCase();
	if (!needle) return new Set();
	const nameSide = new Set();
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
 * Brief → the staged listing `ship new --from` writes. The notes block is the
 * point: six weeks later the only surviving record of why these 100 characters
 * were chosen is the one that shipped inside the file they live in.
 */
export function listingFromBrief(brief, { locale = 'en-US' } = {}) {
	const l = brief.listing ?? {};
	const m = brief.metrics ?? {};
	const v = brief.verdict ?? {};
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
			scores: {
				demand: brief.demand ?? null,
				competition: brief.competition ?? null,
				opportunity: brief.opportunity ?? null,
				saturation: brief.saturation?.score ?? null,
				// The number that decides most verdicts belongs in the record that
				// survives: six weeks on, "why did we not build this" is answered
				// by the share, not by the fact that a gate fired.
				commodity: brief.commodity?.share ?? null,
				viability: brief.viability ?? null,
			},
			evidence: {
				top3MedianRatings: m.top3MedianRatings ?? null,
				exactTitleMatches: m.exactTitleMatches ?? null,
				freeTop10: m.freeTop10 ?? null,
				newEntrants: m.newEntrants ?? null,
				freshUnproven: m.freshUnproven ?? null,
				claimsAlreadyTaken: (brief.claims?.claims ?? []).filter((r) => r.share >= 40).map((r) => r.claim),
				incumbents: (brief.incumbents ?? []).map((a) => `${a.name} · ${fmt(a.ratings)} ratings`),
			},
			verdict: v.go === undefined ? null : v.go ? 'GO' : `NO-GO — ${(v.reasons ?? []).map((r) => r.message).join('; ')}`,
			rewrite: [
				`name, subtitle and keywords are drafted from "${brief.term}" — edit them, then \`ship meta lint\``,
				`keywords use ${charCount(l.keywords ?? '')}/100 characters; every space after a comma costs one`,
				'the description is a skeleton — its last sentence says what to replace it with',
				'differentiation must be something not in notes.evidence.claimsAlreadyTaken — those sentences are already in every competitor listing',
			],
		},
	};
}

/** Read and validate a brief artifact. One owner for the format `ship new --from` consumes. */
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
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
	if (!data?.term || !data?.listing?.name)
		throw new ShipError(`${file} is not a scout brief`, {
			hint: 'expected { term, listing: { name, subtitle, keywords, description } } — regenerate it with `ship scout brief`',
		});
	return { ...data, file };
}

// ─── terms ───────────────────────────────────────────────────────────────────

async function terms({ args, flags }) {
	const seeds = args.map((s) => s.trim()).filter(Boolean);
	if (!seeds.length)
		throw new ShipError('scout terms: at least one seed is required', {
			hint: 'ship scout terms "car maintenance" "service log"',
		});
	const market = marketOf(flags.market);
	enableCache(flags);
	const maxWords = num(flags.words, 4);
	const limit = Math.max(1, num(flags.limit, 40));

	if (!flags.json) {
		heading(`Scout terms ${c.dim(`(${market.country})`)}`);
		info(`${seeds.length} seed${seeds.length === 1 ? '' : 's'}: ${c.cyan(seeds.join(', '))}`);
	}

	let candidates;
	try {
		candidates = await harvest(seeds, market.country, { onProgress: reporter(flags) });
	} catch (err) {
		// A wall mid-sweep still leaves everything harvested before it; scoring
		// that is strictly better than throwing the paid-for requests away.
		if (!(err instanceof StorefrontWall) || !err.partial) throw err;
		candidates = err.partial;
		warn(`${err.message} — keeping the ${Object.keys(candidates).length} terms already harvested`);
	}

	const demands = demandTable(candidates);
	const byDemand = (a, b) => (demands.get(b)?.demand ?? 0) - (demands.get(a)?.demand ?? 0) || a.length - b.length;
	const picked = pickCandidates(Object.keys(candidates), { maxWords }).sort(byDemand).slice(0, limit);
	const scored = await scoreAll(picked, market, { demands, onProgress: reporter(flags) });

	const artifact = {
		generatedAt: new Date().toISOString(),
		market,
		seeds,
		candidates,
		terms: scored,
	};
	const file = await writeArtifact(artifactFile(flags, market, slugify(seeds[0]), 'terms'), artifact);
	if (flags.json) return emit(artifact);

	table(scored.slice(0, 15), [
		{ header: 'term', get: (t) => t.keyword },
		{ header: 'demand', get: (t) => t.demand },
		{ header: 'compet', get: (t) => t.competition },
		{ header: 'opp', get: (t) => t.opportunity },
		{ header: 'sat', get: (t) => (t.saturation > GATES.saturation ? c.red(String(t.saturation)) : String(t.saturation)) },
		{ header: 'viable', get: (t) => t.viability },
		{ header: 'new', get: (t) => `${t.newEntrants}/${t.results}` },
		{ header: 'clones', get: (t) => (t.clones > GATES.clones ? c.red(`${t.clones}/${t.results}`) : `${t.clones}/${t.results}`) },
		{ header: 'median ratings', get: (t) => fmt(t.medianRatings) },
		{ header: 'exact', get: (t) => `${t.exactTitleMatches}/${t.results}` },
	]);
	good(`${Object.keys(candidates).length} candidates, ${scored.length} scored → ${c.dim(file)}`);
	if (!scored.length) {
		warn('nothing scored — Apple is throttling this storefront; retry in a minute, the harvest is cached');
		return 1;
	}
	const flooded = scored.filter((t) => t.saturation > GATES.saturation || t.clones > GATES.clones);
	if (flooded.length)
		warn(
			`${flooded.length}/${scored.length} terms are already being built: ${flooded.slice(0, 5).map((t) => `"${t.keyword}" (${t.clones} clones, sat ${t.saturation})`).join(', ')}${flooded.length > 5 ? ', …' : ''} — apps titled after the term with no reviews, or a top-10 mostly shipped this year. Their weak-incumbent scores are other people's launches, not a gap`,
		);
	// Ranked by viability, so row one is not the flooded term with the prettiest
	// opportunity score. Saying so out loud matters: the sort order is the advice.
	note(`sorted by viability (opportunity discounted by saturation), not opportunity`);
	note(`next: ship scout brief "${scored[0].keyword}" --market ${market.country.toLowerCase()}`);
	return 0;
}

// ─── brief ───────────────────────────────────────────────────────────────────

/**
 * The term's own autocomplete row. Apple orders it by popularity, so the
 * position the term holds in it is the demand signal, and the rest of the row
 * is the keyword pool — those are the queries people actually finish typing.
 */
async function autocomplete(term, country) {
	const probes = term.length > 6 ? [term, term.slice(0, -2)] : [term];
	const pool = [];
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
async function priorSweep(flags, market, term) {
	const dir = join(outRoot(flags), market.country.toLowerCase());
	if (!existsSync(dir)) return null;
	for (const name of (await readdir(dir)).filter((f) => f.endsWith('-terms.json')).sort()) {
		const file = join(dir, name);
		let doc;
		try {
			doc = JSON.parse(await readFile(file, 'utf8'));
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

/** Top-3 incumbents, refreshed through lookup and annotated with monetization evidence. */
async function incumbentsOf(results, market) {
	const top3 = results.slice(0, 3);
	const fresh = new Map((await lookup(top3.map((r) => r.trackId), { country: market.country })).map((a) => [a.trackId, a]));
	const out = [];
	for (const r of top3) {
		const app = fresh.get(r.trackId) ?? r;
		out.push({
			name: app.trackName ?? null,
			id: app.trackId ?? null,
			seller: app.sellerName ?? null,
			ratings: app.userRatingCount ?? 0,
			stars: app.averageUserRating == null ? null : Math.round(app.averageUserRating * 10) / 10,
			price: app.price ?? 0,
			formattedPrice: app.formattedPrice ?? null,
			updated: (app.currentVersionReleaseDate ?? '').slice(0, 10) || null,
			daysSinceUpdate: daysSince(app.currentVersionReleaseDate),
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
 */
async function claimsAudit(results, market) {
	const ids = results.map((r) => r.trackId).filter(Boolean);
	if (!ids.length) return { corpus: 0, claims: [] };
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

const yesNo = (v) => (v === null ? '?' : v ? 'yes' : 'no');

function printBrief(b) {
	heading(`Brief · ${b.term} ${c.dim(`(${b.market.country})`)}`);
	info(
		`demand ${c.bold(b.demand)} · competition ${c.bold(b.competition)} · opportunity ${c.bold(b.opportunity)} · saturation ${c.bold(b.saturation.score)} → viability ${c.bold(b.viability)} ${c.dim(`(${b.demandSource})`)}`,
	);

	step('Incumbents');
	table(b.incumbents, [
		{ header: 'app', get: (a) => a.name },
		{ header: 'ratings', get: (a) => fmt(a.ratings) },
		{ header: 'stars', get: (a) => (a.stars == null ? '—' : a.stars.toFixed(1)) },
		{ header: 'price', get: (a) => a.formattedPrice ?? money(a.price) },
		{ header: 'IAP', get: (a) => yesNo(a.hasIap) },
		{ header: 'updated', get: (a) => (a.updated ? `${a.updated} (${a.daysSinceUpdate}d)` : '—') },
	]);
	info(
		`review moat: top-3 median ${c.bold(fmt(b.reviewMoat.top3Median))} · top-10 median ${fmt(b.reviewMoat.top10Median)} · biggest ${fmt(b.reviewMoat.max)}`,
	);
	info(
		`monetization: ${b.metrics.paidTop10}/${b.metrics.results} paid, ${b.metrics.freeTop10} free, ${b.metrics.iapTop3}/3 of the leaders sell in-app`,
	);
	if (!b.metrics.paidTop10 && !b.metrics.iapTop3)
		warn('no evidence anybody in this top-10 charges — a category with no proven payer is a category you cannot charge in');

	step('Flood check');
	const s = b.saturation;
	info(
		`${s.newEntrants}/${s.results} of the top ${s.results} first shipped inside ${s.freshDays} days (${s.newEntrantsQuarter} inside 90), ${s.freshUnproven} of those have under ${s.tractionFloor} ratings, ${s.cloneTitles} already carry "${b.term}" in the title`,
	);
	info(`median age ${s.medianAgeDays}d · youngest ${s.youngestDays === null ? '—' : `${s.youngestDays}d`} · ${s.distinctSellers} distinct sellers`);
	info(
		`already-this-app: ${s.clones}/${s.results} carry "${b.term}" in the title, shipped inside ${s.freshDays} days, still under ${s.tractionFloor} ratings${s.cloneApps.length ? ` — ${s.cloneApps.join(', ')}` : ''}`,
	);
	table(
		s.apps.slice(0, 10),
		[
			{ header: 'app', get: (a) => a.name },
			{ header: 'released', get: (a) => a.released ?? '—' },
			{ header: 'age', get: (a) => (a.ageDays === null ? '—' : `${a.ageDays}d`) },
			{ header: 'ratings', get: (a) => fmt(a.ratings) },
			{ header: 'in title', get: (a) => (a.titleMatch ? 'yes' : 'no') },
		],
	);
	if (s.score > b.gates.saturation)
		warn(
			`saturation ${s.score} over the ${b.gates.saturation} cap — this top-10 is a stampede, not a gap. Whatever pointed you at "${b.term}" pointed everyone else at it too`,
		);
	if (s.clones > b.gates.clones)
		warn(
			`${s.clones} of the top ${s.results} are the app this brief would produce, over the ${b.gates.clones} cap — read their listings before writing a line of code`,
		);

	step('Same-product check');
	const cm = b.commodity;
	info(
		`${cm.matches}/${cm.results} of the top ${cm.results} are this product — a subject word (${cm.subjects.join('/')}) plus a logging noun, any order, any age — ${c.bold(`${cm.share}%`)} of the page${cm.apps.length ? `: ${cm.apps.map((a) => `${a.name} (${fmt(a.ratings)})`).join(', ')}` : ''}`,
	);
	if (cm.matches)
		info(
			`${cm.proven} of them have real traction, ${cm.unproven} do not — ${cm.proven > cm.unproven ? 'a solved category with paying users, which is the harder of the two' : 'a race that has not paid anyone yet'}`,
		);
	if (cm.share > b.gates.commodity)
		warn(
			`commodity ${cm.share}% over the ${b.gates.commodity}% cap — the storefront page for "${b.term}" is a column of the same app. This is the number "clones" cannot see: it matches vocabulary, not word order`,
		);

	step('Positioning already taken');
	if (!b.claims.claims.length) info('no recognised claim appears in these listings — verify by reading two of them');
	else {
		table(b.claims.claims.slice(0, 10), [
			{ header: 'claim', get: (r) => r.claim },
			{ header: 'apps', get: (r) => `${r.apps}/${b.claims.corpus}` },
			{ header: 'example', get: (r) => r.holders[0] ?? '—' },
		]);
		const taken = b.claims.claims.filter((r) => r.share >= 40).map((r) => r.claim);
		if (taken.length)
			warn(
				`already the category norm: ${taken.join(', ')} — picking any of these as "the angle" ships a clone. Your differentiation has to be something not on this table`,
			);
	}

	step('Drafted listing');
	note(`name      ${b.listing.name} ${c.dim(`(${charCount(b.listing.name)}/30)`)}`);
	note(`subtitle  ${b.listing.subtitle} ${c.dim(`(${charCount(b.listing.subtitle)}/30)`)}`);
	note(`keywords  ${b.listing.keywords} ${c.dim(`(${charCount(b.listing.keywords)}/100)`)}`);
	note(`description ${c.dim(`${charCount(b.listing.description)} chars, skeleton`)}`);
	if (!b.listing.coversTerm) warn(`"${b.term}" does not fit in 30 characters — the drafted name is truncated`);
	if (charCount(b.listing.keywords) < 50)
		warn(
			`only ${charCount(b.listing.keywords)}/100 keyword characters could be filled from evidence — widen the sweep (\`ship scout terms\` with more seeds) rather than inventing terms`,
		);

	if (b.asa) {
		step('Apple Search Ads');
		info(
			`at ${money(b.asa.subPrice)}/month a paid install is worth ${money(b.asa.cpi.low)}–${money(b.asa.cpi.high)} ${c.dim(`(${b.asa.derivation})`)}`,
		);
	}
}

async function brief({ args, flags }) {
	const term = args.join(' ').trim().toLocaleLowerCase();
	if (!term)
		throw new ShipError('scout brief: a term is required', {
			hint: 'ship scout brief "car maintenance log"',
		});
	const market = marketOf(flags.market);
	enableCache(flags);
	const moat = num(flags.moat, GATES.moat);
	const minVolume = num(flags['min-volume'] ?? flags.minVolume, GATES.minVolume);
	const exactCap = num(flags['max-exact'] ?? flags.exactCap, GATES.exactTitleMatches);
	const saturationCap = num(flags['max-saturation'] ?? flags.saturationCap, GATES.saturation);
	const cloneCap = num(flags['max-clones'] ?? flags.cloneCap, GATES.clones);
	const commodityCap = num(flags['max-commodity'] ?? flags.commodityCap, GATES.commodity);
	const freshDays = num(flags['fresh-days'] ?? flags.freshDays, 365);
	const subPrice = flags['sub-price'] ?? flags.subPrice;

	const results = await topResults(term, { ...market, limit: 10 });
	if (!results?.length)
		throw new ShipError(`no App Store results for "${term}" in ${market.country}`, {
			hint: 'check the spelling, or wait a minute — Apple answers a burst of search calls with 403s',
		});

	const prior = await priorSweep(flags, market, term);
	const live = prior?.demand === null || prior === null ? await autocomplete(term, market.country) : null;
	const seeds = prior?.seeds?.length ? prior.seeds : [term];
	const rank = prior?.rank ?? live?.rank ?? null;
	const demand = prior?.demand ?? demandOf({ seeds, rank }, { maxRank: 12 });
	const suggestions = live?.suggestions ?? (await autocomplete(term, market.country)).suggestions;
	// Scored neighbours from the sweep outrank raw autocomplete: they already
	// carry demand × competition, and packKeywords takes the pool in order.
	const pool = [...new Set([...(prior?.cohort ?? []), ...suggestions])];
	// Two sources, because they see different competitors: the top-10 names the
	// apps that rank, the harvest names the apps Apple autocompletes. An app can
	// be in the second and not the first, and those were the brands the drafted
	// keyword field was spending characters on.
	const brands = new Set([
		...brandTokens(
			[...results.map((r) => ({ name: r.trackName, seller: r.sellerName })), ...(prior?.apps ?? [])],
			'en-US',
		),
		...harvestBrands(pool, term, 'en-US'),
	]);

	const scored = score(term, results, { demand });
	const flood = saturationOf(results, { term, freshDays });
	const same = commodityOf(results, { term });
	const ratings = results.map((r) => r.userRatingCount ?? 0);
	const incumbents = await incumbentsOf(results, market);
	const claims = await claimsAudit(results, market);

	const metrics = {
		term,
		results: results.length,
		demand: scored.demand,
		exactTitleMatches: scored.exactTitleMatches,
		weakAppsTop10: scored.weakAppsTop10,
		medianRatings: scored.medianRatings,
		top3MedianRatings: median(incumbents.map((a) => a.ratings)),
		paidTop10: scored.paidTop10,
		freeTop10: results.filter((r) => !((r.price ?? 0) > 0)).length,
		iapTop3: incumbents.filter((a) => a.hasIap === true).length,
		saturation: flood.score,
		newEntrants: flood.newEntrants,
		freshUnproven: flood.freshUnproven,
		cloneTitles: flood.cloneTitles,
		clones: flood.clones,
		cloneApps: flood.cloneApps,
		freshDays: flood.freshDays,
		commodity: same.share,
		commodityMatches: same.matches,
		commodityProven: same.proven,
		commodityApps: same.apps.map((a) => a.name),
	};

	const artifact = {
		generatedAt: new Date().toISOString(),
		term,
		slug: slugify(term),
		market,
		seeds,
		rank,
		demand: scored.demand,
		demandSource: prior?.demand != null ? `scored in ${prior.file}` : rank === null ? 'not in autocomplete' : `autocomplete rank ${rank}`,
		competition: scored.competition,
		opportunity: scored.opportunity,
		saturation: flood,
		commodity: same,
		// Both discounts apply because they are different failures: a stampede
		// prices in who else is racing, commodity prices in that the product
		// already exists whether or not anyone is racing. A term can be quiet
		// and still be solved, which is the case the old number scored highest.
		viability: Math.round(scored.opportunity * (1 - flood.score / 100) * (1 - same.share / 100)),
		claims,
		metrics,
		reviewMoat: {
			top3Median: metrics.top3MedianRatings,
			top10Median: scored.medianRatings,
			max: Math.max(...ratings),
		},
		incumbents,
		related: suggestions.slice(0, 25),
		listing: draftListing({ term, suggestions: pool, results, brands }),
		asa: subPrice === undefined ? null : cpiBand(Math.max(0.01, num(subPrice, 4.99))),
		gates: {
			moat,
			minVolume,
			exactTitleMatches: exactCap,
			saturation: saturationCap,
			clones: cloneCap,
			commodity: commodityCap,
		},
		verdict: verdict(metrics, { moat, minVolume, exactCap, saturationCap, cloneCap, commodityCap }),
	};

	const file = await writeArtifact(artifactFile(flags, market, artifact.slug, 'brief'), artifact);
	if (flags.json) return emit(artifact);

	printBrief(artifact);
	step('Verdict');
	if (artifact.verdict.go) good(`${c.green('GO')} — no gate tripped`);
	else {
		process.stdout.write(`${c.red(`✗ NO-GO — ${artifact.verdict.reasons.length} gate(s) tripped`)}\n`);
		for (const r of artifact.verdict.reasons) note(`${r.gate}: ${r.message}`);
	}
	good(`wrote ${c.dim(file)}`);
	// A NO-GO that still ends with "next: scaffold it" is not a gate, it is a
	// disclaimer. The next step for a tripped term is a different term.
	if (artifact.verdict.go) {
		note(`next: ship scout names "<your brand word>" --market ${market.country.toLowerCase()}`);
		note(`then: ship scout new ${slugify(term)} --from ${file}`);
	} else {
		note(`next: a different term — ${c.dim(`ship scout terms "<seeds from something you actually know>" --market ${market.country.toLowerCase()}`)}`);
		// Name the flags for the gates that actually tripped. A generic hint sends
		// you looking for a threshold that was never the one in the way.
		const overrides = {
			moat: '--moat',
			demand: '--min-volume',
			crowding: '--max-exact',
			saturation: '--max-saturation',
			clones: '--max-clones',
			commodity: '--max-commodity',
		};
		const flagsFor = [...new Set(artifact.verdict.reasons.map((r) => overrides[r.gate]).filter(Boolean))];
		note(
			`to build it anyway you need an answer to the tripped gate, not a rerun: ${flagsFor.join(' / ')} override the threshold, they do not change the storefront`,
		);
	}
	return flags.strict && !artifact.verdict.go ? 1 : 0;
}

// ─── names ───────────────────────────────────────────────────────────────────

/**
 * Is the brand word already on the storefront?
 *
 * Glovebox shipped as `Glovebox` next to an existing `Car Maintenance Log -
 * Glovebox`. Nothing in the keyword pipeline could have caught it: the
 * collision is in a suffix nobody searches, and the category sweep never
 * queries the brand word on its own. So this queries the brand word on its own.
 *
 * The metaphor being obvious is the problem — "glovebox" for a car app is the
 * first association any model produces, which is exactly why it was taken.
 */
async function names({ args, flags }) {
	const name = args.join(' ').trim();
	if (!name)
		throw new ShipError('scout names: a name is required', {
			hint: 'ship scout names "glovebox"',
		});
	const market = marketOf(flags.market);
	enableCache(flags);

	const results = (await topResults(name, { ...market, limit: 50 })) ?? [];
	const hits = brandCollisions(name, results);
	// A brand word Apple's own autocomplete already completes into somebody's
	// product name is spoken for even when the title match is only partial.
	const suggestions = await hints(name.toLocaleLowerCase(), market.country);

	const artifact = {
		generatedAt: new Date().toISOString(),
		name,
		slug: slugify(name),
		market,
		searched: results.length,
		collisions: hits,
		exact: hits.filter((h) => h.exact).length,
		autocomplete: suggestions.slice(0, 15),
		verdict: hits.length
			? { free: false, reason: `${hits.length} live app${hits.length === 1 ? '' : 's'} already carry "${name}" as a whole word in the title` }
			: { free: true, reason: `no title in the top ${results.length} for "${name}" carries it as a whole word` },
	};

	const file = await writeArtifact(artifactFile(flags, market, artifact.slug, 'names'), artifact);
	if (flags.json) return emit(artifact);

	heading(`Names · ${name} ${c.dim(`(${market.country})`)}`);
	if (!hits.length) good(`${artifact.verdict.reason} — still search the web and the trademark register before committing`);
	else {
		table(hits, [
			{ header: 'app', get: (a) => a.name },
			{ header: 'exact', get: (a) => (a.exact ? 'yes' : 'suffix/prefix') },
			{ header: 'seller', get: (a) => a.seller ?? '—' },
			{ header: 'ratings', get: (a) => fmt(a.ratings) },
			{ header: 'released', get: (a) => a.released ?? '—' },
		]);
		warn(
			`${artifact.verdict.reason} — shipping beside them means every search for your brand surfaces theirs, and the newest one tells you how many other people reached for the same metaphor this quarter`,
		);
	}
	if (suggestions.length) info(`autocomplete for "${name}": ${suggestions.slice(0, 8).join(' · ')}`);
	good(`wrote ${c.dim(file)}`);
	return flags.strict && hits.length ? 1 : 0;
}

// ─── new ─────────────────────────────────────────────────────────────────────

/** `--from`, else `--term`, else the only brief under --out. Guessing between two is worse than asking. */
async function resolveBrief(flags, market) {
	if (flags.from) return String(flags.from);
	if (flags.term) return artifactFile(flags, market, slugify(String(flags.term)), 'brief');
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

async function scaffold({ args, flags }) {
	const from = await resolveBrief(flags, marketOf(flags.market));
	const { run: scaffoldApp } = await import('./new.mjs');
	return scaffoldApp({ args, flags: { ...flags, from } });
}

const SUB = { terms, brief, names, new: scaffold };

export async function run({ args, flags }) {
	const [sub, ...rest] = args;
	if (!sub)
		throw new ShipError('scout: a subcommand is required', {
			hint: `try: ${Object.keys(SUB).join(', ')} — start with \`ship scout terms "your category"\``,
		});
	const fn = SUB[sub];
	if (!fn) throw new ShipError(`scout: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}
