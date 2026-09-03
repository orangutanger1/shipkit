// The decision table. Two rules carry the whole command and both are asserted
// here: an absent input is `unknown` and never `pass`, and the culprit is the
// *earliest* failing stage, because every later one is measured on users the
// earlier one already lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	HEALTH, diagnose, implicated, measurements, quality, revenueOf, unmeasured, verdictRows, wantsLow,
} from '../src/lib/analytics-diagnose.mjs';
import { flowsIn } from '../src/lib/flows.mjs';

/** A store funnel that clears both listing benchmarks. */
const HEALTHY_STORE = { impressions: 10_000, pageViews: 1200, installs: 500 };
const at = (out, stage) => out.verdicts.find((v) => v.stage === stage);

test('a healthy funnel with everything measured blames nothing', () => {
	const out = diagnose(
		{ ...HEALTHY_STORE, retention: { rate: 0.1 }, sessions: { perDevice: 6 }, crashes: { perDevice: 0.001 } },
		{ reach: 0.9 },
		{ paid: 40, installs: 500 },
	);
	assert.equal(out.culprit, null);
	assert.deepEqual(out.unknown, []);
	assert.equal(out.crash.verdict, 'pass');
});

test('the earliest failing stage is the culprit, not the worst one', () => {
	// Page views are catastrophic and the paywall is merely bad. Sending someone
	// to the paywall would be optimising for users who never arrive.
	const out = diagnose(
		{ impressions: 10_000, pageViews: 100, installs: 40, retention: { rate: 0.1 }, sessions: { perDevice: 6 } },
		{ reach: 0.2 },
		{ paid: 0, installs: 40 },
	);
	assert.equal(out.culprit?.stage, 'impression→pageview');
	assert.equal(at(out, 'install→paywall').verdict, 'fail');
});

test('a crash rate over the bar outranks every funnel stage', () => {
	const out = diagnose(
		{ impressions: 10_000, pageViews: 100, installs: 40, crashes: { perDevice: 0.2 } },
		{ reach: 0.2 },
		{ paid: 0, installs: 40 },
	);
	// The listing still reads as broken; it is a symptom until the crash is gone.
	assert.equal(out.culprit?.stage, 'crash rate');
	assert.equal(at(out, 'impression→pageview').verdict, 'fail');
});

test('an absent report is unknown, never a pass', () => {
	const out = diagnose(HEALTHY_STORE, null, null);
	assert.equal(at(out, 'install→paywall').verdict, 'unknown');
	assert.equal(at(out, 'install→kept').verdict, 'unknown');
	assert.equal(at(out, 'sessions per device').verdict, 'unknown');
	assert.equal(out.crash.verdict, 'unknown');
	assert.equal(out.culprit, null);
	assert.deepEqual(out.unknown.map((v) => v.stage), ['install→paywall', 'install→kept', 'sessions per device', 'install→paid']);
});

test('no paid figure is unknown, but a measured zero is a failure', () => {
	// The distinction the whole module turns on, at the one stage where a real
	// zero is plausible: an app that has genuinely sold nothing.
	assert.equal(at(diagnose(HEALTHY_STORE, null, { paid: null }), 'install→paid').verdict, 'unknown');
	assert.equal(at(diagnose(HEALTHY_STORE, null, { paid: 0, installs: 500 }), 'install→paid').verdict, 'fail');
});

test('every unknown stage names the command that would answer it', () => {
	for (const v of diagnose(null, null, null).unknown) assert.match(v.needs, /^ship /);
	assert.match(quality(null).needs, /^ship /);
});

test('a high deletion rate fails while a low one passes', () => {
	const kept = diagnose({ ...HEALTHY_STORE, retention: { rate: HEALTH.deletionRate - 0.01 } }, null, null);
	const lost = diagnose({ ...HEALTHY_STORE, retention: { rate: HEALTH.deletionRate + 0.01 } }, null, null);
	assert.equal(at(kept, 'install→kept').verdict, 'pass');
	assert.equal(at(lost, 'install→kept').verdict, 'fail');
	assert.equal(lost.culprit?.stage, 'install→kept');
});

test('measurements divides by the right denominator at each stage', () => {
	const m = measurements({ impressions: 1000, pageViews: 100, installs: 25 }, { reach: 0.8 }, { paid: 5, installs: 25 });
	assert.equal(m.view, 0.1);
	// install rate is per page view, not per impression.
	assert.equal(m.install, 0.25);
	assert.equal(m.activation, 0.8);
	assert.equal(m.monetization, 0.2);
});

test('a stage with a zero denominator is unmeasured, not zero', () => {
	// A brand-new app with no impressions has not failed its listing.
	const m = measurements({ impressions: 0, pageViews: 0, installs: 0 }, null, null);
	assert.equal(m.view, null);
	assert.equal(m.install, null);
	assert.equal(diagnose({ impressions: 0, pageViews: 0, installs: 0 }, null, null).culprit, null);
});

test('the culprit names the flows to re-research', () => {
	const out = diagnose({ impressions: 10_000, pageViews: 100, installs: 40 }, null, null);
	const where = implicated(out.culprit, null);
	assert.deepEqual(where.flows, flowsIn('activation'));
	assert.deepEqual(where.screens, []);
});

test('a ux spec turns the flows into the screens that implement them', () => {
	const out = diagnose({ ...HEALTHY_STORE, retention: { rate: 0.9 } }, null, null);
	assert.equal(out.culprit?.group, 'core');
	const ux = {
		screens: [
			{ id: 'home', route: '/', flow: flowsIn('core')[0] },
			{ id: 'paywall', route: '/paywall', flow: flowsIn('monetization')[0] },
		],
	};
	const where = implicated(out.culprit, ux);
	assert.deepEqual(where.screens, [{ id: 'home', route: '/', flow: flowsIn('core')[0] }]);
});

test('implicated answers empty for no culprit', () => {
	assert.deepEqual(implicated(null, { screens: [{ id: 'a', route: '/a', flow: 'welcome' }] }), { flows: [], screens: [] });
});

const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

test('revenueOf keeps an absent paid field absent', () => {
	assert.deepEqual(revenueOf({ installs: 500 }, null, toNumber), { paid: null, installs: 500 });
	assert.deepEqual(revenueOf({ paid: null, installs: 500 }, null, toNumber), { paid: null, installs: 500 });
	assert.deepEqual(revenueOf({ paid: '', installs: 500 }, null, toNumber), { paid: null, installs: 500 });
	assert.deepEqual(revenueOf({ paid: 0, installs: 500 }, null, toNumber), { paid: 0, installs: 500 });
});

test('revenueOf falls back to the funnel for installs', () => {
	assert.deepEqual(revenueOf({ paid: 3 }, { installs: 90 }, toNumber), { paid: 3, installs: 90 });
	assert.deepEqual(revenueOf(null, null, toNumber), { paid: null, installs: 0 });
});

test('the table leads with the crash row', () => {
	const out = diagnose(HEALTHY_STORE, null, null);
	const rows = verdictRows(out);
	assert.equal(rows[0].stage, 'crash rate');
	assert.equal(rows.length, out.verdicts.length + 1);
});

test('deletions and crashes are the two stages where low is healthy', () => {
	const low = verdictRows(diagnose(HEALTHY_STORE, null, null)).filter(wantsLow).map((v) => v.stage);
	assert.deepEqual(low, ['crash rate', 'install→kept']);
});

test('unmeasured names the crash row too, which the verdict list does not carry', () => {
	const out = diagnose(HEALTHY_STORE, null, null);
	const stages = unmeasured(out).map((v) => v.stage);
	assert.ok(stages.includes('crash rate'));
	assert.ok(unmeasured(out).every((v) => v.needs.startsWith('ship ')));
	assert.deepEqual(unmeasured(diagnose(
		{ ...HEALTHY_STORE, retention: { rate: 0.1 }, sessions: { perDevice: 6 }, crashes: { perDevice: 0.001 } },
		{ reach: 0.9 },
		{ paid: 40, installs: 500 },
	)), []);
});
