// The Tier 1 rules, as arithmetic. Every test here names a failure a generated
// app actually ships with — a 32pt tap target, a dark mode that is not wired, an
// "empty" state that renders the populated screen — and proves the gate bites.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cellId, cellUrl, planMatrix, textScale, TYPE_STEPS } from '../src/lib/qa-matrix.mjs';
import { probe } from '../src/lib/qa-probe.mjs';
import {
	CONTRAST_BODY,
	CONTRAST_LARGE,
	TAP_MIN,
	checkContrast,
	checkClipping,
	checkLayout,
	checkObservation,
	checkSafeArea,
	checkTapTargets,
	checkTypeRamp,
	requiredContrast,
} from '../src/lib/qa-checks.mjs';
import {
	TIER2,
	buildReport,
	checkDarkMode,
	checkRegression,
	checkStates,
	mergeTier2,
	summarize,
	tier2Rows,
} from '../src/lib/qa-run.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';

const CELL = { screen: 'paywall', route: '/paywall', flow: 'paywall', state: 'default', theme: 'light', locale: 'en-US', dynamicType: 'default' };
const cell = (over = {}) => ({ ...CELL, ...over });
const text = (over = {}) => ({ label: 'Keep going', size: 17, weight: 400, fg: '#0d1b2a', bg: '#ffffff', ...over });
const obs = (over = {}) => ({ view: { w: 428, h: 926 }, overflowX: 0, tappables: [{ label: 'cta', w: 200, h: 48, x: 24, y: 400 }], texts: [text()], clipped: [], blank: false, ...over });

// ── matrix ──────────────────────────────────────────────────────────────────

test('a Dynamic Type step is a real iOS point size over the 17pt default', () => {
	assert.equal(textScale('default'), 1);
	assert.equal(textScale('xl'), Math.round((19 / 17) * 100) / 100);
	assert.equal(textScale('ax5'), Math.round((TYPE_STEPS.ax5 / 17) * 100) / 100);
});

test('an unknown Dynamic Type step costs a default-size capture, not an exception', () => {
	assert.equal(textScale('enormous'), 1);
	assert.equal(textScale(undefined), 1);
});

test('the cell url carries every condition the build has to honour', () => {
	const url = new URL(cellUrl('http://localhost:8081/', cell({ theme: 'dark', state: 'empty', dynamicType: 'xl' })));
	assert.equal(url.pathname, '/paywall');
	assert.equal(url.searchParams.get('qaTheme'), 'dark');
	assert.equal(url.searchParams.get('qaState'), 'empty');
	assert.equal(url.searchParams.get('qaLocale'), 'en-US');
	assert.equal(url.searchParams.get('qaTextScale'), '1.12');
});

test('a cell id is a slug, so it is also a filename and a check id', () => {
	assert.equal(cellId(cell({ locale: 'de-DE', dynamicType: 'xl' })), 'paywall-default-light-de-de-xl');
	assert.match(cellId(cell()), /^[a-z][a-z0-9-]*$/);
});

test('the matrix varies appearance over the default state and states over one appearance', () => {
	const spec = { screens: [{ id: 'home', route: '/', flow: 'home', states: ['default', 'empty', 'error'] }] };
	const cells = planMatrix(spec, { themes: ['light', 'dark'], locales: ['en-US'], dynamicType: ['default', 'xl'] });
	// 2 themes x 1 locale x 2 steps for `default`, then one cell per other state.
	assert.equal(cells.length, 6);
	assert.equal(cells.filter((c) => c.state === 'default').length, 4);
	for (const c of cells.filter((c) => c.state !== 'default'))
		assert.deepEqual([c.theme, c.dynamicType], ['light', 'default'], 'a state is captured once, not across the appearance matrix');
});

test('an empty spec plans no captures rather than throwing', () => {
	assert.deepEqual(planMatrix(null), []);
	assert.deepEqual(planMatrix({ screens: [] }, {}), []);
});

// ── probe ───────────────────────────────────────────────────────────────────

/** A DOM small enough to reason about, big enough to drive every branch of `probe`. */
function dom(nodes, { root = {}, bodyBg = 'rgb(255, 255, 255)' } = {}) {
	const style = (el) => ({
		display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto',
		color: 'rgb(13, 27, 42)', backgroundColor: 'rgba(0, 0, 0, 0)',
		fontSize: '17px', fontWeight: '400', ...(el.style ?? {}),
	});
	const build = (spec, parent) => {
		const el = {
			tagName: (spec.tag ?? 'div').toUpperCase(),
			style: spec.style,
			parentElement: parent,
			childNodes: spec.text ? [{ nodeType: 3, nodeValue: spec.text }] : [],
			scrollWidth: spec.scrollWidth ?? 100,
			clientWidth: spec.clientWidth ?? 100,
			getAttribute: (k) => spec.attrs?.[k] ?? null,
			getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50, ...spec.box }),
		};
		return [el, ...(spec.children ?? []).flatMap((child) => build(child, el))];
	};
	const body = { tagName: 'BODY', style: { backgroundColor: bodyBg }, parentElement: null, childNodes: [], getAttribute: () => null, getBoundingClientRect: () => ({ x: 0, y: 0, width: 428, height: 926 }), scrollWidth: 428, clientWidth: 428 };
	const all = nodes.flatMap((spec) => build(spec, body));
	const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
	globalThis.document = {
		documentElement: { clientWidth: 428, clientHeight: 926, scrollWidth: 428, ...root },
		body,
		querySelectorAll: () => all,
	};
	globalThis.getComputedStyle = style;
	return () => Object.assign(globalThis, saved);
}

test('the probe measures text, its backdrop, and every tappable box', () => {
	const restore = dom([
		{ tag: 'div', style: { backgroundColor: 'rgb(255, 255, 255)' }, children: [{ tag: 'span', text: 'Keep going', style: { fontSize: '28px', fontWeight: '700' } }] },
		{ tag: 'button', attrs: { 'aria-label': 'Subscribe' }, box: { width: 200, height: 48, y: 400 } },
	]);
	try {
		const out = probe();
		assert.equal(out.blank, false);
		assert.deepEqual(out.texts, [{ label: 'Keep going', size: 28, weight: 700, fg: '#0d1b2a', bg: '#ffffff' }]);
		assert.deepEqual(out.tappables.map((t) => t.label), ['Subscribe']);
		assert.equal(out.overflowX, 0);
	} finally {
		restore();
	}
});

test('the probe finds the backdrop up the tree, falling back to the body', () => {
	const restore = dom([{ tag: 'div', children: [{ tag: 'span', text: 'hi' }] }], { bodyBg: 'rgb(11, 18, 32)' });
	try {
		assert.equal(probe().texts[0].bg, '#0b1220');
	} finally {
		restore();
	}
});

test('the probe skips what a user cannot see', () => {
	const restore = dom([
		{ tag: 'span', text: 'hidden', style: { display: 'none' } },
		{ tag: 'span', text: 'invisible', style: { visibility: 'hidden' } },
		{ tag: 'span', text: 'transparent', style: { opacity: '0' } },
		{ tag: 'span', text: 'collapsed', box: { width: 0, height: 0 } },
	]);
	try {
		const out = probe();
		assert.deepEqual(out.texts, []);
		assert.equal(out.blank, true, 'a screen with nothing visible is blank');
	} finally {
		restore();
	}
});

test('the probe treats a focusable or pointer div as tappable, because Pressable is one', () => {
	const restore = dom([
		{ tag: 'div', attrs: { tabindex: '0', 'data-qa': 'plan-annual' }, box: { width: 300, height: 60 } },
		{ tag: 'div', style: { cursor: 'pointer' }, text: 'Restore', box: { width: 80, height: 30 } },
		{ tag: 'div', attrs: { role: 'checkbox' }, box: { width: 24, height: 24 } },
		{ tag: 'div', text: 'not a control' },
	]);
	try {
		assert.deepEqual(probe().tappables.map((t) => t.label), ['plan-annual', 'Restore', 'div']);
	} finally {
		restore();
	}
});

test('the probe reports text wider than the box that holds it', () => {
	const restore = dom([{ tag: 'span', text: 'A very long label', scrollWidth: 260, clientWidth: 200 }], { root: { scrollWidth: 520 } });
	try {
		const out = probe();
		assert.deepEqual(out.clipped, [{ label: 'A very long label', over: 60 }]);
		assert.equal(out.overflowX, 92);
	} finally {
		restore();
	}
});

test('a fully transparent colour is not a colour', () => {
	const restore = dom([{ tag: 'span', text: 'ghost', style: { color: 'rgba(0, 0, 0, 0)' } }]);
	try {
		assert.equal(probe().texts[0].fg, null);
	} finally {
		restore();
	}
});

// ── per-screen rules ────────────────────────────────────────────────────────

test('a screen wider than the viewport fails, because a phone does not pan', () => {
	assert.equal(checkLayout(obs(), cell()).status, 'PASS');
	const fail = checkLayout(obs({ overflowX: 18 }), cell(), 'qa/1.0.0/captures/x.png');
	assert.equal(fail.status, 'FAIL');
	assert.deepEqual([fail.measured, fail.threshold], [18, 0]);
	assert.deepEqual(fail.evidence, ['qa/1.0.0/captures/x.png']);
});

test('the smallest tappable box is measured against the HIG minimum', () => {
	assert.equal(checkTapTargets(obs(), cell()).status, 'PASS');
	const fail = checkTapTargets(obs({ tappables: [{ label: 'close', w: 32, h: 32, x: 8, y: 60 }] }), cell());
	assert.equal(fail.status, 'FAIL');
	assert.deepEqual([fail.measured, fail.threshold], [32, TAP_MIN]);
	assert.match(fail.message, /"close" is 32×32pt/);
});

test('a screen with no control at all is a warning, not a pass', () => {
	assert.equal(checkTapTargets(obs({ tappables: [] }), cell()).status, 'WARN');
});

test('contrast is judged at the WCAG threshold the text size earns', () => {
	assert.equal(requiredContrast({ size: 17, weight: 400 }), CONTRAST_BODY);
	assert.equal(requiredContrast({ size: 24, weight: 400 }), CONTRAST_LARGE);
	assert.equal(requiredContrast({ size: 19, weight: 700 }), CONTRAST_LARGE);
	assert.equal(requiredContrast({ size: 19, weight: 400 }), CONTRAST_BODY, '19pt regular is not large text');
});

test('the least legible run on the screen is the one reported', () => {
	const ok = checkContrast(obs(), cell());
	assert.equal(ok.status, 'PASS');
	const fail = checkContrast(obs({ texts: [text(), text({ label: 'Cancel anytime', fg: '#b9c2cc' })] }), cell());
	assert.equal(fail.status, 'FAIL');
	assert.match(fail.message, /Cancel anytime/);
	assert.equal(fail.threshold, CONTRAST_BODY);
});

test('grey-on-grey at 24pt passes on the large-text threshold it qualifies for', () => {
	const large = checkContrast(obs({ texts: [text({ size: 24, fg: '#767676', bg: '#ffffff' })] }), cell());
	assert.equal(large.status, 'PASS');
	assert.equal(large.threshold, CONTRAST_LARGE);
});

test('text whose colours cannot be resolved is a warning, never a silent pass', () => {
	assert.equal(checkContrast(obs({ texts: [text({ fg: null })] }), cell()).status, 'WARN');
	assert.equal(checkContrast(obs({ texts: [] }), cell()).status, 'WARN');
});

test('a control under the notch or the home indicator fails', () => {
	assert.equal(checkSafeArea(obs(), cell()).status, 'PASS');
	const top = checkSafeArea(obs({ tappables: [{ label: 'back', w: 44, h: 44, x: 8, y: 12 }] }), cell());
	assert.equal(top.status, 'FAIL');
	assert.match(top.message, /"back"/);
	const bottom = checkSafeArea(obs({ tappables: [{ label: 'cta', w: 380, h: 56, x: 24, y: 880 }] }), cell());
	assert.equal(bottom.status, 'FAIL');
});

test('clipped text is a layout bug at the default step and a Dynamic Type bug above it', () => {
	const clipped = { clipped: [{ label: 'Start free trial', over: 24 }] };
	assert.equal(checkClipping(obs(clipped), cell()).category, 'layout');
	const xl = checkClipping(obs(clipped), cell({ dynamicType: 'xl' }));
	assert.equal(xl.category, 'dynamic-type');
	assert.equal(xl.status, 'FAIL');
	assert.match(xl.message, /clipped by 24pt at Dynamic Type xl/);
});

test('the type ramp is only checked where a mismatch means anything', () => {
	const system = { type: { ramp: [{ size: 17 }, { size: 28 }] } };
	assert.equal(checkTypeRamp(obs(), cell(), system).status, 'PASS');
	assert.equal(checkTypeRamp(obs(), cell({ dynamicType: 'xl' }), system), null, 'every step above default scales the ramp');
	assert.equal(checkTypeRamp(obs(), cell(), null), null, 'no ramp declared, nothing to check against');
	const off = checkTypeRamp(obs({ texts: [text({ size: 15 })] }), cell(), system);
	assert.equal(off.status, 'WARN');
	assert.match(off.message, /15pt rendered but not in the type ramp/);
});

test('a blank screen short-circuits every other rule with the only finding that matters', () => {
	const checks = checkObservation({ blank: true }, cell());
	assert.equal(checks.length, 1);
	assert.equal(checks[0].category, 'state');
	assert.match(checks[0].message, /rendered no text at all/);
});

test('every per-screen rule declares Tier 1 and carries the flow it came from', () => {
	for (const check of checkObservation(obs(), cell(), { system: { type: { ramp: [{ size: 17 }] } } })) {
		assert.equal(check.requiresTier, 1);
		assert.equal(check.flow, 'paywall');
		assert.match(check.id, /^[a-z][a-z0-9-]*$/);
	}
});

// ── cross-capture rules ─────────────────────────────────────────────────────

const cap = (over = {}, o = {}) => ({ cell: cell(over), obs: obs(o), file: `qa/captures/${cellId(cell(over))}.png`, sha256: 'a'.repeat(64) });
const SPEC = { screens: [{ id: 'paywall', route: '/paywall', flow: 'paywall', states: ['default', 'empty', 'error'] }] };

test('a declared state that was never captured fails', () => {
	const checks = checkStates([cap()], SPEC);
	assert.deepEqual(checks.map((c) => c.status), ['FAIL', 'FAIL']);
	assert.match(checks[0].message, /"empty" state was never captured/);
});

test('a state that renders the default screen is an unbuilt state', () => {
	const same = checkStates([cap(), cap({ state: 'empty' }), cap({ state: 'error' }, { texts: [text({ label: 'Something went wrong' })] })], SPEC);
	assert.equal(same[0].status, 'FAIL');
	assert.match(same[0].message, /same content as the default state/);
	assert.equal(same[1].status, 'PASS');
});

test('dark mode that paints the light palette is not wired', () => {
	const light = cap({ theme: 'light' });
	const identical = checkDarkMode([light, cap({ theme: 'dark' })]);
	assert.equal(identical[0].status, 'FAIL');
	assert.match(identical[0].message, /theme parameter is not wired/);
	const themed = checkDarkMode([light, cap({ theme: 'dark' }, { texts: [text({ fg: '#e8eef7', bg: '#0b1220' })] })]);
	assert.equal(themed[0].status, 'PASS');
});

test('dark mode is judged on the default state at default type, and needs both themes', () => {
	assert.deepEqual(checkDarkMode([cap({ theme: 'light' })]), [], 'one theme proves nothing');
	assert.deepEqual(checkDarkMode([cap({ theme: 'light', state: 'empty' }), cap({ theme: 'dark', state: 'empty' })]), []);
});

test('a regression check with no baseline is SKIPPED, never PASS', () => {
	const [check] = checkRegression([cap()], null);
	assert.equal(check.status, 'SKIPPED');
	assert.match(check.message, /no baseline recorded/);
});

test('a capture is compared to the baseline by hash', () => {
	const shot = cap();
	assert.equal(checkRegression([shot], { [cellId(shot.cell)]: 'a'.repeat(64) })[0].status, 'PASS');
	const drift = checkRegression([shot], { [cellId(shot.cell)]: 'b'.repeat(64) })[0];
	assert.equal(drift.status, 'WARN');
	assert.equal(drift.threshold, 'b'.repeat(64));
	assert.equal(checkRegression([shot], { other: 'x' })[0].status, 'WARN', 'a new capture is new, not broken');
});

test('every Tier 2 category is emitted per screen and cannot pass from a Tier 1 run', () => {
	const rows = tier2Rows(SPEC);
	assert.deepEqual(rows.map((r) => r.category), [...TIER2]);
	for (const row of rows) {
		assert.equal(row.requiresTier, 2);
		assert.equal(row.status, 'SKIPPED');
	}
});

test('only a real Tier 2 artifact can turn a Tier 2 row green', () => {
	const rows = tier2Rows(SPEC);
	const merged = mergeTier2(rows, { checks: [{ id: 'motion-paywall', category: 'motion', requiresTier: 2, status: 'PASS' }] });
	assert.equal(merged.find((r) => r.category === 'motion').status, 'PASS');
	assert.equal(merged.find((r) => r.category === 'native').status, 'SKIPPED');
	const forged = mergeTier2(rows, { checks: [{ id: 'native-paywall', requiresTier: 1, status: 'PASS' }] });
	assert.equal(forged.find((r) => r.category === 'native').status, 'SKIPPED', 'a Tier 1 row may not answer a Tier 2 question');
	assert.deepEqual(mergeTier2(rows, null).map((r) => r.status), rows.map((r) => r.status));
});

test('the report counts every status and satisfies the schema', async () => {
	const checks = [...checkObservation(obs(), cell()), ...tier2Rows(SPEC)];
	const report = buildReport({ version: '1.4.0', checks, matrix: { themes: ['light', 'dark'], locales: ['en-US'], dynamicType: ['default', 'xl'] } });
	assert.deepEqual(await checkArtifact('qa-report', report, 'report.json'), []);
	assert.equal(report.tier, 1);
	assert.deepEqual(report.summary, summarize(report.checks));
	assert.equal(report.summary.skipped, TIER2.length);
});

test('the report puts failures first, because the top of the file is what gets fixed', () => {
	const checks = [
		{ id: 'z-pass', category: 'layout', requiresTier: 1, status: 'PASS' },
		{ id: 'a-skip', category: 'motion', requiresTier: 2, status: 'SKIPPED' },
		{ id: 'm-fail', category: 'contrast', requiresTier: 1, status: 'FAIL' },
		{ id: 'b-warn', category: 'typography', requiresTier: 1, status: 'WARN' },
	];
	assert.deepEqual(buildReport({ version: '1.0.0', checks }).checks.map((c) => c.id), ['m-fail', 'b-warn', 'a-skip', 'z-pass']);
});
