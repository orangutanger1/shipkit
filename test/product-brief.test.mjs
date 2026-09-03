// The brief's two halves. The market half is computed and must survive a
// re-draft; the product half is authored and must be refused until it is there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHORED, checkBrief, draftBrief, incumbentPrices, jobSeeds, scoutRisks } from '../src/lib/product-brief.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { flowsIn } from '../src/lib/flows.mjs';
import { ARTIFACTS, clone, themes } from './fixtures/artifacts.mjs';

/** A scout brief as `ship scout brief` writes one, trimmed to what this reads. */
const SCOUT = {
	term: 'car maintenance log',
	slug: 'car-maintenance-log',
	market: { country: 'US', lang: 'en-US' },
	viability: 41,
	incumbents: [
		{ name: 'Car Maintenance Reminders', price: 0 },
		{ name: 'AUTOsist', price: 9.99 },
		{ name: null, price: 4.99 },
	],
	verdict: { go: false, reasons: [{ gate: 'moat', message: 'the top three median 41,000 ratings' }] },
};

test('a draft carries the market half and omits the product half', async () => {
	const doc = draftBrief(SCOUT, { source: 'scout/us/x-brief.json' });
	assert.equal(doc.verdict.go, false);
	assert.equal(doc.verdict.viability, 41);
	assert.deepEqual(doc.market, { country: 'us', lang: 'en-US' });
	for (const field of AUTHORED) if (field !== 'monetization') assert.equal(doc[field], undefined, `${field} must not be guessed`);
	// The draft is deliberately invalid until filled, and says so by name.
	assert.equal(doc._todo.length, AUTHORED.length - 1);
	assert.ok(doc._todo.some((/** @type {string} */ t) => t.startsWith('valueProp:')));
	assert.ok((await checkArtifact('product-brief', doc, 'brief.json')).length > 0);
});

test('a gate failure becomes a risk in the words the reader already saw', () => {
	const doc = draftBrief(SCOUT);
	assert.deepEqual(doc.risks, [{ risk: 'the top three median 41,000 ratings', severity: 'high', source: 'scout' }]);
});

test('a brief that cleared every gate still carries one risk', () => {
	// A brief with no risks reads as a brief nobody thought about, and the
	// schema demands one; "the gates measure the market, not you" is the honest
	// minimum.
	const risks = scoutRisks({ go: true, reasons: [] });
	assert.equal(risks.length, 1);
	assert.equal(risks[0].severity, 'low');
	assert.equal(risks[0].source, 'scout');
});

test('incumbent prices are computed, free apps included', () => {
	// A market of free incumbents is the most important fact about whether this
	// one can charge, so a 0 is data and not a missing value.
	assert.deepEqual(incumbentPrices(SCOUT.incumbents), [
		{ name: 'Car Maintenance Reminders', priceUsd: 0 },
		{ name: 'AUTOsist', priceUsd: 9.99 },
	]);
	assert.deepEqual(incumbentPrices(null), []);
});

test('a re-draft keeps the thinking and refreshes the market', () => {
	const filled = clone(ARTIFACTS['product-brief']);
	const redrafted = draftBrief({ ...SCOUT, viability: 63, verdict: { go: true, reasons: [] } }, { previous: filled });
	assert.equal(redrafted.verdict.go, true);
	assert.equal(redrafted.verdict.viability, 63);
	assert.equal(redrafted.valueProp, filled.valueProp);
	assert.deepEqual(redrafted.jobs, filled.jobs);
	assert.equal(redrafted._todo, undefined);
});

test('a re-draft drops a scout risk that stopped firing and keeps an authored one', () => {
	const previous = {
		...clone(ARTIFACTS['product-brief']),
		risks: [
			{ risk: 'The top three all ship reminders already', severity: 'high', source: 'scout' },
			{ risk: 'We have never built a widget', severity: 'medium', source: 'author' },
		],
	};
	const redrafted = draftBrief({ ...SCOUT, verdict: { go: true, reasons: [] } }, { previous });
	const sources = redrafted.risks.map((/** @type {any} */ r) => r.source);
	assert.deepEqual(sources, ['scout', 'author']);
	assert.match(redrafted.risks[0].risk, /no storefront gate flagged this/);
	assert.equal(redrafted.risks[1].risk, 'We have never built a widget');
});

test('the filled fixture satisfies its schema', async () => {
	assert.deepEqual(await checkArtifact('product-brief', ARTIFACTS['product-brief'], 'brief.json'), []);
});

test('jobSeeds offers pains and jobs, most-supported first, and nothing else', () => {
	const doc = {
		themes: [
			{ label: 'praise', kind: 'praise', support: 99 },
			{ label: 'asked for widgets', kind: 'request', support: 50 },
			{ label: 'logging friction', kind: 'pain', support: 12 },
			{ label: 'track two cars', kind: 'job', support: 30 },
		],
	};
	assert.deepEqual(jobSeeds(doc).map((s) => s.label), ['track two cars', 'logging friction']);
	assert.deepEqual(jobSeeds(null), []);
});

test('a job may not cite a theme that is not in themes.json', () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.jobs[0].evidence = ['invented theme'];
	assert.deepEqual(checkBrief(doc, { themes }), ['jobs[0].evidence cites "invented theme", which is not a theme in themes.json']);
	// The fixture cites the theme the themes fixture actually holds.
	assert.deepEqual(checkBrief(clone(ARTIFACTS['product-brief']), { themes }), []);
});

test('a brief drafted before any research may cite nothing', () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.jobs[0].evidence = ['a theme from a run that does not exist yet'];
	assert.deepEqual(checkBrief(doc, { themes: null }), []);
});

test('retention flows must be retention flows', () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.retention.flows = ['paywall'];
	const [issue] = checkBrief(doc);
	assert.match(issue, /retention\.flows lists "paywall"/);
	assert.match(issue, new RegExp(flowsIn('retention')[0]));
});

test('an edge flow is not what the product is for', () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.northStar.flow = 'error';
	assert.match(checkBrief(doc)[0], /northStar\.flow is "error", an edge flow/);
});

test('the monetization model has to agree with itself', () => {
	const gateless = clone(ARTIFACTS['product-brief']);
	delete gateless.monetization.gate;
	assert.match(checkBrief(gateless)[0], /nothing says what is behind the gate/);

	const periodless = clone(ARTIFACTS['product-brief']);
	delete periodless.monetization.period;
	assert.match(checkBrief(periodless)[0], /no period is named/);

	const free = clone(ARTIFACTS['product-brief']);
	free.monetization = { model: 'free', gate: 'export' };
	assert.match(checkBrief(free)[0], /a gate is described — one of the two is wrong/);
});

test('checkBrief reports every issue at once', () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.retention.flows = ['paywall'];
	doc.northStar.flow = 'error';
	delete doc.monetization.period;
	assert.equal(checkBrief(doc).length, 3);
});

test('the activation event is a flow-and-verb the app could actually emit', async () => {
	const bad = clone(ARTIFACTS['product-brief']);
	bad.activation.event = 'user_did_a_thing';
	const issues = await checkArtifact('product-brief', bad, 'brief.json');
	assert.equal(issues.length, 1);
	assert.match(issues[0], /activation\.event/);
});

test('the verdict cannot be hand-edited into a shape the scorer does not produce', async () => {
	const bad = clone(ARTIFACTS['product-brief']);
	bad.verdict.viability = 140;
	assert.match((await checkArtifact('product-brief', bad, 'brief.json'))[0], /above maximum 100/);
});
