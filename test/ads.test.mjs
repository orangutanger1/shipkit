// The two halves of `ship ads` that spend money without a human in the loop:
// `decide()` (which keywords get negated or promoted) and `buildPlan()` (how the
// budget is cut). Both are pure, so both are tested at the thresholds — an
// off-by-a-cent here either burns budget or negates a converting keyword.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT, allocate, buildPlan, convertingTerms, decide, help, parseSplit, searchTermRows } from '../src/commands/ads.mjs';

const row = (over = {}) => ({
	term: 'oil change reminder',
	matchType: null,
	campaignId: '11',
	campaignName: 'Glovebox · Discovery · US',
	adGroupId: '21',
	adGroupName: 'DISC · US',
	impressions: 100,
	taps: 10,
	installs: 0,
	spend: 0,
	...over,
});

test('help names every subcommand the registry advertises', () => {
	for (const sub of ['status', 'plan', 'sync', 'mine', 'report']) assert.ok(help.includes(sub), sub);
	assert.ok(help.includes('ship ads'));
});

test('decide: an empty report decides nothing', () => {
	assert.deepEqual(decide([], { targetCpi: 2 }), {
		targetCpi: 2,
		wasteThreshold: 4,
		negatives: [],
		promotions: [],
	});
});

test('decide: spend exactly 2x target CPI is not yet waste, one cent past it is', () => {
	const at = decide([row({ spend: 4 })], { targetCpi: 2 });
	assert.deepEqual(at.negatives, [], 'exactly at the line keeps its budget');

	const past = decide([row({ spend: 4.01 })], { targetCpi: 2 });
	assert.equal(past.negatives.length, 1);
	assert.equal(past.negatives[0].term, 'oil change reminder');
	assert.equal(past.negatives[0].matchType, 'EXACT');
	assert.equal(past.negatives[0].campaignId, '11');
});

test('decide: one install is enough to survive any spend', () => {
	const dead = decide([row({ spend: 40, installs: 0 })], { targetCpi: 2 });
	assert.deepEqual(
		dead.negatives.map((n) => n.term),
		['oil change reminder'],
	);

	const alive = decide([row({ spend: 40, installs: 1 })], { targetCpi: 2 });
	assert.deepEqual(alive.negatives, [], 'a converting term is never negated, however expensive');
	assert.deepEqual(alive.promotions, [], 'and $40 CPI is not a promotion either');
});

test('decide: converting at or under target is promoted, over target is left alone', () => {
	const { promotions } = decide(
		[
			row({ term: 'at target', spend: 4, installs: 2 }), // $2.00 CPI
			row({ term: 'under target', spend: 1.5, installs: 2 }), // $0.75 CPI
			row({ term: 'over target', spend: 4.02, installs: 2 }), // $2.01 CPI
		],
		{ targetCpi: 2 },
	);
	assert.deepEqual(
		promotions.map((p) => p.term),
		['under target', 'at target'],
		'cheapest first; over-target never promoted',
	);
	// The bid is the CPI the term actually converted at, clamped to the bid band.
	assert.equal(promotions[0].bid, 0.75);
	assert.equal(promotions[1].bid, 2);
});

test('decide: a term already targeted as Exact is not promoted again', () => {
	const { promotions } = decide(
		[
			row({ term: 'already exact', matchType: 'EXACT', spend: 1, installs: 2 }),
			row({ term: 'search match find', matchType: null, spend: 1, installs: 2 }),
		],
		{ targetCpi: 2 },
	);
	assert.deepEqual(
		promotions.map((p) => p.term),
		['search match find'],
	);
});

test('decide: the same term across ad groups is judged on its total spend', () => {
	// Neither row is past the line alone; together they are.
	const { negatives } = decide([row({ spend: 2.5 }), row({ spend: 2.5, adGroupId: '22' })], { targetCpi: 2 });
	assert.equal(negatives.length, 1);
	assert.equal(negatives[0].spend, 5);
});

test('decide: a target CPI is required, because the whole rule is relative to it', () => {
	assert.throws(() => decide([row()], {}), /target CPI/);
	assert.throws(() => decide([row()], { targetCpi: 0 }), /target CPI/);
});

test('searchTermRows reads the shape asc emits for a search-term report', () => {
	const rows = searchTermRows({
		data: {
			reportingDataResponse: {
				row: [
					{
						metadata: {
							searchTermText: 'Oil Change Reminder',
							searchTermSource: 'AUTO',
							matchType: 'BROAD',
							campaignId: 7,
							adGroupName: 'DISC · US',
						},
						total: { impressions: 90, taps: 9, installs: 1, localSpend: { amount: '3.50', currency: 'USD' } },
					},
				],
			},
		},
	});
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0].term, 'oil change reminder', 'terms are lowercased so they compare with keywords');
	assert.equal(rows[0].spend, 3.5);
	assert.equal(rows[0].installs, 1);
	assert.equal(rows[0].campaignId, 7);
});

test('convertingTerms keeps only what installed, and prices it', () => {
	const terms = convertingTerms([
		row({ term: 'winner', spend: 3, installs: 2 }),
		row({ term: 'winner', spend: 1, installs: 0 }),
		row({ term: 'loser', spend: 9, installs: 0 }),
	]);
	assert.deepEqual(terms, [{ term: 'winner', installs: 2, taps: 20, spend: 4, cpi: 2 }]);
});

const TERMS = [
	{ term: 'oil change reminder', demand: 80, competition: 60, opportunity: 48, top3: [{ name: 'Rival', id: 1, ratings: 900 }] },
	{ term: 'car maintenance log', demand: 40, competition: 50, opportunity: 20 },
	{ term: 'service history', demand: 5, competition: 90, opportunity: 5 },
];

const plan = (over = {}) =>
	buildPlan({
		app: { name: 'Glovebox', bundleId: 'com.example.glovebox', appId: 123 },
		locale: 'en-US',
		market: 'US',
		terms: TERMS,
		budget: 10,
		top: 10,
		generatedAt: '2026-01-01T00:00:00.000Z',
		...over,
	});

const roles = (p) => p.campaigns.map((cp) => cp.role);
// Money is compared in cents: summing four float dollar amounts is exactly the
// arithmetic the allocator exists to avoid.
const cents = (values) => values.reduce((s, v) => s + Math.round(v * 100), 0);
const daily = (p) => cents(p.campaigns.map((cp) => cp.dailyBudget));

test('buildPlan: four campaigns when there are competitors, three without', () => {
	assert.deepEqual(roles(plan()), ['exact', 'discovery', 'brand'], 'no competitors.json → no Competitor campaign');
	assert.deepEqual(roles(plan({ competitors: [{ name: 'AUTOsist: Maintenance', id: 9, ratings: 4000 }] })), [
		'exact',
		'discovery',
		'competitor',
		'brand',
	]);
});

test('buildPlan: the split always sums back to the requested budget', () => {
	for (const budget of [1, 7, 10, 33.33, 250]) {
		for (const competitors of [[], [{ name: 'AUTOsist' }, { name: 'Simply Auto' }]]) {
			const p = plan({ budget, competitors });
			assert.equal(p.budget.daily, budget, `daily total for ${budget} with ${competitors.length} rival(s)`);
			assert.equal(daily(p), Math.round(budget * 100), 'campaign budgets sum to the requested total');
			assert.equal(
				cents(Object.values(p.budget.split)),
				Math.round(budget * 100),
				'the reported split sums to the requested total',
			);
		}
	}
});

test('buildPlan: --split overrides the ratio and a zeroed role disappears', () => {
	const p = plan({ budget: 20, split: parseSplit('60/40') });
	assert.deepEqual(roles(p), ['exact', 'discovery']);
	assert.equal(p.budget.split.exact, 12);
	assert.equal(p.budget.split.discovery, 8);
	assert.equal(daily(p), 2000);
});

test('buildPlan: every Exact term is a negative in Discovery', () => {
	const p = plan({ competitors: [{ name: 'AUTOsist' }] });
	const exact = p.campaigns.find((cp) => cp.role === 'exact');
	const discovery = p.campaigns.find((cp) => cp.role === 'discovery');
	const negated = new Set(discovery.negativeKeywords.filter((k) => k.matchType === 'EXACT').map((k) => k.text));

	const exactTerms = exact.adGroups.flatMap((g) => g.keywords.map((k) => k.text));
	assert.ok(exactTerms.length > 1);
	for (const term of exactTerms) assert.ok(negated.has(term), `Discovery must negate the Exact term "${term}"`);
	assert.ok(negated.has('glovebox'), 'and the brand, which the Brand campaign buys cheaper');
	// A broad negative would also block the longer queries Discovery exists to find.
	assert.deepEqual(
		discovery.negativeKeywords.filter((k) => k.matchType === 'BROAD'),
		[],
	);
	assert.equal(discovery.adGroups[0].automatedKeywordsOptIn, true, 'Search Match is the point of Discovery');
});

test('buildPlan: terms under aso.minVolume are not worth bidding on', () => {
	const p = plan({ minVolume: 10 });
	const exact = p.campaigns.find((cp) => cp.role === 'exact');
	assert.deepEqual(
		exact.adGroups.map((g) => g.name),
		['EX · oil change reminder', 'EX · car maintenance log'],
	);
	assert.equal(p.targeting.dropped, 1);
	assert.throws(() => plan({ minVolume: 90 }), /minVolume/);
});

test('buildPlan: bids follow demand and stay inside the band', () => {
	const exact = plan({ budget: 10, minVolume: 10 }).campaigns.find((cp) => cp.role === 'exact');
	const [high, low] = exact.adGroups;
	assert.ok(high.demand > low.demand);
	assert.ok(high.defaultBidAmount > low.defaultBidAmount, 'more demand, more competition for the slot');
	// The band, not the formula, is what keeps a wrong guess cheap: a huge budget
	// still bids $2.00 a tap, a tiny one still bids enough to be served.
	for (const budget of [1, 10, 10_000])
		for (const cp of plan({ budget }).campaigns)
			for (const g of cp.adGroups)
				assert.ok(
					g.defaultBidAmount >= 0.3 && g.defaultBidAmount <= 2,
					`${g.name} bid ${g.defaultBidAmount} at $${budget}/day`,
				);
});

test('buildPlan: a linked custom product page rides along to sync', () => {
	const pages = [{ slug: 'oil-change', page: { name: 'Oil Change', adGroup: 'EX · oil change reminder' } }];
	const exact = plan({ pages }).campaigns.find((cp) => cp.role === 'exact');
	assert.deepEqual(exact.adGroups[0].productPage, { slug: 'oil-change', name: 'Oil Change' });
	assert.equal(exact.adGroups[1].productPage, undefined);
});

test('parseSplit: positional, named, and refusals', () => {
	assert.deepEqual(parseSplit(undefined), SPLIT);
	assert.deepEqual(parseSplit('40/30/20/10'), { exact: 40, discovery: 30, competitor: 20, brand: 10 });
	assert.deepEqual(parseSplit('exact=70,brand=30'), { exact: 70, discovery: 0, competitor: 0, brand: 30 });
	assert.throws(() => parseSplit('exact=70,nonsense=30'), /--split/);
	assert.throws(() => parseSplit('1/2/3/4/5'), /at most/);
	assert.throws(() => parseSplit('0/0/0/0'), /allocates nothing/);
});

test('allocate: cents-exact, remainder on the largest share', () => {
	assert.deepEqual(allocate(10, { a: 1, b: 1 }), { b: 5, a: 5 });
	const odd = allocate(0.07, { a: 2, b: 1 });
	assert.equal(odd.a + odd.b, 0.07);
	assert.equal(allocate(10, { a: 0 }).a, undefined, 'a zero weight gets no campaign at all');
});
