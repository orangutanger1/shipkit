import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SYSTEM, emitTokens } from '../src/lib/design-tokens.mjs';
import { contractDoc, validateAgainstContract } from '../src/lib/design-contract.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { designSystem } from './fixtures/artifacts.mjs';

const SRC = 'design/system.json';

test('DEFAULT_SYSTEM is a valid design system that satisfies the contract', async () => {
	assert.deepEqual(await checkArtifact('design-system', DEFAULT_SYSTEM, 'system.json'), []);
	const spec = { screens: [], flows: [] };
	assert.deepEqual(validateAgainstContract(spec, contractDoc(), DEFAULT_SYSTEM), []);
});

test('both themes and every ramp step reach the module', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /export const tokens = \{/);
	assert.match(out, /light:/);
	assert.match(out, /dark:/);
	for (const step of DEFAULT_SYSTEM.type.ramp) assert.ok(out.includes(`${step.name}:`), `missing ${step.name}`);
	assert.match(out, /as const;/);
});

test('the exported types are what the primitives index by', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /export type ThemeName/);
	assert.match(out, /export type ColorToken/);
	assert.match(out, /export type TypeRole/);
});

test('font weights are strings — React Native rejects a numeric fontWeight', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /weight: '700'/);
	assert.doesNotMatch(out, /weight: 700\b/);
});

test('it carries an ownership header naming its source, and no timestamp', () => {
	const out = emitTokens(designSystem, { source: SRC });
	assert.ok(out.startsWith('// @generated'));
	assert.ok(out.includes(SRC));
	assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T/);
});

test('key order follows the ramp, not the parsed object', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	const order = DEFAULT_SYSTEM.type.ramp.map((s) => out.indexOf(`\t\t${s.name}:`));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
