// Identical inputs must produce identical bytes. The ownership hash in
// design-emit.mjs is meaningless otherwise: a generator that varied its output
// would report every file as hand-edited on the second run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { contractDoc } from '../src/lib/design-contract.mjs';
import { emitScreen } from '../src/lib/design-screen.mjs';
import { DEFAULT_SYSTEM, emitTokens } from '../src/lib/design-tokens.mjs';
import { emitCatalog, emitEvents } from '../src/lib/design-support.mjs';
import { clone, designSystem, uxSpec } from './fixtures/artifacts.mjs';

const SYS = 'design/system.json';
const UX = 'design/ux.json';
const screen = uxSpec.screens[0];

const CASES = [
	['tokens', () => emitTokens(designSystem, { source: SYS })],
	['screen', () => emitScreen(screen, { source: UX })],
	['events', () => emitEvents(uxSpec, { source: UX })],
	['catalog', () => emitCatalog(uxSpec, { source: UX })],
];

test('every emitter is byte-stable across runs', () => {
	for (const [name, emit] of CASES) assert.equal(emit(), emit(), `${name} varied between runs`);
});

test('every emitter is byte-stable against a deep clone of its input', () => {
	assert.equal(emitTokens(designSystem, { source: SYS }), emitTokens(clone(designSystem), { source: SYS }));
	assert.equal(emitScreen(screen, { source: UX }), emitScreen(clone(screen), { source: UX }));
	assert.equal(emitEvents(uxSpec, { source: UX }), emitEvents(clone(uxSpec), { source: UX }));
});

test('no emitted file carries a timestamp — it would make every run a diff', () => {
	for (const [name, emit] of CASES) {
		assert.doesNotMatch(emit(), /\d{4}-\d{2}-\d{2}T\d{2}:/, `${name} carries an ISO timestamp`);
		assert.doesNotMatch(emit(), /generatedAt/, `${name} carries generatedAt`);
	}
});

test('the contract document carries no timestamp either', () => {
	assert.ok(!('generatedAt' in contractDoc()));
});

const GOLDEN = [
	['tokens.ts.txt', () => emitTokens(DEFAULT_SYSTEM, { source: SYS })],
	['paywall.tsx.txt', () => emitScreen(screen, { source: UX })],
	['events.ts.txt', () => emitEvents(uxSpec, { source: UX })],
];

test('generated output matches its golden file', async (t) => {
	for (const [file, emit] of GOLDEN) {
		await t.test(file, async () => {
			const want = await readFile(new URL(`./fixtures/design/expected/${file}`, import.meta.url), 'utf8');
			assert.equal(emit(), want, `regenerate with UPDATE_GOLDEN=1 if this change is intended`);
		});
	}
});
