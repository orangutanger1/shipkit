// The seven artifact schemas, as gates. Each test names a rule the plan relies
// on — uncited token, uncounted theme, evidence without refs — and proves the
// schema refuses the document that breaks it.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { FLOW_IDS, EVENT_VERBS } from '../src/lib/flows.mjs';
import { validate } from '../src/lib/schema.mjs';
import { SCHEMAS, loadSchema, checkArtifact, assertArtifact } from '../src/lib/schemas.mjs';
import { ARTIFACTS, clone } from './fixtures/artifacts.mjs';

const ARTIFACT_NAMES = Object.keys(ARTIFACTS);

/** Break one field of a fixture and assert the schema catches it. */
async function rejects(name, mutate, needle) {
	const doc = clone(ARTIFACTS[name]);
	mutate(doc);
	const issues = await checkArtifact(name, doc, `${name}.json`);
	assert.ok(issues.length, `${name} accepted a document it should refuse`);
	if (needle) assert.ok(issues.some((i) => i.includes(needle)), `${JSON.stringify(issues)} lacks "${needle}"`);
}

test('every schema file is registered and parses', async () => {
	const files = (await readdir(new URL('../schema/', import.meta.url))).filter((f) => f.endsWith('.schema.json'));
	assert.deepEqual(files.map((f) => f.replace('.schema.json', '')).sort(), [...SCHEMAS].sort());
	for (const name of SCHEMAS) {
		const schema = await loadSchema(name);
		assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${name} declares no draft`);
		assert.ok(schema.title && schema.description, `${name} needs a title and a description — the schema is the agent's documentation`);
	}
});

test('an unknown schema name is refused rather than read off disk', async () => {
	await assert.rejects(() => loadSchema('../../etc/passwd'), /no schema named/);
});

test('every fixture satisfies its schema', async () => {
	for (const name of ARTIFACT_NAMES) {
		assert.deepEqual(await checkArtifact(name, ARTIFACTS[name], `${name}.json`), [], name);
	}
});

test('assertArtifact throws with every issue, not just the first', async () => {
	await assert.doesNotReject(() => assertArtifact('qa-report', ARTIFACTS['qa-report'], 'report.json'));
	await assert.rejects(() => assertArtifact('qa-report', { tier: 3 }, 'report.json'), (err) => {
		assert.match(err.message, /report\.json does not match the qa-report schema/);
		assert.match(err.hint, /version is required/);
		assert.match(err.hint, /above maximum 2/);
		return true;
	});
});

test('a document that is not an object at all reports against the root', async () => {
	assert.deepEqual(await checkArtifact('qa-report', [], 'report.json'), ['report.json (root) expected object, got array']);
});

test('every schema that names a flow uses the closed vocabulary verbatim', async () => {
	let seen = 0;
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) return node.forEach(walk);
		if (node.description?.startsWith('A flow id from src/lib/flows.mjs')) {
			assert.deepEqual(node.enum, FLOW_IDS, 'a schema flow enum has drifted from src/lib/flows.mjs');
			seen++;
		}
		Object.values(node).forEach(walk);
	};
	for (const name of ARTIFACT_NAMES) walk(await loadSchema(name));
	assert.ok(seen >= 5, `expected the flow enum in most artifact schemas, found ${seen}`);
});

test('the haptics map is keyed by the same flow.verb events analytics emits', async () => {
	const schema = await loadSchema('design-system');
	const [pattern] = Object.keys(schema.properties.haptics.patternProperties);
	const re = new RegExp(pattern);
	assert.ok(re.test(`${FLOW_IDS[0]}.${EVENT_VERBS[0]}`));
	assert.ok(!re.test('paywall.exploded'));
	assert.ok(!re.test('nonsense.viewed'));
});

test('a reference must answer what may not be copied', async () => {
	await rejects('research-reference', (d) => delete d.doNotCopy, 'doNotCopy is required');
	await rejects('research-reference', (d) => { d.doNotCopy = ''; }, 'shorter than 1');
});

test('a reference is pinned to a committed, hashed image', async () => {
	await rejects('research-reference', (d) => { d.image.path = '/tmp/shot.png'; }, 'does not match');
	await rejects('research-reference', (d) => { d.image.sha256 = 'not-a-hash'; }, 'not a valid sha256');
	await rejects('research-reference', (d) => delete d.image.w, 'w is required');
});

test('a reference carries a known flow, provider and marketing position', async () => {
	await rejects('research-reference', (d) => { d.flow = 'onboarding'; }, 'must be one of');
	await rejects('research-reference', (d) => { d.provider = 'screenshot-service'; });
	await rejects('research-reference', (d) => { d.position = 11; }, 'above maximum 10');
	const withoutPosition = clone(ARTIFACTS['research-reference']);
	withoutPosition.position = null;
	assert.deepEqual(await checkArtifact('research-reference', withoutPosition, 'ref.json'), []);
});

test('estimate fields stay null rather than absent when no provider supplies them', async () => {
	await rejects('research-reference', (d) => { d.app.downloadsEst = 'lots'; }, 'expected integer or null');
	await rejects('research-reference', (d) => { d.app.rating = 6; }, 'above maximum 5');
});

test('observations are capped, so a reference stays a note', async () => {
	await rejects('research-reference', (d) => { d.observations.summary = 'x'.repeat(401); }, 'longer than 400');
	await rejects('research-reference', (d) => { d.observations.verdict = 'ship it'; }, 'not a known property');
});

test('a review corpus is machine-fetched shape, not prose', async () => {
	await rejects('research-reviews', (d) => { d.reviews[0].rating = 0; }, 'below minimum 1');
	await rejects('research-reviews', (d) => { d.sorts = []; }, 'at least 1');
	await rejects('research-reviews', (d) => { d.sorts = ['mostrecent', 'mostrecent']; }, 'duplicate');
	await rejects('research-reviews', (d) => { d.reviews[0].date = 'yesterday'; }, 'not a valid date-time');
	const unversioned = clone(ARTIFACTS['research-reviews']);
	unversioned.reviews[0].version = null;
	assert.deepEqual(await checkArtifact('research-reviews', unversioned, 'reviews.json'), []);
});

test('a theme must name the reviews behind it', async () => {
	await rejects('research-themes', (d) => { d.themes[0].reviewIds = []; }, 'at least 1');
	await rejects('research-themes', (d) => delete d.themes[0].support, 'support is required');
	await rejects('research-themes', (d) => { d.themes[0].kind = 'vibe'; }, 'must be one of');
	await rejects('research-themes', (d) => { d.themes[0].quotes = ['a', 'b', 'c', 'd']; }, 'limit is 3');
	await rejects('research-themes', (d) => { d.themes[0].quotes = ['x'.repeat(201)]; }, 'longer than 200');
});

test('a claim cites references and is forced to consider counterexamples', async () => {
	await rejects('research-patterns', (d) => { d.claims[0].refs = []; }, 'at least 1');
	await rejects('research-patterns', (d) => delete d.claims[0].counterexamples, 'counterexamples is required');
	await rejects('research-patterns', (d) => { d.claims[0].refs = ['screenshot-3']; }, 'does not match');
	await rejects('research-patterns', (d) => { d.claims[0].kind = 'intuition'; }, 'must be one of');
});

test('a design token without a citation is refused', async () => {
	await rejects('design-system', (d) => delete d.color.themes.light.accent.cite, 'cite is required');
	await rejects('design-system', (d) => { d.radii.card.cite = 'because it looks nice'; }, 'does not match');
	await rejects('design-system', (d) => { d.motion.durations.standard.cite = 'ref_ZZZ'; }, 'does not match');
});

test('the design system allows exactly one accent hue and two complete themes', async () => {
	await rejects('design-system', (d) => { d.color.accentHue = [212, 340]; }, 'expected integer');
	await rejects('design-system', (d) => { d.color.accentHue = 400; }, 'above maximum 359');
	await rejects('design-system', (d) => delete d.color.themes.dark, 'dark is required');
	await rejects('design-system', (d) => delete d.color.themes.dark.textMuted, 'textMuted is required');
	await rejects('design-system', (d) => { d.color.themes.light.accent.value = 'blue'; }, 'does not match');
});

test('the spacing scale is a single series and the type ramp is a real ramp', async () => {
	await rejects('design-system', (d) => { d.spacing.base = 6; }, 'must be one of: 4, 8');
	await rejects('design-system', (d) => { d.spacing.scale = [4, 4, 8, 12]; }, 'duplicate');
	await rejects('design-system', (d) => { d.type.ramp = d.type.ramp.slice(0, 3); }, 'at least 4');
	await rejects('design-system', (d) => { d.type.ramp[0].weight = 1000; }, 'above maximum 900');
});

test('motion durations are bounded and the reduced-motion answer is a token-level field', async () => {
	await rejects('design-system', (d) => { d.motion.durations.standard.value = 1500; }, 'above maximum 1000');
	await rejects('design-system', (d) => delete d.motion.curves, 'curves is required');
	await rejects('design-system', (d) => { d.haptics['paywall.completed'].value = 'buzz'; }, 'must be one of');
	await rejects('design-system', (d) => { d.haptics['paywall.exploded'] = { value: 'success', cite: 'HIG:x' }; }, 'not a known property');
});

test('a ux screen declares route, flow and the states it must render', async () => {
	await rejects('ux-spec', (d) => { d.screens[0].route = 'paywall'; }, 'does not match');
	await rejects('ux-spec', (d) => { d.screens[0].states = []; }, 'at least 1');
	await rejects('ux-spec', (d) => { d.screens[0].states = ['default', 'default']; }, 'duplicate');
	await rejects('ux-spec', (d) => { d.screens[0].states = ['sad']; }, 'must be one of');
	await rejects('ux-spec', (d) => { d.screens[0].flow = 'onboarding'; }, 'must be one of');
});

test('a selling screen carries the RevenueCat ids ship rc audit checks', async () => {
	await rejects('ux-spec', (d) => delete d.screens[0].monetization.entitlement, 'entitlement is required');
	await rejects('ux-spec', (d) => { d.screens[0].monetization.offering = ''; }, 'shorter than 1');
	const free = clone(ARTIFACTS['ux-spec']);
	delete free.screens[0].monetization;
	assert.deepEqual(await checkArtifact('ux-spec', free, 'ux.json'), [], 'a screen that does not sell needs no offering');
});

test('ux analytics events use the shared flow and verb vocabulary', async () => {
	await rejects('ux-spec', (d) => { d.screens[0].events[0].verb = 'clicked'; }, 'must be one of');
	await rejects('ux-spec', (d) => { d.screens[0].events[0].name = 'PaywallViewed'; }, 'does not match');
});

test('a qa check declares the tier that can prove it', async () => {
	await rejects('qa-report', (d) => delete d.checks[0].requiresTier, 'requiresTier is required');
	await rejects('qa-report', (d) => { d.checks[0].requiresTier = 3; }, 'above maximum 2');
	await rejects('qa-report', (d) => { d.checks[0].status = 'OK'; }, 'must be one of');
	await rejects('qa-report', (d) => { d.checks[0].category = 'vibes'; }, 'must be one of');
	await rejects('qa-report', (d) => { d.summary = { pass: 1 }; }, 'is required');
});

test('the qa report is per-version and never empty', async () => {
	await rejects('qa-report', (d) => { d.checks = []; }, 'at least 1');
	await rejects('qa-report', (d) => { d.version = ''; }, 'shorter than 1');
	await rejects('qa-report', (d) => { d.tier = 2.5; }, 'expected integer');
});

test('schema descriptions survive round-tripping through the loader cache', async () => {
	const first = await loadSchema('ux-spec');
	assert.equal(first, await loadSchema('ux-spec'), 'the loader should cache, not re-read');
});

test('every artifact schema refuses an unknown top-level key', async () => {
	for (const name of ARTIFACT_NAMES) {
		const doc = clone(ARTIFACTS[name]);
		doc.somethingInvented = true;
		const issues = await checkArtifact(name, doc, `${name}.json`);
		assert.ok(issues.some((i) => i.includes('not a known property')), `${name} accepted an invented key`);
	}
});

test('every artifact schema keeps its underscore annotation escape hatch', async () => {
	for (const name of ARTIFACT_NAMES) {
		const doc = clone(ARTIFACTS[name]);
		doc._why = 'a note beside the data it explains';
		assert.deepEqual(await checkArtifact(name, doc, `${name}.json`), [], name);
	}
});

test('every artifact schema tolerates the $schema key an editor writes', async () => {
	for (const name of ARTIFACT_NAMES) {
		const doc = clone(ARTIFACTS[name]);
		doc.$schema = `../../schema/${name}.schema.json`;
		assert.deepEqual(await checkArtifact(name, doc, `${name}.json`), [], name);
	}
});

test('the raw schemas are themselves well-formed enough to validate against', async () => {
	for (const name of SCHEMAS) {
		const raw = await readFile(new URL(`../schema/${name}.schema.json`, import.meta.url), 'utf8');
		assert.ok(raw.endsWith('\n'), `${name} needs a trailing newline`);
		assert.deepEqual(validate({ type: 'object', required: ['$id', 'title'] }, JSON.parse(raw)), [], name);
	}
});
