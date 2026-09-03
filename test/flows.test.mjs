// The flow vocabulary is a join key: research references, design/ux.json,
// analytics events and QA captures all address each other through it. So these
// tests guard two things — the structural invariants that keep it a *closed*
// vocabulary, and the classification matrix, which is the part that silently
// rots as patterns are added.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_RESEARCH_FLOWS,
	EVENT_VERBS,
	FLOWS,
	FLOW_IDS,
	GROUPS,
	MATCH_ORDER,
	eventName,
	flowOf,
	flowsIn,
	isFlow,
	requireFlow,
} from '../src/lib/flows.mjs';
import { ShipError } from '../src/log.mjs';

test('every flow declares a known group and non-empty prose', () => {
	for (const [id, flow] of Object.entries(FLOWS)) {
		assert.ok(GROUPS.includes(flow.group), `${id}: unknown group ${flow.group}`);
		assert.ok(flow.label.length > 0, `${id}: empty label`);
		assert.ok(flow.purpose.length > 0, `${id}: empty purpose`);
		assert.ok(flow.match instanceof RegExp, `${id}: match is not a RegExp`);
	}
});

test('flow ids are kebab-case, so the event name derived from one is snake_case', () => {
	for (const id of FLOW_IDS) assert.match(id, /^[a-z]+(-[a-z]+)*$/, `${id} is not kebab-case`);
});

test('labels are unique, so a report can be read without ids', () => {
	const labels = FLOW_IDS.map((id) => FLOWS[id].label);
	assert.equal(new Set(labels).size, labels.length);
});

test('MATCH_ORDER is a permutation of FLOW_IDS — no flow can be unreachable', () => {
	assert.equal(MATCH_ORDER.length, FLOW_IDS.length);
	assert.deepEqual([...MATCH_ORDER].sort(), [...FLOW_IDS].sort());
});

test('every group holds at least one flow, and the groups partition the flows', () => {
	const counted = GROUPS.flatMap((g) => flowsIn(g));
	assert.equal(counted.length, FLOW_IDS.length);
	for (const g of GROUPS) assert.ok(flowsIn(g).length > 0, `${g} is empty`);
});

test('flowsIn rejects an unknown group and names the valid ones', () => {
	assert.throws(() => flowsIn('nope'), (err) => err instanceof ShipError && /activation/.test(err.hint ?? ''));
});

test('the default research set is real flows', () => {
	for (const id of DEFAULT_RESEARCH_FLOWS) assert.ok(isFlow(id), `${id} is not a flow`);
});

test('isFlow accepts only declared ids', () => {
	assert.equal(isFlow('paywall'), true);
	assert.equal(isFlow('Paywall'), false);
	assert.equal(isFlow('toString'), false, 'inherited keys are not flows');
	assert.equal(isFlow(undefined), false);
	assert.equal(isFlow(7), false);
});

test('requireFlow returns the id or explains what was allowed', () => {
	assert.equal(requireFlow('home'), 'home');
	assert.throws(
		() => requireFlow('onboarding', 'research flow'),
		(err) => err instanceof ShipError && /unknown research flow "onboarding"/.test(err.message) && /paywall/.test(err.hint ?? ''),
	);
});

// The matrix. Every row is a name this pipeline actually encounters: a PostHog
// step, an expo-router route, an event, or a competitor's screenshot caption.
test('flowOf classifies the names the pipeline really sees', () => {
	/** @type {[string, string|null][]} */
	const cases = [
		// separators and case are noise
		['Onboarding-Welcome', 'welcome'],
		['paywall_shown', 'paywall'],
		['app.first.launch', 'first-launch'],
		// specific beats generic: edge and monetization before core
		['no items yet', 'empty'],
		['loading skeleton', 'loading'],
		['purchase failed', 'error'],
		['premium locked feature', 'feature-gate'],
		// the two orderings that were wrong on the first pass
		['restore purchases', 'restore'],
		['purchase completed', 'paywall'],
		['undo delete', 'undo'],
		['delete account', 'destructive'],
		// permission asks are activation, delivered pushes are retention
		['notification permission prompt', 'permission'],
		['push notification', 'notification'],
		// core is the fallback, not the first guess
		['home', 'home'],
		['search results', 'search'],
		['settings', 'settings'],
		['log meal', 'create'],
		['Q3 what is your goal', 'personalization'],
		['first log completed', 'first-value'],
		['upgrade to pro', 'upsell'],
		['progress chart', 'progress'],
		// an unknown name is a finding, not a bucket
		['zzz', null],
		['', null],
		[' ', null],
	];
	for (const [name, expected] of cases) assert.equal(flowOf(name), expected, `flowOf(${JSON.stringify(name)})`);
});

test('flowOf tolerates whatever an untyped export hands it', () => {
	assert.equal(flowOf(null), null);
	assert.equal(flowOf(undefined), null);
	assert.equal(flowOf(0), null);
	assert.equal(flowOf('Paywall'), 'paywall', 'case is folded');
});

test('eventName applies one naming rule to every flow and verb', () => {
	assert.equal(eventName('paywall', 'viewed'), 'paywall_viewed');
	assert.equal(eventName('first-value', 'completed'), 'first_value_completed', 'dashes become underscores');
	for (const id of FLOW_IDS)
		for (const verb of EVENT_VERBS) assert.match(eventName(id, verb), /^[a-z]+(_[a-z]+)*$/);
});

test('eventName refuses an unknown flow or verb rather than inventing a name', () => {
	assert.throws(() => eventName('nope', 'viewed'), (err) => err instanceof ShipError && /event flow/.test(err.message));
	assert.throws(
		() => eventName('paywall', 'view'),
		(err) => err instanceof ShipError && /unknown event verb "view"/.test(err.message) && /viewed/.test(err.hint ?? ''),
	);
});
