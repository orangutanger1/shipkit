import assert from 'node:assert/strict';
import test from 'node:test';
import { emitScreen } from '../src/lib/design-screen.mjs';
import { reviewSources } from '../src/lib/design-review.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const SRC = 'design/ux.json';
const base = {
	id: 'paywall', route: '/paywall', flow: 'paywall', purpose: 'Sell.',
	copy: { title: 'Go Pro', cta: 'Start' },
	states: ['default', 'loading', 'error'],
	events: [
		{ name: 'paywall_viewed', flow: 'paywall', verb: 'viewed' },
		{ name: 'paywall_completed', flow: 'paywall', verb: 'completed' },
	],
	elements: [
		{ component: 'Text', variant: 'largeTitle', copy: 'title' },
		{ component: 'Button', variant: 'primary', copy: 'cta', event: 'paywall_completed' },
	],
};

test('elements are transcribed in order, with their variants', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /<Text role="largeTitle">\{copy\.title\}<\/Text>/);
	assert.match(out, /<Button variant="primary"/);
	assert.ok(out.indexOf('role="largeTitle"') < out.indexOf('<Button'));
});

test('the component is named for the screen and default-exported', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /export default function Paywall\(\)/);
});

test('every declared state becomes an early return', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /if \(state === 'loading'\) return <StateView kind="loading" \/>;/);
	assert.match(out, /if \(state === 'error'\) return <StateView kind="error" \/>;/);
	assert.doesNotMatch(out, /kind="default"/);
});

test('events are typed references, never string literals', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /track\(EVENTS\.paywall_viewed\)/);
	assert.match(out, /track\(EVENTS\.paywall_completed\)/);
	assert.doesNotMatch(out, /track\('paywall/);
});

test('a screen with no elements gets the null layout and says so', () => {
	const { elements, ...bare } = base;
	const out = emitScreen(bare, { source: SRC });
	assert.match(out, /no elements were specified/i);
	assert.match(out, /<Text role="body">\{copy\.title\}<\/Text>/);
	assert.doesNotMatch(out, /<Button/);
});

test('monetization is re-exported as data, not written as a comment', () => {
	const out = emitScreen({ ...base, monetization: { offering: 'pro', entitlement: 'premium' } }, { source: SRC });
	assert.match(out, /export const monetization = MONETIZATION\.paywall;/);
});

test('a screen that sells nothing imports no catalog', () => {
	const out = emitScreen(base, { source: SRC });
	assert.doesNotMatch(out, /MONETIZATION/);
});

test('the generated screen passes `ship design review` — no literal it did not take from the system', () => {
	const out = emitScreen({ ...base, monetization: { offering: 'pro', entitlement: 'premium' } }, { source: SRC });
	const violations = reviewSources([{ path: 'app/paywall.tsx', source: out }], DEFAULT_SYSTEM);
	assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});

test('a nested route reaches src from its own depth', () => {
	const out = emitScreen({ ...base, id: 'notifications', route: '/settings/notifications' }, { source: SRC });
	assert.match(out, /from '\.\.\/\.\.\/src\/theme\/primitives'/);
	assert.doesNotMatch(out, /from '\.\.\/src\//);
});

test('a shallow route reaches src with a single level up', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /from '\.\.\/src\/theme\/primitives'/);
});

test('copy is escaped, so an apostrophe cannot break the module', () => {
	const out = emitScreen({ ...base, copy: { title: "Don't stop", cta: 'Go' } }, { source: SRC });
	assert.match(out, /Don\\'t stop/);
});
