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
	keywordPool,
	listingFromBrief,
	supportedPhrases,
	verdict,
} from '../src/commands/scout.mjs';
import { lintListing } from '../src/lib/locales.mjs';
import { brandTokens, charCount, tokenSupport } from '../src/lib/text.mjs';

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
	const v = verdict(metrics({ top3MedianRatings: 90_000, demand: 1, exactTitleMatches: 9, saturation: 80, clones: 5 }));
	assert.deepEqual(
		v.reasons.map((r) => r.gate).sort(),
		['clones', 'crowding', 'demand', 'moat', 'saturation'],
	);
});

// ─── brief → staged listing ──────────────────────────────────────────────────

const results = [
	{ trackName: 'Fuelio: Gas Log & Costs', primaryGenreName: 'Productivity', userRatingCount: 18_400, price: 0 },
	{ trackName: 'Drivvo: Vehicle Management', primaryGenreName: 'Productivity', userRatingCount: 9_200, price: 0 },
	{ trackName: 'Simply Auto: Mileage Log', primaryGenreName: 'Productivity', userRatingCount: 4_100, price: 2.99 },
	{ trackName: 'AUTOsist Vehicle Maintenance', primaryGenreName: 'Productivity', userRatingCount: 2_600, price: 0 },
	{ trackName: 'Car Minder Plus', primaryGenreName: 'Productivity', userRatingCount: 1_900, price: 4.99 },
	{ trackName: 'Road Trip MPG', primaryGenreName: 'Travel', userRatingCount: 1_500, price: 0 },
	{ trackName: 'My Cars: Fuel Economy', primaryGenreName: 'Utilities', userRatingCount: 900, price: 0 },
	{ trackName: 'Service Reminder Pro', primaryGenreName: 'Productivity', userRatingCount: 420, price: 0 },
	{ trackName: 'Garage Log', primaryGenreName: 'Utilities', userRatingCount: 180, price: 0 },
	{ trackName: 'Mileage Tracker Free', primaryGenreName: 'Finance', userRatingCount: 60, price: 0 },
];

const suggestions = [
	'car maintenance log',
	'oil change reminder',
	'vehicle mileage tracker',
	'service history record',
	'fuel economy diary',
];

/** A brief shaped exactly as `ship scout brief` writes it, for the one term. */
const briefFor = (term) => ({
	generatedAt: '2026-08-01T09:00:00.000Z',
	term,
	market: { country: 'US', lang: 'en-US' },
	seeds: ['car maintenance', 'service log'],
	demand: 42,
	competition: 71,
	opportunity: 29.8,
	saturation: { score: 12, newEntrants: 1, freshUnproven: 0, cloneTitles: 0, freshDays: 180 },
	viability: 26,
	claims: {
		corpus: 10,
		claims: [
			{ claim: 'reminders', apps: 8, share: 80, holders: ['Fuelio: Gas Log & Costs'] },
			{ claim: 'privacy / on-device', apps: 5, share: 50, holders: ['Drivvo: Vehicle Management'] },
			{ claim: 'ai', apps: 2, share: 20, holders: ['Garage Log'] },
		],
	},
	metrics: metrics({ term }),
	incumbents: [
		{ name: 'Fuelio: Gas Log & Costs', ratings: 18_400 },
		{ name: 'Drivvo: Vehicle Management', ratings: 9_200 },
	],
	listing: draftListing({ term, suggestions, results }),
	verdict: verdict(metrics({ term })),
	file: '/tmp/scout/us/car-maintenance-log-brief.json',
});

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
	assert.deepEqual(notes.scores, { demand: 42, competition: 71, opportunity: 29.8, saturation: 12, viability: 26 });
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

// ── evidence filters ─────────────────────────────────────────────────────────
//
// Every case below is a real draft this pipeline produced against the live US
// storefront for "car maintenance reminder", before the filter that fixes it.

/** The sweep that produced `carfax,cariq,valvoline,servicenow` as a keyword field. */
const SWEEP = [
	'car maintenance reminder',
	'car maintenance tracker',
	'car maintenance log',
	'car oil change tracker',
	'oil change reminder',
	'oil change log',
	'oil change tracker',
	'oil change',
	'vehicle mileage tracker',
	'vehicle mile tracker',
	'valvoline oil change',
	'valvoline instant oil change',
	'servicenow',
	'service titan',
	'car service log',
	'car service reminder',
	'service log app',
];

const APPS = [
	{ name: 'Valvoline Instant Oil Change', seller: 'Valvoline LLC' },
	{ name: 'ServiceNow Mobile', seller: 'ServiceNow, Inc.' },
	{ name: 'Car Maintenance Tracker', seller: 'Jan Kazimierz' },
	{ name: 'Oil Change Log', seller: 'Express Oil Change Service Company LLC' },
];

test('tokenSupport counts distinct queries, not occurrences', () => {
	const s = tokenSupport(['oil change', 'oil change log', 'oil oil oil']);
	assert.equal(s.get('oil'), 3);
	assert.equal(s.get('log'), 1);
});

test('brandTokens takes publisher names and nothing else', () => {
	const brands = brandTokens(APPS);
	assert.ok(brands.has('valvoline'));
	assert.ok(brands.has('servicenow'));
	// A publisher is a legal entity: banning every word of its name once banned
	// the category itself.
	assert.ok(brands.has('express'));
	assert.ok(!brands.has('tracker'), 'title-only tokens are not brands');
});

test('keywordPool drops brands the market does not type, keeps the ones it does', () => {
	const pool = keywordPool(SWEEP, { brands: brandTokens(APPS) });
	assert.ok(!pool.includes('valvoline'), 'a 2-query publisher name is not a keyword');
	assert.ok(!pool.includes('servicenow'));
	assert.ok(pool.includes('oil'));
	assert.ok(pool.includes('tracker'));
	// `service` is a publisher token AND the category's own word: support saves it.
	assert.ok(pool.includes('service'));
});

test('keywordPool is token-level, so a rare neighbour cannot take a good word down', () => {
	// `mileage` appears once; filtering whole phrases lost `vehicle` with it.
	const pool = keywordPool(SWEEP, { brands: new Set() });
	assert.ok(pool.includes('vehicle'));
	assert.ok(!pool.includes('mileage'), 'a single-query token carries no evidence');
});

test('keywordPool orders by support and drops stop words', () => {
	const pool = keywordPool(SWEEP, { brands: new Set() });
	assert.deepEqual(pool.slice(0, 2).sort(), ['change', 'oil'], 'the most-typed tokens lead the pack');
	assert.ok(pool.indexOf('vehicle') > pool.indexOf('oil'), 'a 2-query token ranks below a 7-query one');
	assert.ok(!pool.includes('the'));
	assert.ok(!pool.includes('app'), 'Apple indexes "app" for free');
});

test('a thin sweep is reported thin, not filtered into silence', () => {
	const thin = ['oil change log', 'car service'];
	assert.deepEqual(keywordPool(thin, { brands: new Set() }).sort(), ['car', 'change', 'log', 'oil', 'service']);
});

test('supportedPhrases keeps the subtitle away from company names', () => {
	const brands = brandTokens(APPS);
	const strict = supportedPhrases(SWEEP, 'en-US', { brands, min: 3 });
	assert.ok(!strict.includes('service titan'), 'a company won the subtitle slot at min 2');
	assert.ok(strict.includes('oil change log'));
});

test('categoryVocabulary needs two titles and ignores the genre shelf', () => {
	const results = [
		{ trackName: 'Car Maintenance Tracker', primaryGenreName: 'Utilities', sellerName: 'A' },
		{ trackName: 'Vehicle Maintenance Log', primaryGenreName: 'Utilities', sellerName: 'B' },
		{ trackName: 'Carfax Car Care', primaryGenreName: 'Lifestyle', sellerName: 'Carfax' },
	];
	const vocab = categoryVocabulary(results, 'en-US');
	assert.ok(vocab.includes('maintenance'), 'two titles share it');
	assert.ok(!vocab.includes('utilities'), 'nobody searches the genre name');
	assert.ok(!vocab.includes('carfax'), 'one title, and its own publisher');
});

test('the drafted listing spends no character on a competitor', () => {
	const draft = draftListing({
		term: 'car maintenance reminder',
		suggestions: SWEEP,
		results: APPS.map((a) => ({ trackName: a.name, sellerName: a.seller, userRatingCount: 40, price: 0 })),
	});
	const field = draft.keywords.toLowerCase();
	for (const brand of ['valvoline', 'servicenow']) assert.ok(!field.includes(brand), `${brand} in the keyword field`);
	assert.ok(!draft.subtitle.toLowerCase().includes('servicenow'));
	assert.ok(charCount(draft.keywords) <= LIMITS.keywords);
	assert.ok(!draft.keywords.includes(', '), 'a space after the comma wastes an indexed character');
});
