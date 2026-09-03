// The design gates. Every check here is arithmetic the agent is not allowed to
// perform by eye, so each test names the rule and proves the gate bites.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contrast, hueDistance, hueOf, luminance, parseHex } from '../src/lib/color.mjs';
import {
	CONTRAST_PAIRS,
	MAX_DURATION_MS,
	MIN_CONTRAST,
	MIN_CONTRAST_LARGE,
	checkAccent,
	checkCitations,
	checkContrast,
	checkMotion,
	checkSpacing,
	checkSystem,
	checkType,
	citations,
} from '../src/lib/design-system.mjs';
import { checkComponents, checkEvents, checkFlows, checkScreens, checkSpec } from '../src/lib/design-spec.mjs';
import { reviewSources, scanLine, systemColors, systemNumbers, tally } from '../src/lib/design-review.mjs';
import { PLATFORM_RAMP, draftSpec, draftSystem, routeFor } from '../src/lib/design-draft.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { ARTIFACTS, clone } from './fixtures/artifacts.mjs';

const system = () => clone(ARTIFACTS['design-system']);
const spec = () => clone(ARTIFACTS['ux-spec']);

test('contrast is WCAG, to the second decimal', () => {
	assert.equal(contrast('#ffffff', '#000000'), 21);
	assert.equal(contrast('#000000', '#ffffff'), 21, 'order does not change a ratio');
	assert.equal(contrast('#777777', '#ffffff'), 4.48, 'the classic just-fails grey');
	assert.equal(contrast('#ffffff', 'rebeccapurple'), null, 'a name is not a hex');
	assert.equal(luminance({ r: 255, g: 255, b: 255 }), 1);
	assert.equal(luminance({ r: 0, g: 0, b: 0 }), 0);
});

test('hex parsing takes both lengths and refuses everything else', () => {
	assert.deepEqual(parseHex('#abc'), { r: 170, g: 187, b: 204 });
	assert.deepEqual(parseHex('#AABBCC'), { r: 170, g: 187, b: 204 });
	assert.equal(parseHex('#abcd'), null);
	assert.equal(parseHex(undefined), null);
});

test('a grey has no hue, so it cannot satisfy an accent', () => {
	assert.equal(hueOf('#ff0000'), 0);
	assert.equal(hueOf('#00ff00'), 120);
	assert.equal(hueOf('#0000ff'), 240);
	assert.equal(hueOf('#808080'), null);
	assert.equal(hueOf('nope'), null);
	assert.equal(hueDistance(350, 10), 20, 'the hue circle wraps');
	assert.equal(hueDistance(-10, 10), 20, 'so do negative inputs');
});

test('the worked fixture passes every token check', () => {
	assert.deepEqual(checkSystem(system()), []);
});

test('a draft is refused before anything else is measured', () => {
	assert.deepEqual(checkSystem({ _todo: ['color'] }), [
		'system.json is still a draft — fill color and drop _todo',
	]);
	assert.deepEqual(checkSpec({ _todo: ['flows[].success'] }), [
		'ux.json is still a draft — fill flows[].success and drop _todo',
	]);
});

test('citations are collected with the path they came from', () => {
	const found = citations({ radii: { md: { value: 12, cite: 'HIG:layout' } }, _note: { cite: 'ignored' } });
	assert.deepEqual(found, [{ at: 'radii.md', cite: 'HIG:layout' }]);
});

test('a token citing a reference the research run does not hold is refused', async () => {
	const doc = system();
	doc.radii.card.cite = 'ref_deadbeef';
	assert.deepEqual(checkCitations(doc, new Set(['ref_cafe'])), [
		'radii.card: cites ref_deadbeef, which is not a reference or claim in the research run',
	]);
	assert.deepEqual(checkCitations(doc, new Set(['ref_deadbeef'])), []);
	assert.deepEqual(checkCitations(doc, new Set()), [], 'with no run loaded a citation is unprovable, not wrong');
});

test('a second accent hue is arithmetic, not an opinion', () => {
	const doc = system();
	doc.color.themes.light.surface.value = '#f3e6c0';
	const issues = checkAccent(doc.color);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /light\.surface: hue \d+° is a second accent/);
});

test('the declared accentHue must be the hue the accent swatch is', () => {
	const doc = system();
	doc.color.accentHue = 20;
	assert.ok(checkAccent(doc.color).some((i) => i.includes('from the declared accentHue 20°')));
});

test('an achromatic accent is not an accent', () => {
	const doc = system();
	doc.color.themes.dark.accent.value = '#9a9a9a';
	assert.ok(checkAccent(doc.color).some((i) => i.includes('has no hue')));
});

test('dark mode is checked independently of light', () => {
	const doc = system();
	doc.color.themes.dark.text.value = '#1a2433';
	const issues = checkContrast(doc.color);
	assert.ok(issues.every((i) => i.includes('themes.dark')), 'light must not be implicated');
	assert.ok(issues.some((i) => i.includes('text on background')));
});

test('every contrast pair names a bar of 4.5 or 3', () => {
	assert.ok(CONTRAST_PAIRS.length >= 8);
	assert.equal(MIN_CONTRAST, 4.5, 'WCAG AA for body text');
	assert.equal(MIN_CONTRAST_LARGE, 3, 'and for large text and non-text UI');
	for (const pair of CONTRAST_PAIRS)
		assert.ok(pair.min === MIN_CONTRAST || pair.min === MIN_CONTRAST_LARGE, JSON.stringify(pair));
	assert.ok(!CONTRAST_PAIRS.some((p) => p.fg === 'border'), 'a separator is decorative; gating it fails every real palette');
});

test('a colour that is not a colour is reported once, as itself', () => {
	const doc = system();
	doc.color.themes.light.danger.value = '#12345';
	assert.ok(checkContrast(doc.color).some((i) => i.includes('is not a #rrggbb colour')));
});

test('spacing is one ascending series off one base', () => {
	assert.deepEqual(checkSpacing({ base: 8, scale: [0, 8, 16, 24] }), []);
	assert.deepEqual(checkSpacing({ base: 8, scale: [0, 8, 6, 24] }), [
		'spacing.scale[2]: 6 is not a multiple of the 8pt base',
		'spacing.scale[2]: 6 does not increase on 8',
	]);
	assert.deepEqual(checkSpacing({}), [], 'shape errors belong to the schema, not here');
});

test('a ramp that goes back on itself, or repeats a step, has no order', () => {
	assert.deepEqual(checkType({ ramp: [{ name: 'a', size: 12, lineHeight: 16 }, { name: 'b', size: 17, lineHeight: 22 }] }), []);
	assert.deepEqual(
		checkType({ ramp: [{ name: 'headline', size: 17, weight: 600 }, { name: 'body', size: 17, weight: 400 }] }),
		[],
		'Apple separates headline from body by weight at one size',
	);
	assert.ok(checkType({ ramp: [{ name: 'a', size: 17, weight: 400 }, { name: 'b', size: 17, weight: 400 }] })
		.some((i) => i.includes('two names for one step')));
	assert.ok(checkType({ ramp: [{ name: 'a', size: 12 }, { name: 'b', size: 17 }, { name: 'c', size: 15 }] })
		.some((i) => i.includes('not monotonic')));
	assert.ok(checkType({ ramp: [{ name: 'a', size: 17, lineHeight: 12 }] })
		.some((i) => i.includes('lineHeight 12 is under its size 17')));
	assert.ok(checkType({ ramp: [{ name: 'a', size: 12 }, { name: 'a', size: 17 }] })
		.some((i) => i.includes('duplicate step name')));
	assert.deepEqual(checkType({}), []);
});

test('motion over the bar reads as slow, and reducedMotion is required', () => {
	const ok = { durations: { base: { value: MAX_DURATION_MS } }, reducedMotion: 'Cross-fade.' };
	assert.deepEqual(checkMotion(ok), []);
	assert.ok(checkMotion({ durations: { slow: { value: 900 } }, reducedMotion: 'x' })[0].includes('900ms is over'));
	assert.ok(checkMotion({ durations: {} })[0].includes('reducedMotion'));
	assert.ok(checkMotion({ durations: {}, reducedMotion: '   ' })[0].includes('reducedMotion'), 'whitespace is not an answer');
});

test('the worked ux fixture passes every spec check', () => {
	assert.deepEqual(checkSpec(spec()), []);
});

test('two screens on one route means one is never captured', () => {
	const doc = spec();
	doc.screens.push({ ...doc.screens[0], id: 'paywall2' });
	doc.flows[0].screens.push('paywall2');
	assert.ok(checkScreens(doc).some((i) => i.includes('route /paywall is already screen "paywall"')));
});

test('duplicate screen ids and missing copy are both refused', () => {
	const doc = spec();
	doc.screens.push({ ...doc.screens[0], route: '/two', copy: {} });
	doc.flows[0].screens.push('paywall');
	const issues = checkScreens(doc);
	assert.ok(issues.some((i) => i.includes('duplicate screen id')));
	assert.ok(issues.some((i) => i.includes('no copy')));
});

test('a paywall screen with no monetization block has nothing to audit', () => {
	const doc = spec();
	delete doc.screens[0].monetization;
	assert.ok(checkScreens(doc).some((i) => i.includes('no monetization block')));
});

test('an event name is derived from flow and verb, never typed', () => {
	const doc = spec();
	doc.screens[0].events[0].name = 'paywallViewed';
	assert.deepEqual(checkEvents(doc), [
		'screen "paywall": event "paywallViewed" should be "paywall_viewed" — the name is derived from flow and verb, not written',
	]);
	doc.screens[0].events[0].flow = 'not-a-flow';
	assert.deepEqual(checkEvents(doc), [], 'an unknown flow is the schema’s error, not this one');
});

test('a flow naming a screen that does not exist, and a screen in no flow', () => {
	const doc = spec();
	doc.flows[0].screens = ['ghost'];
	const issues = checkFlows(doc);
	assert.ok(issues.some((i) => i.includes('names screen "ghost"')));
	assert.ok(issues.some((i) => i.includes('screen "paywall": in no flow')));
});

test('a flow needs a success condition and a unique id', () => {
	const doc = spec();
	doc.flows.push({ id: 'paywall', screens: ['paywall'], success: '' });
	const issues = checkFlows(doc);
	assert.ok(issues.some((i) => i.includes('duplicate flow id')));
	assert.ok(issues.some((i) => i.includes('no success condition')));
});

test('components are checked only when components.json exists', () => {
	const doc = spec();
	assert.deepEqual(checkComponents(doc, new Set()), [], 'an unbuilt component map is a gap, not a contradiction');
	assert.deepEqual(checkComponents(doc, new Set(['plan-picker'])), []);
	assert.deepEqual(checkComponents(doc, new Set(['other'])), [
		'screen "paywall": component "plan-picker" is not in components.json',
	]);
});

test('the review scanner reads the system, not a hardcoded palette', () => {
	const doc = system();
	assert.ok(systemColors(doc).has('#0a58ca'));
	const nums = systemNumbers(doc);
	assert.deepEqual([...nums.radii], [12]);
	assert.deepEqual([...nums.durations], [250]);
	assert.ok(nums.sizes.has(17));
	assert.ok(nums.spacing.has(24));
	assert.deepEqual(systemColors({}).size, 0);
});

test('every anti-slop rule fires on the line that breaks it', () => {
	const sys = { colors: systemColors(system()), nums: systemNumbers(system()) };
	const at = { file: 'App.tsx', line: 1 };
	const kinds = (line) => scanLine(line, at, sys).map((v) => v.kind);
	assert.deepEqual(kinds('color: "#ff0000"'), ['color']);
	assert.deepEqual(kinds('color: "#0a58ca"'), [], 'a colour from the system is not a violation');
	assert.deepEqual(kinds('borderRadius: 14'), ['radius']);
	assert.deepEqual(kinds('borderRadius: 12'), []);
	assert.deepEqual(kinds('paddingHorizontal: 6'), ['spacing']);
	assert.deepEqual(kinds('paddingHorizontal: 24'), []);
	assert.deepEqual(kinds('fontSize: 15'), ['type']);
	assert.deepEqual(kinds('duration: 800'), ['motion']);
	assert.deepEqual(kinds('<Text>Done 🎉</Text>'), ['emoji']);
	assert.deepEqual(kinds('<Text>Done ✅</Text>'), ['emoji'], 'a dingbat reads as emoji too');
	assert.deepEqual(kinds('<LinearGradient colors={a} />'), ['gradient']);
});

test('review reports every occurrence on a line, with its file and line number', () => {
	const violations = reviewSources(
		[{ path: 'src/App.tsx', source: 'const a = 1;\nconst c = ["#ff0000", "#00ff00"];' }],
		system(),
	);
	assert.equal(violations.length, 2);
	assert.deepEqual(violations.map((v) => v.line), [2, 2]);
	assert.equal(violations[0].file, 'src/App.tsx');
	assert.deepEqual(tally(violations), { color: 2 });
	assert.deepEqual(tally([]), {});
});

test('the token file is the one place a literal is allowed to be', () => {
	const files = [{ path: 'src/theme.ts', source: 'export const bg = "#ff0000";' }];
	assert.equal(reviewSources(files, system()).length, 1);
	assert.deepEqual(reviewSources(files, system(), { tokens: new Set(['src/theme.ts']) }), []);
});

test('the system draft is the platform ramp plus a loud hole where colour goes', async () => {
	const draft = draftSystem({ name: 'Demo', now: '2026-09-02T00:00:00Z' });
	assert.deepEqual(draft._todo, ['color', 'brand.direction']);
	assert.equal(draft.color, undefined, 'an invented hue is worse than a missing one');
	assert.deepEqual(draft.type.ramp.map((s) => s.name), PLATFORM_RAMP.map((s) => s.name));
	assert.ok(draft.type.ramp.every((s) => s.cite === 'HIG:typography'));
	assert.deepEqual(checkSpacing(draft.spacing), []);
	assert.deepEqual(checkType(draft.type), []);
	assert.deepEqual(checkMotion(draft.motion), []);
	assert.ok((await checkArtifact('design-system', draft, 'system.json')).some((i) => i.includes('color')),
		'the draft fails its own schema until the colour is chosen — that is the gate');
});

test('the spec draft lays out one screen per researched flow, with derived events', async () => {
	const draft = draftSpec({ flows: ['welcome', 'home', 'paywall'], now: '2026-09-02T00:00:00Z' });
	assert.deepEqual(draft.screens.map((s) => s.route), ['/welcome', '/', '/paywall']);
	assert.deepEqual(checkEvents(draft), [], 'drafted event names already satisfy the gate');
	assert.deepEqual(draft.screens[2].events.map((e) => e.name), ['paywall_viewed', 'paywall_completed']);
	assert.ok(draft.screens[1].states.includes('empty'), 'the empty state is the first screen most users see');
	assert.deepEqual(await checkArtifact('ux-spec', draft, 'ux.json'), [], 'a draft spec is schema-valid but gate-incomplete');
	assert.ok(checkSpec(draft)[0].includes('still a draft'));
	assert.equal(routeFor('home'), '/');
});
