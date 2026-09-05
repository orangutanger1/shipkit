// The shape of the ladder, as opposed to the numbers in it. Every row pinned
// here has a price attached: no yearly means MRR that never compounds, a yearly
// above $49.99 buys EU refunds under the 14-day right of withdrawal, a trial on
// the weekly cannibalises the yearly it was supposed to qualify for, and a
// win-back offering marked current serves the save offer as the paywall — the
// one mistake that discounts every new subscriber. `ship price audit` consumes
// these rows verbatim, so the thresholds are argued about here and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLadder, normalisePeriod } from '../src/lib/paywall.mjs';

const rowOf = (rows, name) => {
	const found = rows.find((r) => r.name === name);
	assert.ok(found, `no "${name}" row in ${rows.map((r) => r.name).join(', ')}`);
	return found;
};
const loud = (rows) => rows.filter((r) => r.level === 'fail' || r.level === 'warn');

/** The reference shape: yearly with the trial, weekly without, save offer parked. */
const HEALTHY = {
	subscriptions: [
		{ name: 'Pro Yearly', period: 'P1Y', priceUsd: 49.99, trialDays: 7 },
		{ name: 'Pro Weekly', period: 'P1W', priceUsd: 7.99, trialDays: 0 },
	],
	offerings: [
		{ lookup_key: 'default', is_current: true },
		{ lookup_key: 'winback_annual', is_current: false },
	],
};

// ─── auditLadder ─────────────────────────────────────────────────────────────

test('the reference ladder produces nothing to fix', () => {
	const rows = auditLadder(HEALTHY);
	assert.deepEqual(loud(rows), [], 'the shape the thresholds were written from must be clean');
	assert.equal(rowOf(rows, 'annual tier').level, 'ok');
	assert.equal(rowOf(rows, 'retention offer').level, 'ok');
});

test('no yearly tier is a failure, not a warning', () => {
	const rows = auditLadder({
		subscriptions: [{ name: 'Pro Weekly', period: 'P1W', priceUsd: 7.99 }],
		offerings: HEALTHY.offerings,
	});
	const row = rowOf(rows, 'annual tier');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /yearly/i);
});

test('a yearly above the ceiling warns and says why', () => {
	const rows = auditLadder({
		...HEALTHY,
		subscriptions: [{ name: 'Pro Yearly', period: 'P1Y', priceUsd: 79.99, trialDays: 7 }, HEALTHY.subscriptions[1]],
	});
	const row = rowOf(rows, 'annual price');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /withdrawal/i);
	assert.match(row.detail, /79\.99/);
});

test('a trial on the weekly warns about the yearly it undercuts', () => {
	const rows = auditLadder({
		...HEALTHY,
		subscriptions: [HEALTHY.subscriptions[0], { name: 'Pro Weekly', period: 'P1W', priceUsd: 7.99, trialDays: 3 }],
	});
	const row = rowOf(rows, 'trial placement');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /3-day trial/);
	assert.match(row.detail, /yearly/i);
});

test('serving the win-back offering as current is a failure', () => {
	const rows = auditLadder({
		...HEALTHY,
		offerings: [{ lookup_key: 'winback_annual', is_current: true }],
	});
	const row = rowOf(rows, 'retention offer');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /current/i);
});

test('a yearly-only ladder is short-tier and trial-less at once, and both get their own finding', () => {
	const rows = auditLadder({
		subscriptions: [{ name: 'Pro Yearly', period: 'P1Y', priceUsd: 49.99, trialDays: 0 }],
		offerings: HEALTHY.offerings,
	});
	const short = rowOf(rows, 'short tier');
	assert.equal(short.level, 'warn');
	assert.match(short.detail, /weekly or monthly/);
	const trial = rowOf(rows, 'trial placement');
	assert.equal(trial.level, 'warn');
	assert.match(trial.detail, /no trial on the yearly/);
});

test('a subscription row missing a name, period or price falls back rather than throwing', () => {
	const rows = auditLadder({
		subscriptions: [
			{ productId: 'com.demo.yearly', period: 'P1Y' }, // no name, no priceUsd
			{}, // nothing at all
		],
		offerings: HEALTHY.offerings,
	});
	// No price on the yearly means the "annual price" ok/warn row has nothing to say either way.
	assert.equal(rowOf(rows, 'annual tier').level, 'ok');
	assert.equal(rows.find((r) => r.name === 'annual price'), undefined);
});

test('an offering with neither lookup_key nor id still resolves to an empty string for the win-back pattern', () => {
	const rows = auditLadder({
		subscriptions: HEALTHY.subscriptions,
		offerings: [{ is_current: true }],
	});
	const row = rowOf(rows, 'retention offer');
	assert.equal(row.level, 'warn', 'an offering identified by neither key cannot match the win-back pattern');
});

test('offerings present but none of them a win-back is a warning, not "unknown"', () => {
	const rows = auditLadder({
		subscriptions: HEALTHY.subscriptions,
		offerings: [{ lookup_key: 'default', is_current: true }],
	});
	const row = rowOf(rows, 'retention offer');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /no win-back offering/);
});

test('offerings we were not given are unknown, not missing', () => {
	const row = rowOf(auditLadder({ subscriptions: HEALTHY.subscriptions }), 'retention offer');
	assert.equal(row.level, 'skip');
});

test('an empty ladder fails on its own, before any other row', () => {
	const rows = auditLadder({});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].level, 'fail');
	assert.equal(rows[0].name, 'ladder');
	assert.match(rows[0].detail, /nothing to price/);
});

// ─── normalisePeriod ─────────────────────────────────────────────────────────

test('normalisePeriod collapses ASC enums and ISO durations onto four periods', () => {
	for (const raw of ['P1Y', 'ONE_YEAR', 'annual', 'YEARLY']) assert.equal(normalisePeriod(raw), 'annual', raw);
	for (const raw of ['P1W', 'ONE_WEEK', 'weekly']) assert.equal(normalisePeriod(raw), 'weekly', raw);
	for (const raw of ['P1M', 'ONE_MONTH']) assert.equal(normalisePeriod(raw), 'monthly', raw);
	// The tiers that exist but price nothing: neither the commitment nor the entry point.
	for (const raw of ['P3M', 'SIX_MONTHS']) assert.equal(normalisePeriod(raw), 'other', raw);
});

test('an unreadable period is null, never a default', () => {
	for (const raw of ['', '   ', 'P4Y', 'lifetime', null, undefined, {}]) assert.equal(normalisePeriod(raw), null);
});
