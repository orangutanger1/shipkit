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

test('DEFAULT_SPEC is a valid ux spec with one home screen', async () => {
	assert.deepEqual(await checkArtifact('ux-spec', DEFAULT_SPEC, 'ux.json'), []);
	assert.equal(DEFAULT_SPEC.screens.length, 1);
	assert.equal(DEFAULT_SPEC.screens[0].route, '/');
});
