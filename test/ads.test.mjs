// The two halves of `ship ads` that spend money without a human in the loop:
// `decide()` (which keywords get negated or promoted) and `buildPlan()` (how the
// budget is cut and what each keyword bids). Both are pure, so both are tested at
// the thresholds — an off-by-a-cent here either burns budget or negates a
// converting keyword.
//
// Several tests below are regressions for a live account that lost its delivery
// to these exact edges: fifteen keywords clamped to one bid, a healthy keyword
// negated on three taps, and an ad-group budget field Apple does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SPLIT,
	allocate,
	buildPlan,
	convertingTerms,
	decide,
	help,
	parseSplit,
	planBindings,
	planTotals,
	renderPlan,
	searchTermRows,
} from '../src/commands/ads.mjs';
import { BID } from '../src/lib/asa.mjs';

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
	const d = decide([], { targetCpi: 2 });
	assert.equal(d.targetCpi, 2);
	assert.equal(d.wasteThreshold, 4);
	assert.deepEqual(d.negatives, []);
	assert.deepEqual(d.held, []);
	assert.deepEqual(d.promotions, []);
	// The resolved rule rides along so every artifact stamps one threshold rather
	// than recomputing its own.
	assert.equal(d.killRule.wasteThreshold, 4);
	assert.equal(d.killRule.minTaps, d.minTaps);
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

// ─── defect 3: the kill rule could prune a healthy account to nothing ────────

test('decide: three taps and zero installs proposes no negation, and says why', () => {
	// The live case: targetCpi $0.70 → a $1.40 waste line, which at a $0.53 CPT is
	// under three taps. A keyword converting at a healthy 40% shows zero installs
	// across three taps about 22% of the time, so ~2 of 9 keywords would be negated
	// per weekly cycle, permanently, on noise.
	const d = decide([row({ term: 'oil change app', taps: 3, spend: 1.59, installs: 0, impressions: 40 })], {
		targetCpi: 0.7,
	});
	assert.deepEqual(d.negatives, [], 'three taps is not evidence at any spend');
	assert.equal(d.held.length, 1, 'and the term is reported, not silently dropped');
	assert.equal(d.held[0].term, 'oil change app');
	assert.equal(d.held[0].taps, 3);
	assert.equal(d.held[0].needTaps, d.minTaps);
	assert.match(d.held[0].reason, /under the \d+ needed/);
	assert.equal(d.minTaps, 6, '95% confidence at a 40% tap→install rate');
});

test('decide: the tap floor is a floor, not a veto — enough taps still negates', () => {
	const opts = { targetCpi: 0.7 };
	const short = decide([row({ taps: 5, spend: 2.65 })], opts);
	const enough = decide([row({ taps: 6, spend: 3.18 })], opts);
	assert.deepEqual(short.negatives, []);
	assert.equal(short.held.length, 1);
	assert.equal(enough.negatives.length, 1);
	assert.deepEqual(enough.held, []);
	assert.match(enough.negatives[0].reason, /past 6 taps/);
	// Both conditions, not either: plenty of taps under the waste line is nothing.
	assert.deepEqual(decide([row({ taps: 40, spend: 1.4 })], opts).negatives, []);
});

test('decide: a lower assumed install rate demands a bigger sample', () => {
	const strict = decide([row({ taps: 8, spend: 4.01 })], { targetCpi: 2, baselineInstallRate: 0.1 });
	assert.equal(strict.minTaps, 29, 'a 10% keyword needs 29 taps before zero means anything');
	assert.deepEqual(strict.negatives, []);
	// And an explicit override wins over the derivation, for a human who has data.
	assert.equal(decide([row()], { targetCpi: 2, minTaps: 3 }).minTaps, 3);
});

test('decide: one threshold, echoed — targetCpi never falls back to subPrice', () => {
	// Three different thresholds across config, plan document and committed
	// artifact were possible because each recomputed the number from a different
	// input. subPrice is not a target CPI, and a missing target is an error.
	assert.throws(() => decide([row()], { subPrice: 14.99 }), /target CPI/);
	const d = decide([row()], { targetCpi: 0.7, subPrice: 2.99, source: 'ads.targetCpi' });
	assert.equal(d.killRule.targetCpi, 0.7);
	assert.equal(d.killRule.wasteThreshold, 1.4);
	assert.equal(d.killRule.breakeven, 2.99, 'subPrice sets breakeven, never the decision line');
	assert.equal(d.killRule.source, 'ads.targetCpi');
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
		// A plan states its own kill rule, so it cannot be built without the
		// threshold that rule is relative to.
		targetCpi: 1.5,
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

// ─── defect 2: the bid model was inert and the budget model was fictional ────

test('buildPlan: bids follow demand, vary, and never all land on the clamp', () => {
	const p = plan({ budget: 10, minVolume: 10 });
	const exact = p.campaigns.find((cp) => cp.role === 'exact');
	const [high, low] = exact.adGroups;
	assert.ok(high.demand > low.demand);
	assert.ok(high.defaultBidAmount > low.defaultBidAmount, 'more demand, more competition for the slot');

	// The live regression: $10/day over 15 keywords derived $0.086 for every one of
	// them and clamped all fifteen to Apple's $0.30 floor. A bid is a price in an
	// auction, so the budget must not enter it at all.
	const cheap = plan({ budget: 1, minVolume: 10 }).campaigns.find((cp) => cp.role === 'exact');
	assert.deepEqual(
		cheap.adGroups.map((g) => g.defaultBidAmount),
		exact.adGroups.map((g) => g.defaultBidAmount),
		'the daily budget does not move a single bid',
	);
	const bids = new Set(p.campaigns.flatMap((cp) => cp.adGroups.map((g) => g.defaultBidAmount)));
	assert.ok(bids.size > 1, `every bid identical: ${[...bids].join(', ')}`);
	assert.ok(!bids.has(BID.floor), `a bid sat on Apple's floor: ${[...bids].join(', ')}`);
	assert.equal(p.bidding.distinctBids, bids.size);
	for (const b of bids) assert.ok(b >= BID.floor && b <= BID.ceiling, `bid ${b} outside the band`);
});

test('buildPlan: the realised cost per tap outranks the seed, and --bid outranks both', () => {
	const seeded = plan();
	assert.equal(seeded.bidding.seed, BID.seed);
	assert.equal(seeded.bidding.source, 'default seed');

	// $0.30 lost an auction whose realised CPT was $0.53; the account's own price
	// is the only non-guess available.
	const measured = plan({ observedCpt: 0.53 });
	assert.equal(measured.bidding.seed, 0.53);
	assert.equal(measured.bidding.source, 'realised CPT');
	assert.ok(
		measured.campaigns[0].adGroups[0].defaultBidAmount !== seeded.campaigns[0].adGroups[0].defaultBidAmount,
		'a measured CPT changes the prices',
	);

	const forced = plan({ observedCpt: 0.53, bid: 1.2 });
	assert.equal(forced.bidding.seed, 1.2);
	assert.equal(forced.bidding.source, '--bid');
	// A human can set a market-clearing bid without hand-editing generated JSON.
	const floored = plan({ bid: 1, minBid: 0.9 });
	for (const cp of floored.campaigns)
		for (const g of cp.adGroups) assert.ok(g.defaultBidAmount >= 0.9, `${g.name} under --min-bid`);
	assert.throws(() => plan({ minBid: 0.1 }), /minimum/);
});

test('buildPlan: a model that clamps every keyword is refused, not shipped', () => {
	// --min-bid above the ceiling of the demand band clamps everything: the plan is
	// then a single price wearing an opportunity model, which is what shipped.
	assert.throws(() => plan({ bid: 0.35, minBid: 1.5, maxBid: 1.5 }), /clamped/);
});

test('buildPlan: no ad group carries a budget, because Apple has no such field', () => {
	const p = plan({ competitors: [{ name: 'AUTOsist' }] });
	for (const cp of p.campaigns) {
		assert.equal(typeof cp.dailyBudget, 'number', `${cp.name} must budget at campaign level`);
		for (const g of cp.adGroups) {
			assert.equal('dailyBudget' in g, false, `${g.name} must not claim a budget`);
			assert.equal(typeof g.defaultBidAmount, 'number');
			// Keyword-level bids, so a single keyword can be re-priced without moving
			// the group it happens to share a name with.
			for (const k of g.keywords) assert.equal(k.bid, g.defaultBidAmount, `${k.text} needs its own bid`);
		}
	}
	assert.match(p.budget.scope, /no ad-group budget/);
	const exact = p.campaigns.find((cp) => cp.role === 'exact');
	assert.match(exact.rationale, /Custom Product Page/, 'one group per keyword is justified on creative control');
	assert.doesNotMatch(exact.rationale, /owns its budget/, 'and never on a budget Apple does not have');
	assert.match(JSON.stringify(p).replace(/dailyBudgetAmount/g, ''), /dailyBudget/, 'campaign budget survives');
});

test('buildPlan: the artifact stamps the resolved parameters that produced it', () => {
	const p = plan({ budget: 12, top: 2, targetCpi: 0.7, subPrice: 2.99, observedCpt: 0.53 });
	assert.equal(p.params.budget, 12);
	assert.equal(p.params.top, 2);
	assert.equal(p.params.bidding.seed, 0.53);
	assert.equal(p.params.killRule.targetCpi, 0.7);
	assert.equal(p.params.killRule.wasteThreshold, 1.4);
	assert.equal(p.params.killRule.minTaps, 6);
	assert.equal(p.killRule.condition, p.params.killRule.condition, 'one rule, not two copies');
	assert.throws(() => plan({ targetCpi: null }), /target CPI/);
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

// Regression for a live account: `campaign-plan.md` was stale, the only way to
// refresh it was `ship ads plan`, and that rebuilds campaign-plan.json from
// scored.json — which would have dropped hand-set bids, nine pruned ad groups
// and three non-ASO keywords, after which `ship ads sync --force` would have
// reverted the account to match. Hence a binding check, --render and --force.
test('planBindings: an unsynced plan is disposable, a synced one is not', () => {
	const fresh = buildPlan({
		app: { name: 'Wrenchy' },
		terms: [{ text: 'oil change reminder', volume: 80 }],
		targetCpi: 1.1,
	});
	assert.deepEqual(planBindings(fresh), { bound: false, objects: 0, syncedAt: null });
	assert.deepEqual(planBindings(null), { bound: false, objects: 0, syncedAt: null });
	assert.deepEqual(planBindings({}), { bound: false, objects: 0, syncedAt: null });
});

test('planBindings: counts ids at every depth and keeps the newest syncedAt', () => {
	const bound = planBindings({
		campaigns: [
			{
				name: 'Wrenchy · Exact · US',
				apple: { id: '2144507320', syncedAt: '2026-08-26T02:41:00.000Z' },
				adGroups: [
					{
						name: 'EX · oil change reminder',
						apple: { id: '2150517194', syncedAt: '2026-08-26T22:13:56.193Z' },
						keywords: [{ text: 'oil change reminder', apple: { id: '2303536512' } }],
					},
					{ name: 'EX · unsynced', keywords: [{ text: 'car maintenance' }] },
				],
				negativeKeywords: [{ text: 'segway', apple: { id: '9' } }],
			},
		],
	});
	assert.equal(bound.bound, true);
	assert.equal(bound.objects, 4, 'campaign + ad group + keyword + negative');
	assert.equal(bound.syncedAt, '2026-08-26T22:13:56.193Z', 'newest, not last seen');
});

test('renderPlan: a bound plan documents why plan refuses to overwrite it', () => {
	const p = buildPlan({ app: { name: 'Wrenchy' }, terms: [{ text: 'oil change reminder', volume: 80 }], targetCpi: 1.1 });
	assert.ok(!renderPlan(p).includes('bound to a live account'), 'a fresh plan carries no such warning');

	p.campaigns[0].apple = { id: '2144507320', syncedAt: '2026-08-26T22:13:56.193Z' };
	const md = renderPlan(p, { renderedAt: '2026-08-26T23:00:00.000Z' });
	assert.ok(md.includes('bound to a live account'), 'the document says so');
	assert.ok(md.includes('1 Apple object id(s)'));
	assert.ok(md.includes('2026-08-26T22:13:56.193Z'));
	assert.ok(md.includes('--force'), 'and names the flag that would destroy it');
	assert.ok(md.includes('Re-rendered 2026-08-26T23:00:00.000Z'), 'provenance separates a render from a replan');
	assert.ok(md.includes(`Generated ${p.generatedAt}`), 'the plan date survives the render');
});

test('renderPlan: rendering is pure — same doc in, same markdown out', () => {
	const p = buildPlan({ app: { name: 'Wrenchy' }, terms: [{ text: 'oil change reminder', volume: 80 }], targetCpi: 1.1 });
	assert.equal(renderPlan(p), renderPlan(p));
	assert.ok(renderPlan(p).includes('- **Market**:'), 'the market line is not lost to the provenance block');
});

test('help: --render and the plan overwrite guard are documented', () => {
	assert.ok(help.includes('--render'));
	assert.ok(help.includes('will not overwrite a plan carrying Apple object ids'));
});

// The bug `--render` surfaced on the first real run: the summary bullets came
// from the stamped `budget`/`bidding` params while the tables came from the
// campaigns, so a hand-edited plan rendered "$30.00/day" above campaigns
// totalling $32.00. `sync` pushes campaigns, so campaigns are the truth.
test('planTotals: derives budget, split and bids from the campaigns', () => {
	const t = planTotals({
		budget: { daily: 30 },
		bidding: { distinctBids: 9 },
		campaigns: [
			{ role: 'exact', dailyBudget: 12, adGroups: [{ defaultBidAmount: 0.68 }, { defaultBidAmount: 0.78 }] },
			{ role: 'discovery', dailyBudget: 15, adGroups: [{ defaultBidAmount: 0.75 }] },
			{ role: 'competitor', dailyBudget: 4, adGroups: [{ defaultBidAmount: 1.5 }] },
			{ role: 'brand', dailyBudget: 1, adGroups: [{ defaultBidAmount: 0.3 }] },
		],
	});
	assert.equal(t.daily, 32);
	assert.deepEqual(t.split, { exact: 12, discovery: 15, competitor: 4, brand: 1 });
	assert.deepEqual(t.bids, [0.3, 0.68, 0.75, 0.78, 1.5]);
	assert.equal(t.drifted, true, '$30 stamped against $32 of campaigns');
	assert.equal(t.stamped.daily, 30);
});

test('planTotals: a fresh plan does not drift from its own params', () => {
	const p = buildPlan({
		app: { name: 'Wrenchy' },
		terms: [{ text: 'oil change reminder', volume: 80 }, { text: 'car maintenance log', volume: 60 }],
		budget: 10,
		targetCpi: 1.1,
	});
	const t = planTotals(p);
	assert.equal(t.drifted, false);
	assert.equal(t.daily, p.budget.daily);
});

test('planTotals: cents survive the sum, and an empty plan is zero not NaN', () => {
	const t = planTotals({ campaigns: [{ dailyBudget: 0.07 }, { dailyBudget: 0.14 }] });
	assert.equal(t.daily, 0.21, 'no float dust');
	assert.deepEqual(planTotals({}), { daily: 0, split: {}, bids: [], stamped: { daily: null, distinctBids: null }, drifted: false });
});

test('renderPlan: a drifted plan reports the campaigns, not the stamped params', () => {
	const p = buildPlan({ app: { name: 'Wrenchy' }, terms: [{ text: 'oil change reminder', volume: 80 }], budget: 10, targetCpi: 1.1 });
	assert.ok(renderPlan(p).includes('**Daily budget**: $10.00'));
	assert.ok(!renderPlan(p).includes('Stamped parameters are historical'));

	for (const cp of p.campaigns) cp.dailyBudget = 8;
	const md = renderPlan(p);
	assert.ok(md.includes(`**Daily budget**: ${`$${(8 * p.campaigns.length).toFixed(2)}`}`), 'summed from campaigns');
	assert.ok(md.includes('Stamped parameters are historical'));
	assert.ok(md.includes('$10.00/day'), 'and says what it was generated for');
});
