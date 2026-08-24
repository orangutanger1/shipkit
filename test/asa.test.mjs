// The Apple Search Ads decision core: reconciliation, the economic guardrail and
// config coherence. Every test here is a regression for something that happened
// to a live account on 2026-08-23, where a single `ship ads sync` created 15 ad
// groups at a losing bid, paused the only one that was delivering, and reported
// none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BID,
	assertBidSpread,
	bidFor,
	checkAdsConfig,
	lastModified,
	monetisation,
	normaliseAdGroup,
	normaliseCampaign,
	normaliseKeyword,
	parseAppleTime,
	reconcile,
	resolveBidding,
	resolveKillRule,
	tapsForConfidence,
} from '../src/lib/asa.mjs';
import { normalise } from '../src/config.mjs';

// ─── defect 1: sync silently destroyed working campaigns ─────────────────────

/** One planned campaign, with the ids a synced plan carries under `apple`. */
const planned = (over = {}) => ({
	role: 'exact',
	name: 'Wrenchy · Exact · US',
	dailyBudget: 10,
	adGroups: [
		{
			name: 'EX · maintenance intent · US',
			defaultBidAmount: 0.75,
			automatedKeywordsOptIn: false,
			keywords: [{ text: 'oil change reminder', matchType: 'EXACT', bid: 0.75 }],
		},
	],
	negativeKeywords: [],
	...over,
});

const live = (over = {}) => ({
	...normaliseCampaign({ id: 100, name: 'Wrenchy · Exact · US', status: 'ENABLED', dailyBudgetAmount: { amount: '10.00' } }),
	adGroups: [
		{
			...normaliseAdGroup({ id: 200, name: 'EX · maintenance intent · US', status: 'ENABLED', defaultBidAmount: { amount: '0.75' } }),
			keywords: [normaliseKeyword({ id: 300, text: 'oil change reminder', matchType: 'EXACT', status: 'ACTIVE', bidAmount: { amount: '0.75' } })],
		},
	],
	negativeKeywords: [],
	...over,
});

/** A plan that has already been synced: every object carries Apple's id. */
function synced() {
	const cp = planned();
	cp.apple = { id: '100', name: cp.name, dailyBudget: 10, status: 'ENABLED' };
	cp.adGroups[0].apple = {
		id: '200',
		name: cp.adGroups[0].name,
		defaultBidAmount: 0.75,
		automatedKeywordsOptIn: false,
		status: 'ENABLED',
	};
	cp.adGroups[0].keywords[0].apple = {
		id: '300',
		text: 'oil change reminder',
		matchType: 'EXACT',
		bidAmount: 0.75,
		status: 'ACTIVE',
	};
	return cp;
}

test('reconcile: an account already matching the plan is a no-op with zero mutations', () => {
	const r = reconcile({ planned: [synced()], live: [live()] });
	assert.deepEqual(r.mutations, [], 'a matching account must not be written to');
	assert.deepEqual(r.destructive, []);
	assert.deepEqual(r.conflicts, []);
	assert.deepEqual(r.unplanned, []);
	assert.deepEqual(
		r.actions.map((a) => a.op),
		['noop', 'noop', 'noop'],
	);
});

test('reconcile: a renamed ad group is followed by id, not orphaned and replaced', () => {
	// The live failure: the plan regenerated its naming scheme, every existing ad
	// group stopped matching by name, so sync created 15 new ones and paused the
	// one that had produced 270 impressions.
	const p = synced();
	p.adGroups[0].name = 'EX · oil change reminder';
	const r = reconcile({ planned: [p], live: [live()] });
	const group = r.actions.find((a) => a.level === 'adGroup');
	assert.equal(group.op, 'update', 'the id says it is the same object');
	assert.equal(group.id, '200');
	assert.deepEqual(group.changes, [{ field: 'name', from: 'EX · maintenance intent · US', to: 'EX · oil change reminder' }]);
	assert.deepEqual(r.destructive, [], 'and nothing is paused');
	assert.deepEqual(r.unplanned, []);
});

test('reconcile: a delivering ad group absent from the plan is reported, never paused', () => {
	const account = live();
	account.adGroups.push({
		...normaliseAdGroup({ id: 201, name: 'EX · legacy intent', status: 'ENABLED', defaultBidAmount: { amount: '0.75' } }),
		keywords: [],
	});

	const refuse = reconcile({ planned: [synced()], live: [account] });
	assert.deepEqual(refuse.destructive, [], 'no --prune, no destruction');
	assert.equal(refuse.unplanned.length, 1);
	assert.equal(refuse.unplanned[0].name, 'EX · legacy intent');
	assert.equal(refuse.unplanned[0].id, '201');

	const pruned = reconcile({ planned: [synced()], live: [account], prune: true });
	assert.equal(pruned.destructive.length, 1);
	assert.equal(pruned.destructive[0].op, 'pause');
	assert.equal(pruned.destructive[0].id, '201');
	assert.deepEqual(pruned.destructive[0].changes, [{ field: 'status', from: 'ENABLED', to: 'PAUSED' }]);
});

test('reconcile: an already paused live object is not proposed for pausing again', () => {
	const account = live();
	account.adGroups.push({
		...normaliseAdGroup({ id: 202, name: 'EX · retired', status: 'PAUSED', defaultBidAmount: { amount: '0.75' } }),
		keywords: [],
	});
	assert.deepEqual(reconcile({ planned: [synced()], live: [account], prune: true }).destructive, []);
});

test('reconcile: a manual bid raise survives a re-sync of an unchanged plan', () => {
	// A human raised the bid to clear the auction. The plan still says what it said
	// last time it was pushed, so the account is right and the plan is stale.
	const account = live();
	account.adGroups[0].defaultBidAmount = 1.1;
	const r = reconcile({ planned: [synced()], live: [account] });
	const group = r.actions.find((a) => a.level === 'adGroup');
	assert.equal(group.op, 'preserve');
	assert.deepEqual(group.drift, [{ field: 'defaultBidAmount', from: 0.75, to: 1.1 }]);
	assert.deepEqual(r.mutations, [], 'the manual fix is not reverted');
	assert.equal(r.preserved.length, 1);
});

test('reconcile: a plan change on top of a manual change refuses and names the object', () => {
	const account = live();
	account.adGroups[0].defaultBidAmount = 1.1; // human
	const p = synced();
	p.adGroups[0].defaultBidAmount = 0.9; // plan

	const refuse = reconcile({ planned: [p], live: [account] });
	assert.equal(refuse.conflicts.length, 1);
	assert.equal(refuse.conflicts[0].path, 'Wrenchy · Exact · US / EX · maintenance intent · US');
	assert.deepEqual(refuse.conflicts[0].drift, [{ field: 'defaultBidAmount', from: 0.75, to: 1.1 }]);
	// A conflict is not a mutation: `sync` throws on `conflicts` before issuing any
	// of them, so the divergent object is named and the account is untouched.
	assert.deepEqual(refuse.mutations, []);

	// --force: the plan wins, explicitly.
	const forced = reconcile({ planned: [p], live: [account], force: true });
	assert.deepEqual(forced.conflicts, []);
	assert.equal(forced.actions.find((a) => a.level === 'adGroup').op, 'update');

	// --adopt: the account wins, and the live values come back for the plan file.
	const adopted = reconcile({ planned: [p], live: [account], adopt: true });
	assert.deepEqual(adopted.conflicts, []);
	const g = adopted.actions.find((a) => a.level === 'adGroup');
	assert.equal(g.op, 'adopt');
	assert.equal(g.adoptFields.defaultBidAmount, 1.1);
});

test('reconcile: first-time adoption matches by name and refuses to overwrite live values', () => {
	// A plan with no ids at all — every artifact written before ids were recorded.
	const p = planned();
	p.adGroups[0].defaultBidAmount = 0.3;
	p.adGroups[0].keywords[0].bid = 0.3;

	const r = reconcile({ planned: [p], live: [live()] });
	assert.equal(r.actions.find((a) => a.level === 'campaign').op, 'adopt', 'identical campaign is simply adopted');
	const group = r.actions.find((a) => a.level === 'adGroup');
	assert.equal(group.op, 'conflict', 'a $0.75 live bid is not silently cut to $0.30');
	assert.equal(group.id, '200', 'but the id is found by name, so adoption is possible');
	assert.match(group.detail, /before ship managed it/);

	assert.equal(reconcile({ planned: [p], live: [live()], adopt: true }).actions.find((a) => a.level === 'adGroup').op, 'adopt');
	assert.equal(reconcile({ planned: [p], live: [live()], force: true }).actions.find((a) => a.level === 'adGroup').op, 'update');
});

test('reconcile: an id Apple no longer has is recreated, not silently skipped', () => {
	const r = reconcile({ planned: [synced()], live: [] });
	const cp = r.actions.find((a) => a.level === 'campaign');
	assert.equal(cp.op, 'orphan');
	assert.match(cp.detail, /gone from Apple/);
	assert.equal(r.mutations.length, 3, 'the ad group and its keyword are recreated with the campaign');
});

test('reconcile: campaigns ship does not manage are reported and never touched', () => {
	const other = normaliseCampaign({ id: 999, name: 'Somebody else · Brand', status: 'ENABLED' });
	const r = reconcile({ planned: [synced()], live: [live(), other], prune: true });
	assert.deepEqual(r.unmanaged, [{ id: '999', name: 'Somebody else · Brand', status: 'ENABLED' }]);
	assert.deepEqual(r.destructive, [], 'prune stays inside the campaigns the plan owns');
});

test('reconcile: a missing keyword is created and a re-bid keyword is updated by id', () => {
	const p = synced();
	p.adGroups[0].keywords.push({ text: 'service log app', matchType: 'EXACT', bid: 0.66 });
	p.adGroups[0].keywords[0].bid = 0.9;
	p.adGroups[0].keywords[0].apple.bidAmount = 0.75;

	const r = reconcile({ planned: [p], live: [live()] });
	const kw = r.actions.filter((a) => a.level === 'keyword');
	assert.equal(kw[0].op, 'update');
	assert.equal(kw[0].id, '300');
	assert.deepEqual(kw[0].changes, [{ field: 'bidAmount', from: 0.75, to: 0.9 }]);
	assert.equal(kw[1].op, 'create');
	assert.equal(kw[1].id, null);
});

test('lastModified finds the newest change anywhere in an observed account', () => {
	const account = {
		campaigns: [
			{
				modificationTime: '2026-08-20T00:00:00Z',
				adGroups: [{ modificationTime: '2026-08-23T12:00:00Z', keywords: [{ modificationTime: '2026-08-21T00:00:00Z' }] }],
				negativeKeywords: [],
			},
		],
	};
	assert.equal(new Date(lastModified(account)).toISOString(), '2026-08-23T12:00:00.000Z');
	assert.equal(lastModified({ campaigns: [] }), null);
});

test('parseAppleTime reads Apple\'s zoneless timestamps as UTC, not as local time', () => {
	// The live shape, verbatim. Parsed as local on a UTC-7 host this reads seven
	// hours in the future, which made `sync` refuse a plan written minutes earlier.
	assert.equal(new Date(parseAppleTime('2026-08-23T23:23:09.562')).toISOString(), '2026-08-23T23:23:09.562Z');
	assert.equal(new Date(parseAppleTime('2026-08-23T23:23:09.562Z')).toISOString(), '2026-08-23T23:23:09.562Z');
	assert.equal(new Date(parseAppleTime('2026-08-23T16:23:09.562-07:00')).toISOString(), '2026-08-23T23:23:09.562Z');
	assert.equal(parseAppleTime(null), null);
	assert.equal(parseAppleTime('not a date'), null);
});

// ─── defect 2: bids ──────────────────────────────────────────────────────────

test('resolveBidding: provenance is part of the answer', () => {
	assert.equal(resolveBidding().source, 'default seed');
	assert.equal(resolveBidding({ seedBid: 0.5 }).source, 'ads.seedBid');
	assert.equal(resolveBidding({ seedBid: 0.5, observedCpt: 0.53 }).source, 'realised CPT');
	assert.equal(resolveBidding({ seedBid: 0.5, observedCpt: 0.53, bid: 2.5 }).source, '--bid');
	// An explicit bid above the default ceiling is honoured, not quietly halved.
	assert.equal(resolveBidding({ bid: 2.5 }).max, 5);
	assert.throws(() => resolveBidding({ minBid: 0.2 }), /minimum/);
	assert.throws(() => resolveBidding({ minBid: 1.9, maxBid: 1 }), /ceiling/);
});

test('bidFor: demand moves the price and the clamp is visible', () => {
	const b = resolveBidding({ bid: 1 });
	assert.equal(bidFor(0, b).amount, 0.75);
	assert.equal(bidFor(100, b).amount, 1.25);
	assert.equal(bidFor(50, b).clamped, false);
	const tight = resolveBidding({ bid: 1, minBid: 1.5, maxBid: 1.5 });
	assert.equal(bidFor(50, tight).clamped, true);
	assert.doesNotThrow(() => assertBidSpread([bidFor(0, b), bidFor(100, b)], b));
	assert.throws(() => assertBidSpread([bidFor(0, tight), bidFor(100, tight)], tight), /clamped/);
});

// ─── defect 3: the kill rule ─────────────────────────────────────────────────

test('tapsForConfidence: the sample size at which zero installs is a verdict', () => {
	assert.equal(tapsForConfidence(0.4, 0.95), 6);
	assert.equal(tapsForConfidence(0.2, 0.95), 14);
	assert.equal(tapsForConfidence(0.4, 0.99), 10);
	// 3 taps at a 40% rate leaves a 21.6% chance of a false verdict, which is why
	// $1.40 of spend alone was never enough.
	assert.ok(0.6 ** 3 > 0.05);
});

test('resolveKillRule: one object carries the threshold, the sample size and its source', () => {
	const rule = resolveKillRule({ targetCpi: 0.7, subPrice: 2.99, source: 'ads.targetCpi' });
	assert.equal(rule.wasteThreshold, 1.4);
	assert.equal(rule.minTaps, 6);
	assert.equal(rule.breakeven, 2.99);
	assert.match(rule.condition, /taps >= 6/);
	assert.equal(resolveKillRule({ targetCpi: 3, subPrice: 2.99, retentionMonths: 3 }).breakeven, 8.97);
	assert.throws(() => resolveKillRule({ subPrice: 2.99 }), /target CPI/);
});

// ─── defect 4: no economic guardrail on spend ────────────────────────────────

test('monetisation: 27 customers, 0 subscriptions and $0 revenue is not a CPI target', () => {
	// The live RevenueCat numbers for project projf0d996da over 28 days.
	const m = monetisation({ customers: 27, trials: 0, subscriptions: 0, revenue: 0, mrr: 0 }, { subPrice: 2.99 });
	assert.equal(m.proven, false);
	assert.equal(m.installToPaid, 0);
	assert.equal(m.ltvPerInstall, 0);
	assert.equal(m.cpiCeiling, null, 'no CPI is profitable against $0 of revenue');
	assert.equal(m.label, 'research cap', 'a cap with no revenue behind it is not a target');
	assert.match(m.verdict, /27 customer\(s\), 0 trial\(s\), 0 subscription\(s\), \$0\.00 revenue/);
});

test('monetisation: with revenue the ceiling is derived from what was measured', () => {
	const m = monetisation({ customers: 100, trials: 20, subscriptions: 10, revenue: 59.8, mrr: 29.9 }, { subPrice: 2.99 });
	assert.equal(m.proven, true);
	assert.equal(m.installToPaid, 0.1);
	assert.equal(m.trialRate, 0.2);
	assert.equal(m.ltvPerInstall, 0.6, 'revenue per customer, observed');
	assert.equal(m.modelledLtv, 0.3, 'and the modelled figure beside it');
	assert.equal(m.cpiCeiling, 0.6);
	assert.equal(m.label, 'target');
});

// ─── defect 7: config coherence ──────────────────────────────────────────────

test('checkAdsConfig: a target CPI above lifetime revenue per subscriber is rejected', () => {
	assert.deepEqual(checkAdsConfig({ targetCpi: 0.7, subPrice: 2.99 }).errors, []);
	const bad = checkAdsConfig({ targetCpi: 4, subPrice: 2.99 });
	assert.equal(bad.errors.length, 1);
	assert.match(bad.errors[0], /exceeds \$2\.99/);
	// Stating the payback period is what makes a longer one legal.
	assert.deepEqual(checkAdsConfig({ targetCpi: 4, subPrice: 2.99, retentionMonths: 3 }).errors, []);
	assert.equal(checkAdsConfig({ targetCpi: 2.5, subPrice: 2.99 }).warnings.length, 1, 'over half of LTV warns');
	assert.equal(checkAdsConfig({ targetCpi: 0.7 }).warnings.length, 1, 'a target with no revenue to check it against');
	assert.match(checkAdsConfig({ seedBid: 0.1 }).errors[0], /minimum bid/);
});

test('loadConfig refuses an incoherent ads block at load time, not at spend time', () => {
	const raw = { name: 'Wrenchy', bundleId: 'com.example.wrenchy', ads: { targetCpi: 14.99, subPrice: 2.99 } };
	assert.throws(() => normalise(raw, '/tmp/ship.config.json'), /incoherent "ads" settings/);
	const ok = normalise({ ...raw, ads: { targetCpi: 0.7, subPrice: 2.99 } }, '/tmp/ship.config.json');
	assert.deepEqual(ok.warnings, []);
	assert.equal(ok.ads.retentionMonths, 1, 'defaults are explicit, not implied');
	assert.equal(ok.ads.baselineInstallRate, 0.4);
	assert.equal(BID.floor, 0.3);
});
