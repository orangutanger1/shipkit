// The planner decides what a run costs before it spends anything, so the
// arithmetic here is the fetch budget the verify gate later holds the run to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalise } from '../src/config.mjs';
import { DEFAULT_RESEARCH_FLOWS } from '../src/lib/flows.mjs';
import { SORTS, buildPlan, rankApps, requestCost, resolveFlows, slugFor } from '../src/lib/research-plan.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';

const cfg = (over = {}) => normalise({ name: 'Demo', bundleId: 'com.demo.app', ...over }, '/repo/ship.config.json');

const rows = [
	{ id: 1, name: 'Huge', ratings: 1_000_000, stars: 4.4 },
	{ id: 2, name: 'Beloved', ratings: 300, stars: 4.9 },
	{ id: 3, name: 'Solid', ratings: 210_433, stars: 4.7 },
];

test('ranking weights ratings logarithmically, so scale cannot swamp quality', () => {
	const [first, second, third] = rankApps(rows, 3);
	assert.deepEqual([first.name, second.name, third.name], ['Huge', 'Solid', 'Beloved']);
	assert.deepEqual([first.rank, second.rank, third.rank], [1, 2, 3]);
	assert.match(second.why, /4\.7★ over 210,433 ratings/);
	// 3,333x the ratings buys 2.2x the score: a 4.4 at a million still leads a
	// 4.9 at three hundred, but it cannot bury the rest of the plan.
	assert.ok(first.score / third.score < 3, `${first.score} vs ${third.score}`);
});

test('ranking is total: equal scores fall back to ratings, then to id', () => {
	const tied = [
		{ id: 20, name: 'b', ratings: 100, stars: 4 },
		{ id: 10, name: 'a', ratings: 100, stars: 4 },
		{ id: 5, name: 'c', ratings: 999, stars: 0 },
	];
	assert.deepEqual(rankApps(tied, 3).map((a) => a.trackId), [10, 20, 5]);
	assert.deepEqual(rankApps(tied, 3).map((a) => a.trackId), rankApps([...tied].reverse(), 3).map((a) => a.trackId));
});

test('ranking drops rows with no usable id and clamps nonsense ratings', () => {
	const junk = [{ id: 'not-a-number', name: 'x' }, { id: 7, name: 'y', ratings: -5, stars: 9 }];
	const [only] = rankApps(junk, 5);
	assert.equal(rankApps(junk, 5).length, 1);
	assert.deepEqual([only.trackId, only.ratings, only.stars], [7, 0, 5]);
	assert.equal(only.why, '5★ over 0 ratings');
});

test('an app with no ratings at all still describes itself', () => {
	const [only] = rankApps([{ id: 9, name: 'New' }], 1);
	assert.equal(only.score, 0);
	assert.equal(only.why, '?★ over 0 ratings');
});

test('ranking honours the limit and names an app the storefront did not', () => {
	assert.equal(rankApps(rows, 2).length, 2);
	assert.equal(rankApps([{ id: 42 }], 1)[0].name, 'app 42');
});

test('request cost counts one lookup, N screenshots and review pages per sort', () => {
	assert.deepEqual(requestCost({ apps: 12, screensPerApp: 10, reviewPages: 10 }, 12), {
		lookup: 12,
		screenshots: 120,
		reviews: 240,
		total: 372,
	});
	assert.equal(SORTS.length, 2);
});

test('cost is charged for the apps actually planned, not the budgeted maximum', () => {
	assert.equal(requestCost({ apps: 12, screensPerApp: 10, reviewPages: 10 }, 3).total, 3 + 30 + 60);
});

test('flows come from the flag, then the config, then the default set', () => {
	assert.deepEqual(resolveFlows([], undefined), [...DEFAULT_RESEARCH_FLOWS]);
	assert.deepEqual(resolveFlows(['paywall'], undefined), ['paywall']);
	assert.deepEqual(resolveFlows(['paywall'], 'welcome,home'), ['welcome', 'home']);
});

test('flow lists are deduped and unknown names raise with the vocabulary', () => {
	assert.deepEqual(resolveFlows([], 'paywall, paywall ,welcome'), ['paywall', 'welcome']);
	assert.throws(() => resolveFlows([], 'onboarding'), /unknown research flow "onboarding"/);
	assert.throws(() => resolveFlows([], ' , '), /no flows to research/);
});

test('a slug is the date, plus a name when one run needs telling from another', () => {
	assert.equal(slugFor('2026-09-02T12:00:00Z'), '2026-09-02');
	assert.equal(slugFor('2026-09-02T12:00:00Z', 'Paywall Sweep!'), '2026-09-02-paywall-sweep');
});

test('a plan names its apps, flows, budget and every output path', async () => {
	const plan = buildPlan({
		cfg: cfg(),
		competitors: rows,
		flows: ['paywall'],
		slug: '2026-09-02',
		country: 'US',
		now: '2026-09-02T12:00:00Z',
	});
	assert.deepEqual(await checkArtifact('research-plan', plan, 'plan.json'), []);
	assert.equal(plan.provider, 'appstore');
	assert.deepEqual(plan.apps.map((a) => a.rank), [1, 2, 3]);
	assert.equal(plan.budget.requests.total, 3 + 30 + 60);
	assert.equal(plan.outputs.index, '2026-09-02/index.json');
});

test('--apps narrows the run but can never widen it past the configured budget', () => {
	const base = { cfg: cfg({ research: { budget: { apps: 2 } } }), competitors: rows, flows: ['paywall'], slug: '2026-09-02', country: 'US' };
	assert.equal(buildPlan({ ...base, apps: 1 }).apps.length, 1);
	assert.equal(buildPlan({ ...base, apps: 50 }).budget.apps, 2);
	assert.equal(buildPlan(base).apps.length, 2);
});

test('the plan carries the product identity the design step reads back', () => {
	const plan = buildPlan({
		cfg: cfg({ product: { category: 'health-fitness', audience: 'lapsed runners' } }),
		competitors: rows,
		flows: ['home'],
		slug: '2026-09-02',
		country: 'GB',
	});
	assert.deepEqual(plan.product, { category: 'health-fitness', audience: 'lapsed runners' });
	assert.equal(plan.country, 'GB');
});

test('planning with no competitor set is refused, not planned empty', () => {
	assert.throws(
		() => buildPlan({ cfg: cfg(), competitors: [], flows: ['home'], slug: '2026-09-02', country: 'US' }),
		/no competitor apps to research/,
	);
});
