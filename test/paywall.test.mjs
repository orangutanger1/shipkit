// The post-install funnel. Everything here is pure: the thresholds are contested
// business rules, so the tests are where the argument is settled, and none of
// them may touch the network or the filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSION, ONBOARDING, conversionTier, onboardingFunnel } from '../src/lib/paywall.mjs';
import { parseFunnelExport } from '../src/commands/analytics.mjs';

const step = (name, users, kind) => ({ name, users, kind });

/** A healthy 12-screen onboarding: 80% reach the paywall, no single step bleeds. */
const healthy = () => {
	const steps = [];
	let users = 1000;
	for (let i = 1; i <= 12; i += 1) {
		steps.push(step(i <= 3 ? `quiz ${i}` : `screen ${i}`, users));
		users -= 18;
	}
	steps.push(step('paywall', 800, 'paywall'));
	return steps;
};

const levels = (f) => f.findings.filter((x) => x.level === 'fail' || x.level === 'warn');
const finding = (f, name) => f.findings.find((x) => x.name === name);

test('a 12-screen onboarding with 80% reach passes every gate', () => {
	const f = onboardingFunnel(healthy());
	assert.equal(f.entered, 1000);
	assert.equal(f.screens, 12, 'the paywall is not one of the onboarding screens');
	assert.equal(f.quizScreens, 3);
	assert.ok(f.reach >= ONBOARDING.paywallReach);
	assert.deepEqual(levels(f), [], JSON.stringify(f.findings));
	assert.equal(f.healthy, true);
});

test('reach below 75% is a hard failure, and the number is in the detail', () => {
	const f = onboardingFunnel([step('welcome', 1000), step('quiz 1', 700), step('paywall', 600, 'paywall')]);
	const row = finding(f, 'paywall reach');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /60\.0%/);
	assert.equal(f.healthy, false);
});

test('a funnel with no paywall step fails rather than reporting 0% reach as a paywall problem', () => {
	const f = onboardingFunnel([step('welcome', 1000), step('quiz 1', 900)]);
	assert.equal(finding(f, 'paywall step').level, 'fail');
	assert.equal(finding(f, 'paywall reach'), undefined);
	assert.equal(f.screens, 2, 'with no paywall every step is an onboarding screen');
});

test('the worst step is the biggest single drop before the paywall, never the paywall itself', () => {
	const f = onboardingFunnel([
		step('welcome', 1000),
		step('signup', 500), // the screen to cut
		step('quiz 1', 480),
		step('paywall', 100, 'paywall'), // a bigger drop, but not an onboarding problem
	]);
	assert.equal(f.worst.name, 'signup');
	assert.equal(finding(f, 'worst step').level, 'warn');
});

test('the screen band warns in both directions and never fails', () => {
	const short = onboardingFunnel([step('welcome', 1000), step('paywall', 990, 'paywall')]);
	assert.equal(finding(short, 'screens').level, 'warn');
	assert.match(finding(short, 'screens').detail, /under 10/);

	const long = [];
	for (let i = 1; i <= 20; i += 1) long.push(step(`screen ${i}`, 1000));
	long.push(step('paywall', 1000, 'paywall'));
	const f = onboardingFunnel(long);
	assert.equal(finding(f, 'screens').level, 'warn');
	// 20 screens that lose nobody is a strategy, not a bug: reach still passes.
	assert.equal(finding(f, 'paywall reach').level, 'ok');
	assert.equal(f.findings.some((x) => x.level === 'fail'), false);
});

test('a quiz longer than four screens is a finding, and roles are inferred from names', () => {
	const steps = [step('welcome', 1000)];
	for (let i = 1; i <= 6; i += 1) steps.push(step(`question ${i}`, 1000));
	for (let i = 1; i <= 5; i += 1) steps.push(step(`value ${i}`, 1000));
	steps.push(step('paywall', 1000));
	const f = onboardingFunnel(steps);
	assert.equal(f.quizScreens, 6, 'inferred from the step name, with no kind given');
	assert.equal(finding(f, 'quiz').level, 'warn');
	assert.equal(f.reach, 1, 'a step named paywall terminates the funnel without an explicit kind');
});

test('a non-monotonic export is reported as a broken export, not smoothed', () => {
	const f = onboardingFunnel([step('welcome', 100), step('quiz 1', 400), step('paywall', 400, 'paywall')]);
	assert.equal(finding(f, 'export').level, 'fail');
});

test('a first step with zero users never divides by zero', () => {
	// entered=0 makes every downstream rate() call's denominator 0; the
	// division-by-zero guard, not NaN, is what has to answer here.
	const f = onboardingFunnel([step('welcome', 0), step('paywall', 0, 'paywall')]);
	assert.equal(f.entered, 0);
	assert.equal(f.steps[0].dropRate, 0);
	assert.equal(f.reach, 0);
});

test('steps keyed by "step" or "event" instead of "name" still resolve a name, a role and a user count', () => {
	const f = onboardingFunnel([
		{ step: 'welcome', count: 1000 }, // name and users both fall back off "step"/"count"
		{ event: 'question about goals', value: 900 }, // and off "event"/"value"
		{}, // nothing at all: the positional fallback name, and role "screen"
		step('paywall', 800, 'paywall'),
	]);
	assert.equal(f.steps[0].name, 'welcome');
	assert.equal(f.steps[0].users, 1000);
	assert.equal(f.steps[1].name, 'question about goals');
	assert.equal(f.steps[1].users, 900);
	assert.equal(f.steps[1].role, 'quiz', 'inferred from the event name with no explicit kind');
	assert.equal(f.steps[2].name, 'step 3');
	assert.equal(f.steps[2].role, 'screen');
});

test('an empty or absent funnel is an instrumentation failure, never NaN', () => {
	for (const input of [[], undefined, null]) {
		const f = onboardingFunnel(input);
		assert.equal(finding(f, 'instrumentation').level, 'fail');
		assert.ok(Number.isFinite(f.reach) && f.reach === 0);
		assert.equal(f.entered, 0);
	}
});

test('conversion tiers break exactly at the floor, healthy and excellent edges', () => {
	assert.equal(conversionTier(0).tier, 'dead');
	assert.equal(conversionTier(CONVERSION.floor - 0.001).tier, 'below');
	assert.equal(conversionTier(CONVERSION.floor).tier, 'floor');
	assert.equal(conversionTier(CONVERSION.healthy).tier, 'healthy');
	assert.equal(conversionTier(CONVERSION.excellent).tier, 'excellent');
	// The floor is where paid acquisition starts breaking even, not where the app is fine.
	assert.equal(conversionTier(CONVERSION.floor).healthy, false);
	assert.equal(conversionTier(CONVERSION.healthy).healthy, true);
});

test('a dead paywall points at the wiring gate before the copy', () => {
	assert.match(conversionTier(0).fix, /rc audit/);
	assert.match(conversionTier(0.01).fix, /onboarding/);
});

test('every tier is finite for junk input', () => {
	for (const v of [undefined, null, NaN, -1, 'abc']) {
		const t = conversionTier(v);
		assert.ok(Number.isFinite(t.rate) && t.rate >= 0, String(v));
	}
});

test('a PostHog CSV funnel export parses into ordered steps', () => {
	const csv = 'Step,Users,Conversion rate\nwelcome,1000,100%\nquiz 1,900,90%\npaywall,800,80%\n';
	assert.deepEqual(parseFunnelExport(csv), [
		{ name: 'welcome', users: 1000, kind: undefined },
		{ name: 'quiz 1', users: 900, kind: undefined },
		{ name: 'paywall', users: 800, kind: undefined },
	]);
});

test('an explicit order column wins over row order', () => {
	const doc = JSON.stringify({
		result: [
			{ name: 'paywall', count: 800, order: 3 },
			{ name: 'welcome', count: 1000, order: 1 },
			{ name: 'quiz 1', count: 900, order: 2 },
		],
	});
	assert.deepEqual(parseFunnelExport(doc).map((s) => s.name), ['welcome', 'quiz 1', 'paywall']);
});

test('a bare JSON array with no order keeps its own order', () => {
	const doc = JSON.stringify([{ name: 'a', users: 3 }, { name: 'b', users: 2 }, { name: 'c', users: 1 }]);
	assert.deepEqual(parseFunnelExport(doc).map((s) => s.name), ['a', 'b', 'c']);
});

test('counts survive the thousands separators every exporter emits', () => {
	const csv = 'name,users\nwelcome,"12,400"\npaywall,"9,900"\n';
	assert.deepEqual(parseFunnelExport(csv).map((s) => s.users), [12_400, 9900]);
});

test('an empty export is empty, and unparseable JSON is a named failure', () => {
	assert.deepEqual(parseFunnelExport(''), []);
	assert.deepEqual(parseFunnelExport(undefined), []);
	assert.throws(() => parseFunnelExport('{"nope":1}'), /funnel array/);
});
