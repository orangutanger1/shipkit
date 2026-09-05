// The plan builder and its renderer, on the inputs a real repo eventually
// produces: a term with no incumbents, an app with no brand word, a plan bound
// to an account, a report row with nothing in it. All pure — no credentials,
// no network, no files except the two `--render` reads.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, inDir, repo, writeFiles } from './fixtures/cmd.mjs';
import {
	allocate, buildPlan, convertingTerms, decide, parseSplit, planBindings, planTotals,
	renderOnly, renderPlan, searchTermRows,
} from '../src/lib/ads-plan.mjs';

const term = (over = {}) => ({ term: 'oil change reminder', demand: 80, competition: 20, opportunity: 60, ...over });
const app = { name: 'Demo', bundleId: 'com.demo.app', appId: '111' };

test('a split can be given positionally or by name, and nonsense is refused', () => {
	assert.deepEqual(parseSplit('50/25/15/10'), { exact: 50, discovery: 25, competitor: 15, brand: 10 });
	assert.deepEqual(parseSplit('exact=60,brand=40'), { exact: 60, discovery: 0, competitor: 0, brand: 40 });
	assert.throws(() => parseSplit('half/half'), /split/i);
	assert.throws(() => parseSplit('exact=x'), /split/i);
});

test('allocation is cents-exact, and the remainder lands on the largest share', () => {
	assert.deepEqual(allocate(10, { a: 1 / 3, b: 2 / 3 }), { a: 3.33, b: 6.67 });
});

test('a named --split entry with no "=" at all is as unreadable as one with no number', () => {
	assert.throws(() => parseSplit('exact'), /--split: cannot read "exact"/);
});

test('a plan with no brand word and no category keywords still budgets what it has', () => {
	const p = buildPlan({ app: { name: '', bundleId: '', appId: null }, terms: [term()], budget: 10, targetCpi: 2 });
	assert.ok(p.campaigns.length);
	assert.equal(p.budget.daily, 10);
});

test('a term with no incumbents and no ids plans anyway', () => {
	const p = buildPlan({ app, terms: [term({ top3: [{ name: 'Rival' }] })], budget: 10, targetCpi: 2 });
	const group = p.campaigns[0].adGroups[0];
	assert.equal(group.incumbents[0].id, null);
	assert.equal(group.incumbents[0].ratings, null);
});

test('a competitor with no name is targeted by its own text', () => {
	const p = buildPlan({ app, terms: [term()], competitors: [{ trackId: 1 }, { name: 'Rival', trackId: 2 }], budget: 10, targetCpi: 2 });
	const competitor = p.campaigns.find((c) => c.role === 'competitor');
	assert.ok(competitor, 'competitors were given, so the campaign exists');
});

test('a Competitor campaign still negates nothing when the app itself has no brand word', () => {
	// Normally Competitor negates the app's own name so Brand keeps that traffic
	// cheaper; an app with no readable name has nothing to negate.
	const p = buildPlan({ app: { name: '' }, terms: [term()], competitors: [{ name: 'Rival' }], budget: 10, targetCpi: 2 });
	const competitor = p.campaigns.find((c) => c.role === 'competitor');
	assert.deepEqual(competitor.negativeKeywords, []);
});

test('every scored term reading as the rival brand itself leaves nothing for Exact', () => {
	// If a token appears in the top-3 sellers and is rare across the scored set,
	// it reads as a brand word — and a term made entirely of such words is not
	// worth an Exact ad group of its own; it becomes a Competitor candidate.
	const p = buildPlan({
		app: { name: '' },
		terms: [{ term: 'acmeco pro', demand: 80, opportunity: 60, top3: [{ name: 'Rival', seller: 'AcmeCo' }] }],
		budget: 10,
		targetCpi: 2,
	});
	assert.equal(p.campaigns.find((c) => c.role === 'exact'), undefined, 'nothing survived to bid Exact on');
	const discovery = p.campaigns.find((c) => c.role === 'discovery');
	assert.equal(discovery.adGroups[0].demand, 100, 'no category term left to derive a mid demand from, so it defaults');
});

test('a plan with every role zeroed out builds zero campaigns, not an empty-array crash', () => {
	// exact is zeroed because every term reads as branded, brand is zeroed
	// because the app has no name, and this split explicitly zeroes the rest —
	// nothing is left to bid on, and that has to be a valid, renderable plan.
	const p = buildPlan({
		app: { name: '' },
		terms: [{ term: 'acmeco pro', demand: 80, opportunity: 60, top3: [{ name: 'Rival', seller: 'AcmeCo' }] }],
		budget: 10,
		targetCpi: 2,
		split: { discovery: 0, competitor: 0 },
	});
	assert.deepEqual(p.campaigns, []);
	assert.deepEqual(p.bidding.range, [null, null], 'no bid was ever priced');
	assert.equal(p.bidding.distinctBids, 0);
	assert.match(renderPlan(p), /\*\*Bids\*\*: —/, 'the document says so plainly rather than printing "undefined"');
});

test('a custom product page named for a campaign role rides along to sync', () => {
	// A page is bound to an ad group by name; the slug stands in when the page
	// itself is unnamed.
	const built = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 });
	const adGroup = built.campaigns[0].adGroups[0].name;
	const p = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2, pages: [{ slug: 'runners', page: { adGroup } }] });
	const withPage = p.campaigns.flatMap((c) => c.adGroups).find((g) => g.productPage);
	assert.equal(withPage?.productPage.name, 'runners', 'a page with no name of its own is named by its slug');
});

test('plan totals and bindings read a plan that carries nothing', () => {
	assert.deepEqual(planBindings(null), { bound: false, objects: 0, syncedAt: null });
	const totals = planTotals({ campaigns: [{ name: 'C', dailyBudget: 5, adGroups: [{ defaultBidAmount: 0 }] }] });
	assert.equal(totals.daily, 5);
	assert.deepEqual(totals.bids, [], 'an ad group with no bid contributes none');
	assert.deepEqual(planTotals({}).split, {});
});

test('the markdown renders a plan with one bid, with none, and one bound to an account', () => {
	const one = renderPlan(buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 }));
	assert.match(one, /Bids/);

	const base = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 });
	const bound = renderPlan({
		...base,
		campaigns: [
			{ ...base.campaigns[0], apple: { id: '1', syncedAt: '2026-06-01T00:00:00.000Z' }, adGroups: [{ name: 'g', keywords: [{ text: 'k', matchType: 'EXACT' }], defaultBidAmount: 1 }] },
		],
	});
	assert.match(bound, /last at 2026-06-01/);
	assert.match(bound, /—/, 'an ad group with no demand, page or incumbents renders as dashes');
});

test('the markdown shows an incumbent rating when one was scored, and a bound account with no sync timestamp yet', () => {
	const p = buildPlan({ app, terms: [term({ top3: [{ name: 'Rival', id: 1, ratings: 900 }] })], budget: 10, targetCpi: 2 });
	assert.match(renderPlan(p), /Rival \(900\)/, 'a rated incumbent is shown with its rating');

	p.campaigns[0].apple = { id: '1' };
	const md = renderPlan(p);
	assert.match(md, /bound to a live account/);
	assert.doesNotMatch(md, /last at/, 'no syncedAt on the stamp means none is claimed');
});

test('the markdown names the product page an ad group was linked to', () => {
	const built = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 });
	const adGroup = built.campaigns[0].adGroups[0].name;
	const p = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2, pages: [{ slug: 'runners', page: { name: 'Runners Page', adGroup } }] });
	assert.match(renderPlan(p), /Runners Page/);
});

test('the markdown reports terms dropped under the demand floor', () => {
	const p = buildPlan({ app, terms: [term(), term({ term: 'quiet term', demand: 1 })], budget: 10, targetCpi: 2, minVolume: 10 });
	assert.match(renderPlan(p), /dropped 1 of 2 scored terms/);
});

test('--render refuses when there is no plan to render, and rewrites the markdown when there is', async () => {
	const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app' }, prefix: 'ship-adsplan-' });
	const cfg = await inDir(dir, () => import('../src/config.mjs').then((m) => m.loadConfig()));
	await assert.rejects(
		() => renderOnly({ cfg, flags: {}, planFile: join(dir, 'plan.json'), mdFile: join(dir, 'plan.md'), onDisk: null }),
		/no plan to render/,
	);

	const doc = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 });
	await capture(() => renderOnly({ cfg, flags: {}, planFile: join(dir, 'plan.json'), mdFile: join(dir, 'plan.md'), onDisk: doc }));
	assert.match(await readFile(join(dir, 'plan.md'), 'utf8'), /Territory|Campaign|Bids/);
});

test('--render tells a human about a live binding even before it was ever synced', async () => {
	// `sync` can stamp an Apple id without a `syncedAt` yet on an older artifact
	// shape; the note must still name the binding without claiming a time it
	// does not have.
	const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app' }, prefix: 'ship-adsplan-' });
	const cfg = await inDir(dir, () => import('../src/config.mjs').then((m) => m.loadConfig()));
	const doc = buildPlan({ app, terms: [term()], budget: 10, targetCpi: 2 });
	doc.campaigns[0].apple = { id: '1' };
	const { out } = await capture(() => renderOnly({ cfg, flags: {}, planFile: join(dir, 'plan.json'), mdFile: join(dir, 'plan.md'), onDisk: doc }));
	assert.match(out, /1 Apple object id\(s\) in this plan —/, 'no "last synced" clause when there is no timestamp to report');
});

test('search-term rows survive a payload with no rows, and rows with no term', () => {
	assert.deepEqual(searchTermRows(null), []);
	assert.deepEqual(searchTermRows({ rows: [{ metadata: {} }] }), []);
	const rows = searchTermRows({ rows: [{ metadata: { searchTermText: 'Free Thing' }, granularity: [{ taps: 3 }] }] });
	assert.equal(rows[0].term, 'free thing', 'terms are folded to lower case before anything counts them');
	assert.equal(rows[0].taps, 3);
});

test('decide needs a target CPI, and answers with nothing for no rows', () => {
	assert.throws(() => decide([], {}), /target CPI/);
	const empty = decide([], { targetCpi: 2 });
	assert.deepEqual([empty.negatives, empty.promotions, empty.held], [[], [], []]);
});

test('converting terms are folded per term and sorted by installs', () => {
	const rows = [
		{ term: 'a', installs: 1, taps: 2, spend: 1 },
		{ term: 'a', installs: 2, taps: 3, spend: 2 },
		{ term: 'b', installs: 5, taps: 9, spend: 5 },
		{ term: '', installs: 9, taps: 9, spend: 9 },
	];
	const folded = convertingTerms(rows);
	assert.deepEqual(folded.map((t) => t.term), ['b', 'a']);
	assert.equal(folded[1].installs, 3);
	assert.deepEqual(convertingTerms(), []);
});

test('a row with no term at all is unattributable, same as one with an empty term', () => {
	// Apple's export always carries a term; a hand-edited or truncated file might
	// not, and that row must be skipped rather than folded under "undefined".
	assert.deepEqual(convertingTerms([{ installs: 4, taps: 4, spend: 4 }]), []);
});

test('converting terms tied on installs fall back to the term, alphabetically', () => {
	const tied = convertingTerms([
		{ term: 'zebra', installs: 3, taps: 3, spend: 3 },
		{ term: 'apple', installs: 3, taps: 3, spend: 3 },
	]);
	assert.deepEqual(tied.map((t) => t.term), ['apple', 'zebra']);
});

test('a search-term report whose `row` is not a list contributes nothing', () => {
	// Seen once in a malformed export: `row` present but an object, not an array.
	// Treating it as "no rows" is the honest read, not a crash.
	assert.deepEqual(searchTermRows({ data: { reportingDataResponse: { row: {} } } }), []);
});

test('a flat search-term row with no metadata wrapper reads itself as the metadata', () => {
	// Some presets do not nest under `metadata`/`total`; the fields sit directly
	// on the row.
	const rows = searchTermRows({ rows: [{ searchTermText: 'Direct Term', taps: 7, installs: 2, localSpend: { amount: '1.50' } }] });
	assert.equal(rows[0].term, 'direct term');
	assert.equal(rows[0].taps, 7);
	assert.equal(rows[0].installs, 2);
	assert.equal(rows[0].spend, 1.5);
});

test('a metric field that is not a scalar reads as missing, not NaN', () => {
	// A malformed export could carry an object where a count belongs; the row
	// should still price out rather than poisoning every sum downstream with NaN.
	const rows = searchTermRows({
		rows: [{ metadata: { searchTermText: 'garbled' }, total: { impressions: {}, taps: 5, installs: 1, localSpend: { amount: '1.00' } } }],
	});
	assert.equal(rows[0].impressions, 0, 'a non-scalar impressions count is treated as absent');
	assert.equal(rows[0].taps, 5);
});

test('decide reads a missing report the same as an empty one', () => {
	// `mine` can be run before any report exists; `decide(undefined, ...)` must
	// not throw on the array operations that follow.
	assert.deepEqual(decide(undefined, { targetCpi: 2 }), decide([], { targetCpi: 2 }));
});

test('a row with no term is not evidence for or against anything', () => {
	assert.deepEqual(decide([{ spend: 40 }], { targetCpi: 2 }).negatives, []);
});

test('decide ties on CPI by installs, then breaks a further tie by term name', () => {
	const row = (over) => ({ term: 'x', matchType: null, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, impressions: 10, taps: 10, ...over });
	const { promotions } = decide(
		[
			row({ term: 'zeta', spend: 2, installs: 2 }), // cpi 1, most installs
			row({ term: 'beta', spend: 1, installs: 1 }), // cpi 1, tied with alpha on installs
			row({ term: 'alpha', spend: 1, installs: 1 }),
		],
		{ targetCpi: 2 },
	);
	assert.deepEqual(promotions.map((p) => p.term), ['zeta', 'alpha', 'beta'], 'installs breaks the CPI tie, then the term name breaks that tie');
});

test('two negated terms are ordered by spend, not by report order', () => {
	// This exercises the comparator itself (a one-element sort never calls its
	// callback), because a negatives list an operator reads top-to-bottom had
	// better already be worst-first.
	const row = (over) => ({ term: 'x', matchType: null, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, impressions: 10, taps: 10, installs: 0, ...over });
	const { negatives } = decide([row({ term: 'cheap waste', spend: 5 }), row({ term: 'expensive waste', spend: 6 })], { targetCpi: 2 });
	assert.deepEqual(negatives.map((n) => n.term), ['expensive waste', 'cheap waste']);
});

test('two negated terms that wasted the exact same amount are ordered by name', () => {
	const row = (over) => ({ term: 'x', matchType: null, campaignId: null, campaignName: null, adGroupId: null, adGroupName: null, impressions: 10, taps: 10, installs: 0, spend: 5, ...over });
	const { negatives } = decide([row({ term: 'zebra waste' }), row({ term: 'alpha waste' })], { targetCpi: 2 });
	assert.deepEqual(negatives.map((n) => n.term), ['alpha waste', 'zebra waste'], 'spend ties break alphabetically, not by report order');
});
