import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_VERSION, contractDoc, requiredTokens, validateAgainstContract } from '../src/lib/design-contract.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { clone, designSystem, uxSpec } from './fixtures/artifacts.mjs';
import { draftSystem } from '../src/lib/design-draft.mjs';

const contract = contractDoc();

// draftSystem is the deterministic half of a design system and omits colour on
// purpose, so the fixture's palette completes it. It satisfies every token the
// contract requires, which is what lets these tests assert an exact count.
const ok = { ...draftSystem({ name: 'Demo' }), color: designSystem.color };

const screen = (over = {}) => ({
	id: 'paywall', route: '/paywall', flow: 'paywall', purpose: 'Sell.',
	copy: { title: 'Go Pro', cta: 'Start' }, states: ['default'],
	events: [{ name: 'paywall_viewed', flow: 'paywall', verb: 'viewed' }],
	...over,
});
const specOf = (s) => ({ screens: [s], flows: [{ id: 'paywall', screens: [s.id], success: 'Bought.' }] });

test('the contract validates against its own schema', async () => {
	assert.deepEqual(await checkArtifact('components', contract, 'components.json'), []);
	assert.equal(contract.contractVersion, CONTRACT_VERSION);
});

test('requiredTokens is computed from the contract, not hardcoded', () => {
	const req = requiredTokens(contract);
	assert.ok(req.type.includes('body'));
	assert.ok(req.radii.includes('md'));
	assert.ok(req.color.includes('accent'));
	assert.ok(req.spacingSteps >= 1);
});

test('the drafted default system satisfies every requirement', async () => {
	assert.deepEqual(validateAgainstContract(specOf(screen()), contract, ok), []);
});

test('an unsupported component is named, with the supported set', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Carousel', copy: 'title' }] })), contract, ok);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /Carousel/);
	assert.match(issues[0], /Button/);
});

test('an unsupported variant names both the component and the variant', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Button', variant: 'ghost', copy: 'cta' }] })), contract, ok);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /Button/);
	assert.match(issues[0], /ghost/);
});

test('a dangling copy key and an undeclared event are both reported', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Button', variant: 'primary', copy: 'missing', event: 'paywall_completed' }] })),
		contract, ok);
	assert.equal(issues.length, 2);
	assert.ok(issues.some((i) => /missing/.test(i)));
	assert.ok(issues.some((i) => /paywall_completed/.test(i)));
});

test('an unsupported state is named', () => {
	const issues = validateAgainstContract(specOf(screen({ states: ['default', 'success'] })), contract, ok);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /success/);
});

test('every missing token is reported at once, not one per run', () => {
	const thin = clone(designSystem);
	thin.type.ramp = thin.type.ramp.filter((s) => s.name === 'body');
	thin.radii = {};
	const issues = validateAgainstContract(specOf(screen()), contract, thin);
	assert.ok(issues.length >= 3, `expected several, got ${issues.length}`);
	assert.ok(issues.some((i) => /largeTitle/.test(i)));
	assert.ok(issues.some((i) => /md/.test(i)));
});

test('a newer contractVersion is refused rather than mis-transcribed', () => {
	const issues = validateAgainstContract(specOf(screen()), { ...contract, contractVersion: 99 }, ok);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /99/);
});

test('a spec with no elements is valid — the null layout is a choice, not an error', () => {
	assert.deepEqual(validateAgainstContract(clone(uxSpec), contract, ok), []);
});
