// The gate arithmetic and the ranking, both pure. These are the numbers the
// agent is not allowed to guess, so they are tested against hand-computed
// values rather than against whatever the code happens to return.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	checkBudget,
	checkClaims,
	checkReferences,
	checkThemes,
	indexReviews,
	meanRating,
	skewFor,
} from '../src/lib/research-verify.mjs';
import { appWeight, buildIndex, ratingVelocity, referenceScore } from '../src/lib/research-index.mjs';

const review = (id, rating, over = {}) => ({
	id,
	rating,
	version: '1.0',
	date: '2026-08-01T00:00:00Z',
	title: '',
	body: '',
	sort: 'mostrecent',
	...over,
});

const corpus = (trackId, reviews, appMeanRating) => ({
	trackId,
	count: reviews.length,
	reviews,
	...(appMeanRating === undefined ? {} : { appMeanRating }),
});

const REVIEWS = [review('r1', 1), review('r2', 2), review('r3', 5), review('r4', 5)];

test('meanRating and skewFor are the stored precision, not floating dust', () => {
	assert.equal(meanRating(REVIEWS), 3.25);
	assert.equal(meanRating([]), 0);
	// The two unhappy reviews average 1.5 against an app mean of 4.5.
	assert.equal(skewFor(['r1', 'r2'], indexReviews([corpus(1, REVIEWS)]).byId, 4.5), -3);
	assert.equal(skewFor(['nope'], new Map(), 4.5), null);
});

test('indexReviews takes the storefront mean when there is one, the corpus mean when there is not', () => {
	const { byId, appMeans } = indexReviews([corpus(1, REVIEWS, 4.75), corpus(2, [review('x', 4)])]);
	assert.equal(byId.size, 5);
	assert.equal(appMeans.get(1), 4.75);
	assert.equal(appMeans.get(2), 4);
});

const PLAN = { flows: ['paywall', 'home'], sorts: ['mostrecent', 'mosthelpful'], budget: { apps: 2, screensPerApp: 3, reviewPages: 2 } };

const ref = (id, over = {}) => ({
	id,
	flow: 'paywall',
	confidence: 'high',
	app: { name: 'A', trackId: 1, rating: 4.5, ratingCount: 9999 },
	position: 1,
	image: { path: `assets/${id}.png`, sha256: 'a'.repeat(64), w: 1290, h: 2796 },
	...over,
});

test('checkReferences catches a draft, an unplanned flow, a missing image and a stale hash', () => {
	const hashes = new Map([['assets/ref_a.png', 'a'.repeat(64)], ['assets/ref_c.png', 'b'.repeat(64)]]);
	const issues = checkReferences(
		[
			ref('ref_a'),
			ref('ref_b', { _todo: ['flow'] }),
			ref('ref_c'),
			ref('ref_d', { flow: 'streak' }),
		],
		hashes,
		PLAN,
	);
	assert.equal(issues.length, 5);
	assert.match(issues[0], /ref_b: still a fetch draft/);
	assert.match(issues[1], /ref_b.*missing from the run/);
	assert.match(issues[2], /ref_c.*does not match its recorded sha256/);
	assert.match(issues[3], /ref_d: flow "streak" is not one of the planned flows/);
	assert.match(issues[4], /ref_d.*missing from the run/);
});

test('checkReferences refuses two references claiming one id', () => {
	const hashes = new Map([['assets/ref_a.png', 'a'.repeat(64)]]);
	const issues = checkReferences([ref('ref_a'), ref('ref_a')], hashes, PLAN);
	assert.deepEqual(issues, ['ref_a: duplicate reference id']);
});

test('checkThemes recomputes support and skew instead of believing them', () => {
	const { byId, appMeans } = indexReviews([corpus(1, REVIEWS, 4.5)]);
	const ok = { themes: [{ label: 'pain', trackId: 1, support: 2, reviewIds: ['r1', 'r2'], ratingSkew: -3 }] };
	assert.deepEqual(checkThemes(ok, byId, appMeans), []);

	const bad = {
		themes: [
			{ label: 'wrong skew', trackId: 1, support: 2, reviewIds: ['r1', 'r2'], ratingSkew: 0.5 },
			{ label: 'wrong support', trackId: 1, support: 9, reviewIds: ['r3'] },
			{ label: 'phantom', trackId: 1, support: 1, reviewIds: ['nobody'], ratingSkew: 0 },
		],
	};
	const issues = checkThemes(bad, byId, appMeans);
	assert.equal(issues.length, 3);
	assert.match(issues[0], /ratingSkew is 0.5, the supporting reviews give -3/);
	assert.match(issues[1], /support is 9, reviewIds has 1/);
	assert.match(issues[2], /cites 1 review id\(s\) not in the corpus \(nobody\)/);
	assert.deepEqual(checkThemes(null, byId, appMeans), []);
});

test('checkThemes falls back to the whole corpus when a theme names no app', () => {
	const { byId, appMeans } = indexReviews([corpus(1, REVIEWS)]);
	const issues = checkThemes(
		{ themes: [{ label: 'x', support: 2, reviewIds: ['r3', 'r4'], ratingSkew: 1.75 }] },
		byId,
		appMeans,
	);
	assert.deepEqual(issues, []);
});

test('checkClaims enforces three refs for evidence and one for anything', () => {
	const refs = [ref('ref_a'), ref('ref_b'), ref('ref_c')];
	const good = {
		claims: [
			{ claim: 'e', kind: 'evidence', refs: ['ref_a', 'ref_b', 'ref_c'], counterexamples: [] },
			{ claim: 'h', kind: 'hypothesis', refs: ['ref_a'], counterexamples: ['ref_b'] },
		],
	};
	assert.deepEqual(checkClaims(good, refs), []);

	const bad = {
		claims: [
			{ claim: 'thin', kind: 'evidence', refs: ['ref_a', 'ref_b'], counterexamples: [] },
			{ claim: 'bare', kind: 'hypothesis', refs: [], counterexamples: [] },
			{ claim: 'invented', kind: 'hypothesis', refs: ['ref_zzz'], counterexamples: ['ref_yyy'] },
		],
	};
	const issues = checkClaims(bad, refs);
	assert.equal(issues.length, 4);
	assert.match(issues[0], /kind is "evidence" with 2 ref\(s\)/);
	assert.match(issues[1], /cites no references/);
	assert.match(issues[2], /cites unknown reference ref_zzz/);
	assert.match(issues[3], /counterexample ref_yyy is not a reference/);
	assert.deepEqual(checkClaims(null, refs), []);
});

test('checkBudget measures the artifacts against the plan, per dimension', () => {
	assert.deepEqual(checkBudget(PLAN, { apps: 2, references: 6, reviewPages: 8 }), []);
	const issues = checkBudget(PLAN, { apps: 3, references: 7, reviewPages: 9 });
	assert.equal(issues.length, 3);
	assert.match(issues[0], /apps 3 exceeds the planned cap of 2/);
	assert.match(issues[1], /references 7 exceeds the planned cap of 6/);
	assert.match(issues[2], /review pages 9 exceeds the planned cap of 8/);
});

test('ratingVelocity needs two dated runs, and refuses to divide by nothing', () => {
	assert.equal(ratingVelocity({ ratingCount: 1000, at: '2026-08-01T00:00:00Z' }, { ratingCount: 1300, at: '2026-08-11T00:00:00Z' }), 30);
	assert.equal(ratingVelocity(null, { ratingCount: 10, at: '2026-08-11T00:00:00Z' }), null);
	assert.equal(ratingVelocity({ ratingCount: 10, at: '2026-08-11T00:00:00Z' }, { ratingCount: 20, at: '2026-08-11T00:00:00Z' }), null);
	assert.equal(ratingVelocity({ ratingCount: 10 }, { ratingCount: 20, at: '2026-08-11T00:00:00Z' }), null);
	assert.equal(ratingVelocity({ ratingCount: 10, at: 'x' }, { at: '2026-08-11T00:00:00Z' }), null);
});

test('a strong app’s later screens still outrank a weak app’s first', () => {
	const strong = { app: { rating: 4.7, ratingCount: 200_000 }, confidence: 'high', position: 8 };
	const weak = { app: { rating: 4.9, ratingCount: 900 }, confidence: 'high', position: 1 };
	assert.ok(referenceScore(strong) > referenceScore(weak));
	assert.equal(appWeight({}), 0);
	// No position at all sits just under a first screen of the same app.
	const app = { rating: 5, ratingCount: 9 };
	assert.ok(referenceScore({ app, confidence: 'high', position: 1 }) > referenceScore({ app, confidence: 'high' }));
	assert.ok(referenceScore({ app, confidence: 'high' }) > referenceScore({ app, confidence: 'low' }));
	assert.ok(referenceScore({ app, confidence: 'nonsense' }) === referenceScore({ app, confidence: 'medium' }));
});

test('buildIndex ranks, joins velocity, and reports the flows nothing covers', () => {
	const references = [
		ref('ref_a', { flow: 'paywall', position: 1 }),
		ref('ref_b', { flow: 'paywall', position: 4, app: { name: 'B', trackId: 2, rating: 4.9, ratingCount: 900 } }),
	];
	const doc = buildIndex({
		plan: { slug: '2026-09-02', provider: 'appstore', country: 'US', flows: ['paywall', 'home'] },
		references,
		corpora: [corpus(1, REVIEWS, 4.5)],
		themes: { themes: [{ label: 't', trackId: 1, support: 1, reviewIds: ['r1'] }] },
		patterns: { claims: [{ claim: 'e', kind: 'evidence' }, { claim: 'h', kind: 'hypothesis' }] },
		previous: { generatedAt: '2026-08-23T00:00:00Z', apps: [{ trackId: 1, ratingCount: 9899 }] },
		now: '2026-09-02T00:00:00Z',
	});

	assert.deepEqual(doc.references.map((r) => r.id), ['ref_a', 'ref_b']);
	assert.deepEqual(doc.references.map((r) => r.rank), [1, 2]);
	assert.deepEqual(doc.apps.map((a) => a.trackId), [1, 2]);
	assert.equal(doc.apps[0].ratingVelocity, 10);
	assert.equal(doc.apps[1].ratingVelocity, null);
	assert.equal(doc.apps[0].reviews, 4);
	assert.equal(doc.apps[0].reviewMean, 4.5);
	assert.equal(doc.apps[0].themes, 1);
	assert.deepEqual(doc.coverage, { paywall: { references: 2, apps: 2 }, home: { references: 0, apps: 0 } });
	assert.deepEqual(doc.claims, { total: 2, evidence: 1, hypothesis: 1 });
	assert.deepEqual(doc.reviews, { apps: 1, total: 4 });
});

test('buildIndex still lists an app that has reviews but no references yet', () => {
	const doc = buildIndex({ plan: {}, references: [], corpora: [corpus(7, [review('r', 3)])] });
	assert.deepEqual(doc.apps.map((a) => a.name), ['app 7']);
	assert.equal(doc.apps[0].references, 0);
	assert.equal(doc.provider, 'appstore');
	assert.deepEqual(doc.coverage, {});
});

test('buildIndex skips a reference whose app was never identified', () => {
	const doc = buildIndex({ plan: { flows: [] }, references: [{ id: 'ref_x', app: {} }], corpora: [] });
	assert.deepEqual(doc.apps, []);
	assert.equal(doc.references[0].trackId, null);
	assert.equal(doc.references[0].flow, null);
});

test('the gates survive artifacts that are missing the fields they check', () => {
	assert.deepEqual(checkReferences([{}], new Map(), null), []);
	assert.deepEqual(checkClaims({ claims: [{}] }, []), ['claim "?": cites no references']);
	assert.deepEqual(checkBudget(null, { apps: 1, references: 1, reviewPages: 1 }), [
		'budget: apps 1 exceeds the planned cap of 0',
		'budget: references 1 exceeds the planned cap of 0',
		'budget: review pages 1 exceeds the planned cap of 0',
	]);
	assert.deepEqual(checkThemes({ themes: [{ label: 'x', support: 0, reviewIds: [] }] }, new Map(), new Map()), []);
	const { byId, appMeans } = indexReviews([{ trackId: 1 }]);
	assert.equal(byId.size, 0);
	assert.equal(appMeans.get(1), 0);
});
