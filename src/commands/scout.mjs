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
//
// Thin orchestration: parsing, printing, artifact writes. Pure gates and
// listing drafts live in lib/scout-scoring.mjs; storefront and artifact-tree
// access lives in lib/storefront-scout.mjs.
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import {
	brandCollisions,
	commodity as commodityOf,
	hints,
	progressLine,
	score,
	saturation as saturationOf,
	topResults,
} from '../lib/appstore.mjs';
import { money, num } from '../lib/fmt.mjs';
import { emit } from '../lib/output.mjs';
import { GATES, cpiBand, draftListing, fmt, harvestBrands, slugifyAscii, verdict } from '../lib/scout-scoring.mjs';
import { median } from '../lib/util.mjs';
import { brandTokens, charCount } from '../lib/text.mjs';
import {
	artifactFile,
	claimsAudit,
	enableCache,
	incumbentsOf,
	marketOf,
	resolveBrief,
	sweepTerms,
	termPool,
	writeArtifact,
} from '../lib/storefront-scout.mjs';

// The scoring surface moved to lib/scout-scoring.mjs, brief-file access to
// lib/storefront-scout.mjs; these re-exports keep `test/scout.test.mjs` and
// `ship new --from` (which reads readBrief/listingFromBrief off this module)
// working without a path change. lib/cpp.mjs exports a different `slugify`
// (Unicode page slugs) — not unified; scout's ASCII slug ships as both names.
export { GATES, cpiBand, categoryVocabulary, draftListing, harvestBrands, keywordPool, listingFromBrief, slugifyAscii as slugify, supportedPhrases, verdict } from '../lib/scout-scoring.mjs';
export { readBrief } from '../lib/storefront-scout.mjs';

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

/** Progress belongs on stdout, which --json owns exclusively. */
const reporter = (flags) => (flags.json ? undefined : progressLine);

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

	const { candidates, walled, scored } = await sweepTerms({ seeds, market, maxWords, limit, onProgress: reporter(flags) });
	if (walled) warn(`${walled.message} — keeping the ${walled.kept} terms already harvested`);

	const artifact = {
		generatedAt: new Date().toISOString(),
		market,
		seeds,
		candidates,
		terms: scored,
	};
	const file = await writeArtifact(artifactFile(flags, market, slugifyAscii(seeds[0]), 'terms'), artifact);
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

/** The gate thresholds from flags, in the shape `verdict` takes them. */
const briefGates = (flags) => ({
	moat: num(flags.moat, GATES.moat),
	minVolume: num(flags['min-volume'] ?? flags.minVolume, GATES.minVolume),
	exactCap: num(flags['max-exact'] ?? flags.exactCap, GATES.exactTitleMatches),
	saturationCap: num(flags['max-saturation'] ?? flags.saturationCap, GATES.saturation),
	cloneCap: num(flags['max-clones'] ?? flags.cloneCap, GATES.clones),
	commodityCap: num(flags['max-commodity'] ?? flags.commodityCap, GATES.commodity),
});

/** The metrics block `verdict` reads, assembled once from the evidence the brief prints. */
const briefMetrics = ({ term, results, scored, flood, same, incumbents }) => ({
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
});

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
		{ header: 'IAP', get: (a) => (a.hasIap === null ? '?' : a.hasIap ? 'yes' : 'no') },
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

/**
 * The verdict step. A NO-GO that still ends with "next: scaffold it" is not a
 * gate, it is a disclaimer; the flags named are for the gates that tripped.
 */
function printVerdict(artifact, market, file) {
	step('Verdict');
	if (artifact.verdict.go) good(`${c.green('GO')} — no gate tripped`);
	else {
		process.stdout.write(`${c.red(`✗ NO-GO — ${artifact.verdict.reasons.length} gate(s) tripped`)}\n`);
		for (const r of artifact.verdict.reasons) note(`${r.gate}: ${r.message}`);
	}
	good(`wrote ${c.dim(file)}`);
	if (artifact.verdict.go) {
		note(`next: ship scout names "<your brand word>" --market ${market.country.toLowerCase()}`);
		note(`then: ship scout new ${slugifyAscii(artifact.term)} --from ${file}`);
	} else {
		note(`next: a different term — ${c.dim(`ship scout terms "<seeds from something you actually know>" --market ${market.country.toLowerCase()}`)}`);
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
}

async function brief({ args, flags }) {
	const term = args.join(' ').trim().toLocaleLowerCase();
	if (!term)
		throw new ShipError('scout brief: a term is required', {
			hint: 'ship scout brief "car maintenance log"',
		});
	const market = marketOf(flags.market);
	enableCache(flags);
	const { moat, minVolume, exactCap, saturationCap, cloneCap, commodityCap } = briefGates(flags);
	const freshDays = num(flags['fresh-days'] ?? flags.freshDays, 365);
	const subPrice = flags['sub-price'] ?? flags.subPrice;

	const results = await topResults(term, { ...market, limit: 10 });
	if (!results?.length)
		throw new ShipError(`no App Store results for "${term}" in ${market.country}`, {
			hint: 'check the spelling, or wait a minute — Apple answers a burst of search calls with 403s',
		});

	const { prior, seeds, rank, demand, suggestions, pool } = await termPool(flags, market, term);
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
	const metrics = briefMetrics({ term, results, scored, flood, same, incumbents });

	const artifact = {
		generatedAt: new Date().toISOString(),
		term,
		slug: slugifyAscii(term),
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
	printVerdict(artifact, market, file);
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
		slug: slugifyAscii(name),
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
