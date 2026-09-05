// Scout's gates, and the handoff that turns a brief into an app.
//
// The verdict thresholds are the product decision this command exists to make,
// and the storefront they normally read answers one request per second — so they
// are tested against numbers, never a network. Every case asserts the number
// that tripped the gate is in the message: "too competitive" is not a finding
// anybody can act on.
//
// The projection is tested through lintListing because that is the next command
// to touch the file: a brief that drafts an unsubmittable listing has not saved
// the work, it has moved it to `ship meta lint` three days later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/config.mjs';
import { slugFromBrief } from '../src/commands/new.mjs';
import {
	GATES,
	categoryVocabulary,
	draftListing,
	harvestBrands,
	keywordPool,
	listingFromBrief,
	slugify as slugifyAscii,
	supportedPhrases,
	verdict,
} from '../src/commands/scout.mjs';
import { commodity, saturation, score } from '../src/lib/appstore.mjs';
import { lintListing } from '../src/lib/locales.mjs';
import { brandTokens, charCount, tokenSupport } from '../src/lib/text.mjs';
import { CAPTURED_AT, HINTS, page, pages, top } from './fixtures/storefront.mjs';

// ─── gates ───────────────────────────────────────────────────────────────────

/** A term that clears every gate; each test moves exactly one number. */
const metrics = (over = {}) => ({
	term: 'car maintenance log',
	results: 10,
	demand: 42,
	exactTitleMatches: 1,
	top3MedianRatings: 1_200,
	freeTop10: 8,
	saturation: 12,
	newEntrants: 1,
	freshUnproven: 0,
	cloneTitles: 0,
	clones: 0,
	cloneApps: [],
	freshDays: 365,
	commodity: 10,
	commodityMatches: 1,
	commodityProven: 0,
	commodityApps: [],
	...over,
});

const gate = (v, name) => v.reasons.find((r) => r.gate === name);

test('a term inside every threshold is a GO with no reasons', () => {
	const v = verdict(metrics());
	assert.equal(v.go, true);
	assert.deepEqual(v.reasons, []);
});

test('a review moat with a free tier in the top 10 is a NO-GO reporting both numbers', () => {
	const v = verdict(metrics({ top3MedianRatings: 82_000, freeTop10: 4 }));
	assert.equal(v.go, false);
	const r = gate(v, 'moat');
	assert.ok(r, 'expected a moat reason');
	assert.equal(r.value, 82_000);
	assert.equal(r.threshold, GATES.moat);
	assert.match(r.message, /82,000/);
	assert.match(r.message, /4 of the top 10 are free/);
});

test('the same moat with nothing free in the top 10 is still a GO', () => {
	// Paid-only incumbents leave "the free one" open; that is the whole gate.
	assert.equal(verdict(metrics({ top3MedianRatings: 82_000, freeTop10: 0 })).go, true);
});

test('demand under the floor is a NO-GO reporting the demand it measured', () => {
	const v = verdict(metrics({ demand: 3 }));
	assert.equal(v.go, false);
	const r = gate(v, 'demand');
	assert.ok(r, 'expected a demand reason');
	assert.equal(r.value, 3);
	assert.equal(r.threshold, GATES.minVolume);
	assert.match(r.message, /demand 3 is under the 10 floor/);
	// The floor is a flag, not a law.
	assert.equal(verdict(metrics({ demand: 3 }), { minVolume: 2 }).go, true);
});

test('more than 6 exact title matches in the top 10 is a NO-GO reporting the count', () => {
	const v = verdict(metrics({ exactTitleMatches: 7 }));
	assert.equal(v.go, false);
	const r = gate(v, 'crowding');
	assert.ok(r, 'expected a crowding reason');
	assert.equal(r.value, 7);
	assert.equal(r.threshold, GATES.exactTitleMatches);
	assert.match(r.message, /7 of the top 10/);
	assert.equal(verdict(metrics({ exactTitleMatches: 6 })).go, true, '6 is the cap, not over it');
});

test('a flooded top 10 is a NO-GO even though every strength gate passes', () => {
	// The Glovebox case: no moat, tiny review counts, demand fine — and nine of
	// the ten apps ranking for the phrase are eight weeks old.
	const m = metrics({ saturation: 71, newEntrants: 9, freshUnproven: 8, cloneTitles: 6, top3MedianRatings: 40 });
	const v = verdict(m);
	assert.equal(v.go, false);
	const r = gate(v, 'saturation');
	assert.ok(r, 'expected a saturation reason');
	assert.equal(r.value, 71);
	assert.equal(r.threshold, GATES.saturation);
	assert.match(r.message, /9 of the top 10 first shipped inside 365 days/);
	assert.match(r.message, /8 of those still have under 25 ratings/);
	assert.match(r.message, /6 already put "car maintenance log" in the title/);
});

test('the saturation cap is a threshold, not a law', () => {
	assert.equal(verdict(metrics({ saturation: 40 })).go, true, '40 is the cap, not over it');
	assert.equal(verdict(metrics({ saturation: 55 }), { saturationCap: 60 }).go, true);
});

test('three apps already named after the term is a NO-GO the blended score misses', () => {
	// The live `car maintenance log` top-10: two entrenched incumbents from 2012
	// keep saturation at 36, under the cap, while Vehix, Steerlog and
	// "Car Maintenance Log - Service" sit on page one with 3, 0 and 0 ratings.
	const m = metrics({
		saturation: 36,
		newEntrants: 4,
		clones: 3,
		cloneApps: ['Vehix - Car Maintenance Log', 'Steerlog: Car Maintenance Log', 'Car Maintenance Log - Service'],
	});
	const v = verdict(m);
	assert.equal(gate(v, 'saturation'), undefined, 'the blended score alone would have passed this');
	assert.equal(v.go, false);
	const r = gate(v, 'clones');
	assert.ok(r, 'expected a clones reason');
	assert.equal(r.value, 3);
	assert.equal(r.threshold, GATES.clones);
	assert.match(r.message, /3 of the top 10 are already this app/);
	assert.match(r.message, /Steerlog: Car Maintenance Log/);
	assert.equal(verdict(metrics({ clones: 2 })).go, true, '2 is the cap, not over it');
});

test('every tripped gate is reported, not just the first', () => {
	const v = verdict(
		metrics({
			top3MedianRatings: 90_000,
			demand: 1,
			exactTitleMatches: 9,
			saturation: 80,
			clones: 5,
			commodity: 90,
		}),
	);
	assert.deepEqual(
		v.reasons.map((r) => r.gate).sort(),
		['clones', 'commodity', 'crowding', 'demand', 'moat', 'saturation'],
	);
});

// ─── the gates against real storefront pages ─────────────────────────────────
//
// The tests above move one number at a time, which is how a threshold should be
// tested and also how a gate can pass every unit test while failing on every
// real page. These run the whole verdict over pages the storefront actually
// served, in categories nobody chose to flatter the gates.

/** Metrics as `brief` assembles them, from a captured page. */
const metricsFor = (term) => {
	const p = page(term);
	const scored = score(term, p.apps, { demand: 50, now: CAPTURED_AT });
	const flood = saturation(p.apps, { term, now: CAPTURED_AT });
	const same = commodity(p.apps, { term, locale: p.locale });
	return {
		term,
		results: p.apps.length,
		demand: scored.demand,
		exactTitleMatches: scored.exactTitleMatches,
		top3MedianRatings: p.apps
			.slice(0, 3)
			.map((a) => a.userRatingCount)
			.sort((a, b) => a - b)[1],
		freeTop10: p.apps.filter((a) => !(a.price > 0)).length,
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
};

test('the gates agree with what the storefront looks like, across categories', () => {
	// One row per captured page, annotated with the evidence that makes each
	// gate fire, so a future reader can check the row against the fixture
	// instead of trusting it. My first draft of this table was wrong on eight
	// rows — it under-predicted `crowding` and `moat` — which is the argument
	// for having it.
	const expected = {
		// Entrenched, and named after the query. All three gates.
		'period tracker': ['commodity', 'crowding', 'moat'], // 7 exact, top-3 median 172,869
		'calorie counter': ['commodity', 'crowding', 'moat'], // 8 exact, 162,657
		'invoice maker': ['commodity', 'crowding', 'moat'], // 8 exact, 100,063
		'habit tracker': ['commodity', 'crowding', 'moat'], // 7 exact, 145,700
		sudoku: ['commodity', 'crowding', 'moat'], // 8 exact, 659,288
		'flight tracker': ['commodity', 'crowding', 'moat'], // 8 exact, 381,810
		家計簿: ['commodity', 'crowding', 'moat'], // 9 exact, 456,499
		// Entrenched without the naming convention: under the 6-exact cap.
		'toddler games': ['commodity', 'moat'], // 3 exact, 287,295
		'photo editor': ['commodity', 'moat'], // 6 exact — the cap, not over it
		'reading tracker': ['commodity', 'moat'], // 3 exact, 78,471
		'hurricane tracker': ['commodity', 'moat'], // 4 exact, 67,241
		'recipe manager': ['commodity', 'moat'], // 5 exact, 53,522
		'plant identifier': ['commodity', 'moat'], // 6 exact, 227,762
		'baby feeding log': ['commodity', 'moat'], // 1 exact, 71,818
		// Named after the query but under the 50,000 moat.
		flashcards: ['commodity', 'crowding'], // 8 exact, top-3 median 18,159
		metronome: ['commodity', 'crowding'], // 10 of 10 exact, 36,917
		// Solved, but by nobody big and with no naming convention.
		'unit converter': ['commodity'], // 6 exact, 48,131 — just under the moat
		'golf gps': ['commodity'], // 33,674
		'dog training': ['commodity'], // 27,148
		'mortgage calculator': ['commodity'], // 4,697
		'expense tracker': ['commodity'], // 44% of the page, 15,525
		'beehive inspection log': ['commodity'], // 872
		'dive log': ['commodity'], // 111 — the term this whole gate came from
		'aquarium water log': ['commodity'], // 185
		'wire size calculator': ['commodity'], // 69
		'iv drip rate calculator': ['commodity'], // 3
		'feeds and speeds calculator': ['commodity'], // 9
		// Both failure modes at once, and the incident each gate was written for.
		'car maintenance log': ['clones', 'commodity'], // 3 clones, 80% commodity
		'boat maintenance log': ['clones', 'commodity', 'saturation'], // 4, 78%, sat 64
		// Same category, adjacent terms: no stampede, but the product exists.
		'car maintenance reminder': ['commodity'], // 80%, top-3 median only 172
		'oil change': ['commodity'], // 30% — a retail-chain page, not an app category
		// The one page commodity cannot see: nine German car-maintenance apps
		// using none of the term's words. Saturation catches it instead, which is
		// the argument for two numbers reading different evidence.
		'kfz scheckheft': ['saturation'],
	};

	const actual = {};
	for (const p of pages()) {
		actual[p.term] = verdict(metricsFor(p.term))
			.reasons.map((r) => r.gate)
			.sort();
	}
	assert.deepEqual(actual, expected);
});

test('the commodity gate fires on almost every real head term, and that is the finding', () => {
	// 29 of 30 captured pages trip it. That is not a miscalibrated cap; it is
	// the corpus telling you that a term people actually search is a term
	// somebody already built. A cap loose enough to pass these pages would have
	// to sit above 50%, i.e. would only object once *most* of page one is your
	// app — by which point the answer was never in doubt.
	//
	// The consequence for anyone reading a brief: the boolean is nearly
	// constant, so the information is in `share` and in the proven/unproven
	// split. Pinned here so a future change that makes the gate discriminating
	// again has to argue with the data rather than with the threshold.
	const shares = pages()
		.map((p) => metricsFor(p.term).commodity)
		.sort((a, b) => a - b);
	const tripped = shares.filter((s) => s > GATES.commodity).length;
	assert.equal(tripped, 31);
	assert.equal(shares[0], 0, 'the one page it is blind to');
	assert.equal(shares[1], 30, 'the least-solved term in the corpus is still 30% built');
	assert.ok(shares[Math.floor(shares.length / 2)] >= 70, 'the median real page is mostly this product');
});

test('a real NO-GO names the apps that caused it, not just the count', () => {
	// The complaint the message format exists to answer: "too competitive" is
	// unactionable, "these four are already your app" is a reading list.
	const v = verdict(metricsFor('boat maintenance log'));
	assert.equal(v.go, false);
	const clones = v.reasons.find((r) => r.gate === 'clones');
	assert.match(clones.message, /HullBook: Boat Maintenance Log/);
	assert.match(clones.message, /Skipper: Boat Maintenance Log/);

	const cm = v.reasons.find((r) => r.gate === 'commodity');
	assert.match(cm.message, /7 of the top 9 are already this product/);
	assert.match(cm.message, /none of them has traction/, 'a race, not a served market');

	// The same gate, opposite diagnosis, on a page where the incumbents are real.
	const served = verdict(metricsFor('calorie counter')).reasons.find((r) => r.gate === 'commodity');
	assert.match(served.message, /9 of them carry real ratings/);
	assert.match(served.message, /served market/);
});

// ─── brief → staged listing ──────────────────────────────────────────────────

// The real top-10 and the real autocomplete rows for the term, exactly what
// `brief` hands `draftListing`. The invented versions of these two arrays were
// tidy in a way the storefront never is: five clean category phrases instead of
// a harvest that is nine-tenths competitors' product names, which is why a
// keyword draft that spent its first two slots on "autolog,glovebox" passed
// tests for as long as it did.
const results = top('car maintenance log');

// `pool` as `brief` builds it: the term's own row plus the neighbours a sweep
// scored, deduped, in that order.
const suggestions = [
	...new Set([...HINTS['car maintenance log'], ...HINTS['maintenance log'], ...HINTS['car maintenance']]),
];

/**
 * A brief shaped exactly as `ship scout brief` writes it, with every number
 * computed from the real page rather than chosen. A fixture whose scores are
 * typed in by hand can hold a combination the scorer cannot produce.
 */
const REAL_BRANDS = new Set([
	...brandTokens(
		results.map((r) => ({ name: r.trackName, seller: r.sellerName })),
		'en-US',
	),
	...harvestBrands(suggestions, 'car maintenance log', 'en-US'),
]);

const briefFor = (term) => {
	const scored = score(term, results, { demand: 42, now: CAPTURED_AT });
	const flood = saturation(results, { term, now: CAPTURED_AT });
	const same = commodity(results, { term });
	return {
		generatedAt: '2026-08-01T09:00:00.000Z',
		term,
		market: { country: 'US', lang: 'en-US' },
		seeds: ['car maintenance', 'maintenance log'],
		demand: scored.demand,
		competition: scored.competition,
		opportunity: scored.opportunity,
		saturation: flood,
		commodity: same,
		viability: scored.viability,
		claims: {
			corpus: 10,
			claims: [
				{ claim: 'reminders', apps: 8, share: 80, holders: ['Car Maintenance Reminders'] },
				{ claim: 'privacy / on-device', apps: 5, share: 50, holders: ['Car Cave - Car Maintenance Log'] },
				{ claim: 'ai', apps: 2, share: 20, holders: ['MyAutoLog: Car Maintenance Log'] },
			],
		},
		metrics: metrics({ term }),
		incumbents: results.slice(0, 3).map((r) => ({ name: r.trackName, ratings: r.userRatingCount })),
		listing: draftListing({ term, suggestions, results, brands: REAL_BRANDS }),
		verdict: verdict(metrics({ term })),
		file: '/tmp/scout/us/car-maintenance-log-brief.json',
	};
};

const failures = (listing) =>
	lintListing({ locale: 'en-US', file: '/tmp/store/staged/en-US.json', data: listing }).filter(
		(p) => p.level === 'fail',
	);

test('the listing a brief projects into store/staged lints clean', () => {
	const listing = listingFromBrief(briefFor('car maintenance log'));
	assert.deepEqual(failures(listing), []);
	assert.equal(listing.locale, 'en-US');
	for (const field of ['name', 'subtitle', 'keywords', 'description'])
		assert.ok(String(listing[field]).trim(), `${field} must not be empty`);
});

test('the projected fields stay inside the code-point limits', () => {
	const listing = listingFromBrief(briefFor('kfz wartung & ölwechsel übersicht für vielfahrer'));
	assert.deepEqual(failures(listing), []);
	for (const field of ['name', 'subtitle', 'keywords'])
		assert.ok(
			charCount(listing[field]) <= LIMITS[field],
			`${field} is ${charCount(listing[field])}/${LIMITS[field]}`,
		);
});

test('the keyword field never pays for a space after a comma', () => {
	const listing = listingFromBrief(briefFor('car maintenance log'));
	assert.doesNotMatch(listing.keywords, /,\s/);
});

test('the staged listing records the term, its scores and the brief that chose it', () => {
	const brief = briefFor('car maintenance log');
	const { notes } = listingFromBrief(brief);
	assert.equal(notes.term, 'car maintenance log');
	assert.equal(notes.brief, brief.file);
	// The real page's own numbers: weak-looking incumbents (median 53 ratings),
	// three apps titled after the query, and 8 of 10 already this product — so
	// an opportunity of 23 collapses to a viability of 3.
	assert.deepEqual(notes.scores, {
		demand: 42,
		competition: 55,
		opportunity: 23,
		saturation: 36,
		commodity: 80,
		viability: 3,
	});
	assert.equal(notes.evidence.exactTitleMatches, 1);
	assert.equal(notes.verdict, 'GO');
});

test('the claims the category already makes are recorded so the angle cannot be reinvented', () => {
	const { notes } = listingFromBrief(briefFor('car maintenance log'));
	// 40%+ of the top-10 say it, so it is the category norm, not a differentiator.
	assert.deepEqual(notes.evidence.claimsAlreadyTaken, ['reminders', 'privacy / on-device']);
	assert.ok(notes.rewrite.some((line) => line.includes('claimsAlreadyTaken')));
});

test('a NO-GO verdict survives into the listing that was scaffolded anyway', () => {
	const brief = { ...briefFor('car maintenance log') };
	brief.metrics = metrics({ demand: 2 });
	brief.verdict = verdict(brief.metrics);
	const { notes } = listingFromBrief(brief);
	assert.match(notes.verdict, /^NO-GO/);
	assert.match(notes.verdict, /demand 2 is under the 10 floor/);
});

test('listingFromBrief fills null and empty defaults for a brief older than every field it reads', () => {
	// Every field on ScoutBrief is optional by design — a hand-edited or
	// pre-migration brief.json can lack any of them — so the reader has to
	// produce a staged listing rather than throw on a missing key.
	const listing = listingFromBrief({});
	assert.equal(listing.name, '');
	assert.equal(listing.subtitle, '');
	assert.equal(listing.keywords, '');
	assert.equal(listing.description, '');
	assert.deepEqual(listing.notes.scores, {
		demand: null,
		competition: null,
		opportunity: null,
		saturation: null,
		commodity: null,
		viability: null,
	});
	assert.deepEqual(listing.notes.evidence, {
		top3MedianRatings: null,
		exactTitleMatches: null,
		freeTop10: null,
		newEntrants: null,
		freshUnproven: null,
		claimsAlreadyTaken: [],
		incumbents: [],
	});
	assert.equal(listing.notes.term, null);
	assert.equal(listing.notes.brief, null);
	assert.equal(listing.notes.market, null);
	assert.equal(listing.notes.researchedAt, null);
	// No verdict block at all reads as "the gates never ran", not as a NO-GO.
	assert.equal(listing.notes.verdict, null);
	assert.match(listing.notes.rewrite[1], /0\/100 characters/);
});

test('a NO-GO with no reasons array still reads as a NO-GO, not a crash', () => {
	// A verdict block can arrive with `go` but without `reasons` — the same
	// tolerance as every other field on an old brief.
	const { notes } = listingFromBrief({ verdict: { go: false } });
	assert.equal(notes.verdict, 'NO-GO — ');
});

// ─── ship new --from ─────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

test("the brief's own slug is the app slug", () => {
	assert.equal(slugFromBrief({ slug: 'car-maintenance-log', term: 'car maintenance log' }), 'car-maintenance-log');
});

test('a term with punctuation and capitals derives a legal slug', () => {
	const slug = slugFromBrief({ term: "Dad's Car & Service Log!" });
	assert.equal(slug, 'dad-s-car-service-log');
	assert.match(slug, SLUG_RE);
});

test('accents are folded rather than dropped whole', () => {
	assert.equal(slugFromBrief({ term: 'Ölwechsel Übersicht' }), 'olwechsel-ubersicht');
});

test('a derived slug never leads with a hyphen or trails one', () => {
	const slug = slugFromBrief({ term: '  — 2026 tax mileage —  ' });
	assert.equal(slug, '2026-tax-mileage');
	assert.match(slug, SLUG_RE);
});

test('a long term is truncated to something npm and Expo accept', () => {
	const slug = slugFromBrief({ term: 'ultimate vehicle service and maintenance history logbook for fleets' });
	assert.ok(slug.length <= 40, `${slug.length} characters`);
	assert.match(slug, SLUG_RE);
});

test("scout's hash stem for a non-latin term is used as-is", () => {
	assert.equal(slugFromBrief({ slug: 't-1a2b3c4d', term: 'カレンダー 予定' }), 't-1a2b3c4d');
});

test('a non-latin term with no slug is asked for, not guessed', () => {
	assert.throws(() => slugFromBrief({ term: 'カレンダー 予定' }), /cannot derive a slug/);
});

test('slugifyAscii hashes a term that leaves nothing to slugify, and a missing term the same way', () => {
	// A non-Latin term normalizes to the empty string, not to a name every such
	// term would collide on — this is the fallback `scout brief` actually
	// relies on before a slug is chosen.
	const ja = slugifyAscii('カレンダー 予定');
	assert.match(ja, /^t-[0-9a-f]{8}$/);
	// A brief with no term at all hits the same fallback rather than throwing.
	assert.match(slugifyAscii(undefined), /^t-[0-9a-f]{8}$/);
	assert.notEqual(ja, slugifyAscii(undefined), 'different input hashes to a different stem');
});

// ── evidence filters ─────────────────────────────────────────────────────────
//
/**
 * The real harvest for the auto category: the term's own autocomplete row plus
 * the neighbours a sweep would have scored, deduped exactly as `brief` does it.
 *
 * The invented version of this array was seventeen tidy category phrases. The
 * real one is 24 rows of which nine are somebody's App Store title wrapped
 * around the query — `autoteca: car maintenance log`, `glovebox: car
 * maintenance log`, `carbook: car maintenance log` — and that difference is
 * why the drafted keyword field used to read `autolog,glovebox`.
 */
const SWEEP = [
	...new Set([...HINTS['car maintenance log'], ...HINTS['maintenance log'], ...HINTS['car maintenance']]),
];

/** Real publishers, from the pages these terms actually return. */
const APPS = [...top('oil change'), ...top('car maintenance reminder')].map((a) => ({
	name: a.trackName,
	seller: a.sellerName,
}));

/** The oil-change harvest, where the brand rows carry no separator at all. */
const OIL_SWEEP = [...new Set([...HINTS['oil change'], ...HINTS['car maintenance']])];

test('tokenSupport counts distinct queries, not occurrences', () => {
	const s = tokenSupport(['oil change', 'oil change log', 'oil oil oil']);
	assert.equal(s.get('oil'), 3);
	assert.equal(s.get('log'), 1);
});

test('brandTokens takes publisher names and nothing else', () => {
	const brands = brandTokens(APPS);
	assert.ok(brands.has('valvoline'), 'Valvoline, LLC publishes the top result for "oil change"');
	assert.ok(brands.has('carfax'), 'CARFAX, Inc.');
	// A publisher is a legal entity: banning every word of its name once banned
	// the category itself. These are real company words from real sellerNames.
	assert.ok(brands.has('retail') && brands.has('operations'), 'Bridgestone Retail Operations');
	assert.ok(!brands.has('tracker'), 'title-only tokens are not brands');
	assert.ok(!brands.has('maintenance'));
});

test('harvestBrands catches the product names Apple autocompletes', () => {
	// `brandTokens` reads the top-10 and cannot see these: not one of Autoteca,
	// Glovebox, Carbook or Pitto ranks in the top 10 for the term, yet Apple
	// suggests all of them, and the keyword draft was bidding on two.
	const brands = harvestBrands(SWEEP, 'car maintenance log', 'en-US');
	assert.deepEqual(
		[...brands].sort(),
		['autolog', 'autoteca', 'carbook', 'cave', 'glovebox', 'pitto', 'service'],
	);

	// `car` sits on the name side of "car cave - car maintenance log" and is
	// still a category word, because a plain-query row uses it too. `cave` does
	// not appear in any query.
	assert.ok(!brands.has('car'));
	assert.ok(!brands.has('maintenance'));
	assert.ok(!brands.has('log'));

	const top10 = brandTokens(
		top('car maintenance log').map((a) => ({ name: a.trackName, seller: a.sellerName })),
		'en-US',
	);
	for (const missed of ['autoteca', 'glovebox', 'carbook', 'pitto']) {
		assert.ok(!top10.has(missed), `${missed} is invisible to the top-10 detector`);
	}
});

test('harvestBrands cannot see a product name with no separator, by construction', () => {
	// The documented limit, on the page that shows it: "valvoline instant oil
	// change" and "take 5 oil change" are chains, and to a splitter they look
	// exactly like "car oil change tracker".
	const brands = harvestBrands(OIL_SWEEP, 'oil change', 'en-US');
	assert.ok(!brands.has('valvoline'), 'no separator, so this detector is blind to it');
	assert.ok(!brands.has('take'));

	// Which is why it is unioned with the publisher detector rather than
	// replacing it: Valvoline, LLC publishes the app, so that path catches it.
	assert.ok(brandTokens(APPS).has('valvoline'));

	// `take` is caught by neither — the chain has no app on this page. It is a
	// 2-query token, so it survives into the pool, and the honest answer is that
	// this is what the keyword-coverage warning and a human reading the draft
	// are for. Asserted so nobody mistakes it for a solved problem.
	const pool = keywordPool(OIL_SWEEP, { brands: new Set([...brandTokens(APPS), ...brands]) });
	assert.ok(pool.includes('take'), 'known leak, deliberately visible');
});

test('keywordPool drops brands the market does not type, keeps the ones it does', () => {
	const brands = new Set([...brandTokens(APPS), ...harvestBrands(SWEEP, 'car maintenance log', 'en-US')]);
	const before = keywordPool(SWEEP, { brands: new Set() });
	assert.ok(before.includes('autolog') && before.includes('glovebox'), 'the bug, still reproducible');

	const pool = keywordPool(SWEEP, { brands });
	assert.ok(!pool.includes('autolog'));
	assert.ok(!pool.includes('glovebox'));
	assert.ok(pool.includes('maintenance'));
	assert.ok(pool.includes('tracker'));
	assert.ok(pool.includes('car'), 'a name-side token with query support is a category word');
});

test('keywordPool is token-level, so a rare neighbour cannot take a good word down', () => {
	// `motorcycle` appears in exactly one row ("apps for motorcycle maintenance
	// logs"); filtering whole phrases would have lost `maintenance` with it.
	const pool = keywordPool(SWEEP, { brands: new Set() });
	assert.ok(pool.includes('maintenance'));
	assert.ok(!pool.includes('motorcycle'), 'a single-query token carries no evidence');
});

test('keywordPool orders by support and drops stop words', () => {
	const pool = keywordPool(SWEEP, { brands: new Set() });
	assert.deepEqual(pool.slice(0, 2), ['maintenance', 'car'], 'the most-typed tokens lead the pack');
	assert.ok(pool.indexOf('tracker') > pool.indexOf('log'), 'a 5-query token ranks below a 10-query one');
	assert.ok(!pool.includes('for'));
	assert.ok(!pool.includes('app'), 'Apple indexes "app" for free');
});

test('a thin sweep is reported thin, not filtered into silence', () => {
	const thin = ['oil change log', 'car service'];
	assert.deepEqual(keywordPool(thin, { brands: new Set() }).sort(), ['car', 'change', 'log', 'oil', 'service']);
});

test('supportedPhrases keeps the subtitle away from company names', () => {
	const brands = new Set([...brandTokens(APPS), ...harvestBrands(SWEEP, 'car maintenance log', 'en-US')]);
	const strict = supportedPhrases(SWEEP, 'en-US', { brands, min: 3 });
	for (const phrase of strict) {
		for (const brand of ['autoteca', 'glovebox', 'carbook', 'pitto', 'loggy', 'myautolog']) {
			assert.ok(!phrase.includes(brand), `"${phrase}" carries a competitor's name`);
		}
	}
	assert.ok(strict.includes('car maintenance tracker'), 'a phrase the market types survives');
});

test('categoryVocabulary needs two titles and ignores the genre shelf', () => {
	// The real page: eight of ten titles share "car", "maintenance" and "log".
	const vocab = categoryVocabulary(top('car maintenance log'), 'en-US');
	assert.ok(vocab.includes('maintenance'), 'nine titles share it');
	assert.ok(vocab.includes('car'));
	assert.ok(!vocab.includes('utilities'), 'nobody searches the genre name');
	assert.ok(!vocab.includes('carfax'), 'one title, and its own publisher');
});

test('the drafted listing spends no character on a competitor', () => {
	const brands = new Set([...brandTokens(APPS), ...harvestBrands(SWEEP, 'car maintenance log', 'en-US')]);
	const draft = draftListing({
		term: 'car maintenance log',
		suggestions: SWEEP,
		results: top('car maintenance log'),
		brands,
	});
	const field = draft.keywords.toLowerCase();
	for (const brand of ['autolog', 'glovebox', 'autoteca', 'carbook', 'pitto', 'valvoline']) {
		assert.ok(!field.includes(brand), `${brand} in the keyword field`);
	}
	assert.ok(!draft.subtitle.toLowerCase().includes('glovebox'));
	assert.ok(charCount(draft.keywords) <= LIMITS.keywords);
	assert.ok(!draft.keywords.includes(', '), 'a space after the comma wastes an indexed character');
});

test('categoryVocabulary tolerates a storefront row missing a seller or a title', () => {
	// The payload is unvalidated JSON off the storefront API — every field on
	// ScoutApp is optional and nullable — so a row that fails to carry one
	// should not crash the vocabulary scan, just contribute nothing from it.
	const vocab = categoryVocabulary(
		[
			{ trackName: 'Car Log Tracker' },
			{ sellerName: 'Acme LLC' },
			{ trackName: 'Car Log Book', sellerName: 'Acme LLC' },
		],
		'en-US',
	);
	assert.ok(vocab.includes('car'), 'two titles share it despite the missing seller field');
	assert.ok(vocab.includes('log'));
});

test('harvestBrands is blind to a blank term and skips a hole in the harvest', () => {
	// `readBrief`/the CLI always hand a non-empty term and a real array, but the
	// function is exported and pure, so it has to survive the inputs those
	// callers cannot produce: no term, no suggestions at all, and a harvest row
	// that came back null.
	assert.deepEqual(harvestBrands(['autolog: car log'], undefined, 'en-US'), new Set(), 'no term, nothing to match against');
	assert.deepEqual(harvestBrands(undefined, 'car log', 'en-US'), new Set(), 'no suggestions to scan');
	const brands = harvestBrands([null, 'autoteca: car log'], 'car log', 'en-US');
	assert.deepEqual([...brands], ['autoteca'], 'a hole in the harvest is skipped, not thrown on');
});

test('draftListing computes its own brand set when the caller has none to hand it', () => {
	// `brief` always passes the two-source brand set it just built, but the
	// option defaults to an empty one — draftListing has to fall back to
	// reading brands off the results itself.
	const draft = draftListing({
		term: 'car log',
		results: [
			{ trackName: 'CarLog Tracker', sellerName: 'Acme LLC' },
			{ trackName: 'Car Log Book', sellerName: 'Other Inc' },
		],
	});
	assert.ok(draft.name);
});

test('draftListing survives a result with no rating count or price, and an empty page', () => {
	// Both fields are optional on ScoutApp; a delisted or incomplete row can
	// omit either, and an empty top-10 (a brand-new term) omits the leader
	// entirely.
	const withHoles = draftListing({
		term: 'car log',
		results: [{ trackName: 'Car Log', sellerName: 'Acme' }],
	});
	assert.ok(withHoles.description.includes('one job'));

	const empty = draftListing({ term: 'car log', results: [] });
	assert.doesNotMatch(empty.description, /led by/, 'no leader to name when the top-10 is empty');
});

test('a name too long to keep even its first word is hard-cut, not left empty', () => {
	// fitWords keeps whole words up to the limit; a single "word" longer than
	// the limit itself has no whole word that fits, so it falls back to a
	// straight code-point cut rather than producing an empty name.
	const draft = draftListing({ term: 'a'.repeat(40), results: [] });
	assert.equal(draft.name.length, 30);
});
