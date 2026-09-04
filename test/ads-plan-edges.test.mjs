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
