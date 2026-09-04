import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_SPEC, QA_PARAMS_SOURCE, emitCatalog, emitEvents, emitQaParams } from '../src/lib/design-support.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { uxSpec } from './fixtures/artifacts.mjs';

const SRC = 'design/ux.json';

test('every declared event becomes a typed constant', () => {
	const out = emitEvents(uxSpec, { source: SRC });
	assert.match(out, /paywall_viewed: 'paywall_viewed'/);
	assert.match(out, /export type AppEvent/);
	assert.match(out, /as const;/);
});

test('events are deduplicated and sorted, so two screens sharing one do not collide', () => {
	const spec = { screens: [
		{ id: 'b', events: [{ name: 'home_viewed' }] },
		{ id: 'a', events: [{ name: 'home_viewed' }, { name: 'account_viewed' }] },
	] };
	const out = emitEvents(spec, { source: SRC });
	assert.equal(out.match(/home_viewed:/g).length, 1);
	assert.ok(out.indexOf('account_viewed:') < out.indexOf('home_viewed:'));
});

test('a spec with no events still emits a compiling module', () => {
	const out = emitEvents({ screens: [] }, { source: SRC });
	assert.match(out, /export const EVENTS = \{\} as const;/);
	assert.match(out, /export type AppEvent = string;/);
});

test('monetization becomes structured data keyed by screen id', () => {
	const out = emitCatalog(uxSpec, { source: SRC });
	assert.match(out, /paywall: \{ offering: 'default', entitlement: 'pro'/);
	assert.match(out, /export const MONETIZATION/);
});

test('a spec that sells nothing still emits a compiling catalog', () => {
	const out = emitCatalog({ screens: [{ id: 'home' }] }, { source: SRC });
	assert.match(out, /export const MONETIZATION = \{\} as const;/);
});

test('the emitted QA sanitizer is the shipkit module, JSDoc types stripped', async () => {
	const src = await readFile(QA_PARAMS_SOURCE, 'utf8');
	const out = emitQaParams(src, { source: 'src/lib/qa-params.mjs' });
	assert.match(out, /export function sanitizeQa/);
	assert.match(out, /export const QA_DEFAULTS/);
	assert.doesNotMatch(out, /@type \{/);
	assert.doesNotMatch(out, /from '\.\/qa-params\.mjs'/);
});

test('a stripped JSDoc type reappears as a TypeScript signature', async () => {
	// JSDoc types mean nothing in a .ts file, so dropping them without
	// translating them is what shipped nine implicit-any parameters.
	const src = await readFile(QA_PARAMS_SOURCE, 'utf8');
	const out = emitQaParams(src, { source: 'src/lib/qa-params.mjs' });
	assert.match(out, /function oneOf\(value: unknown, allowed: readonly string\[\], fallback: string\|null\): string\|null \{/);
	assert.match(out, /function scaleOf\(value: unknown\): number \{/);
	// The object parameter's own commas must not split it, and its default
	// belongs after the type.
	assert.match(out, /states = QA_STATES \}: \{enabled: boolean, themes: readonly string\[\], states\?: readonly string\[\]\}\)/);
});

test('a const cast survives as `as const`, so the app sees the same literals', async () => {
	const src = await readFile(QA_PARAMS_SOURCE, 'utf8');
	const out = emitQaParams(src, { source: 'src/lib/qa-params.mjs' });
	assert.match(out, /'disabled',\n\] as const;/);
	assert.match(out, /scale: 1 \} as const;/);
	assert.doesNotMatch(out, /\/\*\* @type \{const\}/);
});

test('an annotation that does not describe the declaration is left alone', () => {
	// Guessing would mistype the app. Silence here is caught by
	// test/design-typecheck.test.mjs, which compiles what this emits.
	const src = [
		'/** @type {(a: string) => void} */',
		'function arity(a, b) {',
		'}',
		'/** @type {string} */',
		'function notAFunctionType(a) {',
		'}',
	].join('\n');
	const out = emitQaParams(src, { source: 'x.mjs' });
	assert.match(out, /function arity\(a, b\) \{/);
	assert.match(out, /function notAFunctionType\(a\) \{/);
});

test('an unnamed parameter type still annotates by position', () => {
	const out = emitQaParams('/** @type {(string) => number} */\nfunction len(s) {\n}', { source: 'x.mjs' });
	assert.match(out, /function len\(s: string\): number \{/);
});

test('a JSDoc block that was only a type is removed, not left empty', () => {
	const out = emitQaParams('/**\n * @type {(a: string) => void}\n */\nfunction f(a) {\n}', { source: 'x.mjs' });
	assert.doesNotMatch(out, /\/\*\*\n \*\//);
	assert.match(out, /function f\(a: string\): void \{/);
});

test('DEFAULT_SPEC is a valid ux spec with one home screen', async () => {
	assert.deepEqual(await checkArtifact('ux-spec', DEFAULT_SPEC, 'ux.json'), []);
	assert.equal(DEFAULT_SPEC.screens.length, 1);
	assert.equal(DEFAULT_SPEC.screens[0].route, '/');
});
