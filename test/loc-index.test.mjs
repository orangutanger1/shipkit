// The artifact readers behind `ship loc`. Everything here reads a file another
// command wrote — sometimes a version of that command from six months ago — so
// the shapes below are not hypothetical: they are what is on disk in repos that
// have been through a rename. Research is expensive; a reader that quietly
// returns nothing costs a re-run of the whole harvest.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repo } from './fixtures/cmd.mjs';
import { loadConfig } from '../src/config.mjs';
import {
	analyticsIndex,
	brandNouns,
	competitorIds,
	harvestIndex,
	mineSeeds,
	order,
	probeTerms,
	productNouns,
	provenanceFor,
	scoredTerms,
} from '../src/lib/loc-index.mjs';

/** A repo with whatever artifacts the case needs, and its loaded config. */
async function locRepo(files = {}) {
	const dir = await repo({ config: { name: 'Glovebox', bundleId: 'com.demo.app' }, prefix: 'ship-loc-idx-' });
	for (const [rel, body] of Object.entries(files)) {
		await mkdir(join(dir, rel, '..'), { recursive: true });
		await writeFile(join(dir, rel), JSON.stringify(body));
	}
	return loadConfig(dir);
}

// ─── staged file key order ──────────────────────────────────────────────────

test('a staged file is re-keyed so a regenerated draft diffs against the last one', () => {
	const out = order({ notes: 'n', name: 'App', locale: 'de-DE', custom: 1, subtitle: 's' });
	assert.deepEqual(Object.keys(out), ['locale', 'name', 'subtitle', 'notes', 'custom'],
		'known fields in order, then anything else, kept rather than dropped');
});

test('a field explicitly cleared to null keeps its place in the order', () => {
	// `null` means a human cleared the field, and a cleared subtitle has to
	// survive the round trip in the slot the order gives it.
	const out = order({ notes: 'n', subtitle: null, name: 'App' });
	assert.deepEqual(Object.keys(out), ['name', 'subtitle', 'notes']);
	assert.equal(out.subtitle, null);
});

// ─── scored.json, across the rename ─────────────────────────────────────────

test('scored terms are read from both the current and the pre-rename envelope', async () => {
	const now = await locRepo({ 'aso/en-US/scored.json': { terms: [{ term: 'car log', opportunity: 40 }] } });
	assert.deepEqual(await scoredTerms(now, 'en-US'), [{ term: 'car log', opportunity: 40 }]);
	const old = await locRepo({ 'aso/en-US/scored.json': { scored: [{ term: 'car log', opportunity: 40 }] } });
	assert.deepEqual(await scoredTerms(old, 'en-US'), [{ term: 'car log', opportunity: 40 }]);
});

test('a scored entry may be a bare string, or name its term as `keyword`', async () => {
	const cfg = await locRepo({
		'aso/en-US/scored.json': { terms: ['car log', { keyword: 'fuel log' }, { opportunity: 9 }] },
	});
	assert.deepEqual(await scoredTerms(cfg, 'en-US'), [
		{ term: 'car log', opportunity: 0 },
		{ term: 'fuel log', opportunity: 0 },
	], 'an entry with no term at all is dropped rather than becoming undefined');
});

test('no scored file at all is no terms', async () => {
	assert.deepEqual(await scoredTerms(await locRepo(), 'en-US'), []);
});

// ─── the harvest and analytics indexes ──────────────────────────────────────

test('the harvest index reads both artifact shapes, and is absent when the file is', async () => {
	const cfg = await locRepo({ 'aso/en-US/candidates.json': { terms: { 'car log': { seeds: [], rank: 1 }, 'fuel log': ['fuel'] } } });
	const index = await harvestIndex(cfg, 'en-US');
	assert.equal(index.terms, 2, 'only the keys matter, so the old array-valued shape reads the same');
	assert.ok(index.index.has('car log') && index.index.has('fuel'),
		'the phrase and its words are both indexed, so a packed single word still matches');
	assert.equal(await harvestIndex(await locRepo(), 'en-US'), null);
	assert.equal((await harvestIndex(await locRepo({ 'aso/en-US/candidates.json': {} }), 'en-US')).terms, 0);
});

test('the analytics index is absent when nobody has pulled the report', async () => {
	assert.equal(await analyticsIndex(await locRepo(), 'en-US'), null);
	const empty = await analyticsIndex(await locRepo({ '.asc/analytics/en-US-terms.json': {} }), 'en-US');
	assert.equal(empty.terms, 0, 'a report with no rows is an empty index, not a missing one');
});

// ─── what to probe a foreign storefront with ────────────────────────────────

test('probe terms come from the research when there is any, best opportunity first', async () => {
	const cfg = await locRepo({
		'aso/en-US/scored.json': { terms: [{ term: 'fuel log', opportunity: 10 }, { term: 'car log', opportunity: 90 }] },
	});
	assert.deepEqual(await probeTerms(cfg, 'en-US', {}, 5), ['car log', 'fuel log']);
});

test('with no research, the listing keywords stand in — minus the ones nobody finished', async () => {
	const cfg = await locRepo();
	const data = { keywords: 'car log,TODO(de-DE) fill me,fuel' };
	assert.deepEqual(await probeTerms(cfg, 'en-US', data, 5), ['car log', 'fuel']);
	assert.deepEqual(await probeTerms(cfg, 'en-US', data, 1), ['car log'], 'the limit is respected');
});

test('with neither research nor keywords, the name and subtitle are mined for words', async () => {
	// The last resort. Short words and stopwords are dropped, because probing a
	// storefront for "the" answers with the whole storefront.
	const cfg = await locRepo();
	const out = await probeTerms(cfg, 'en-US', { name: 'Glovebox the car log', subtitle: 'Service history' }, 10);
	assert.ok(out.includes('glovebox') && out.includes('service') && out.includes('history'));
	assert.ok(!out.includes('the') && !out.includes('car'), 'stopwords and short words are not probes');
	assert.deepEqual(await probeTerms(cfg, 'en-US', {}, 10), [], 'a listing with nothing in it yields nothing');
});

// ─── competitors ────────────────────────────────────────────────────────────

test('competitor ids are collected from every scored row, skipping the unusable ones', async () => {
	const cfg = await locRepo({
		'aso/en-US/scored.json': {
			terms: [
				{ term: 'car log', top3: [{ id: 111 }, { id: 111 }, { name: 'no id' }, null] },
				'a bare string row',
				null,
				{ term: 'fuel log', top3: [{ id: 222 }] },
				{ term: 'no top3' },
			],
		},
	});
	assert.deepEqual(await competitorIds(cfg, 'en-US'), [111, 222], 'ids are deduplicated across terms');
	assert.deepEqual(await competitorIds(await locRepo(), 'en-US'), []);

	const old = await locRepo({ 'aso/en-US/scored.json': { scored: [{ term: 'car log', top3: [{ id: 333 }] }] } });
	assert.deepEqual(await competitorIds(old, 'en-US'), [333], 'the pre-rename envelope is read too');
});

test('a language that does not space its words is tokenised and joined without one', () => {
	// Japanese incumbents share two-character nouns, and a bigram joined with a
	// space would be a phrase no Japanese user ever types.
	const out = mineSeeds({
		titles: ['家計簿 節約', '家計簿 節約 管理', '家計簿 節約 アプリ'],
		glossary: {},
		locale: 'ja-JP',
		exclude: [],
		extra: [],
		top: 8,
	});
	assert.ok(out.seeds.includes('家計節約'), 'the shared bigram is joined with no separator');
	assert.ok(out.seeds.includes('節約'), 'and a two-character word is long enough to keep');
	assert.ok(out.seeds.every((s) => !s.includes(' ')), 'nothing carries a space a Japanese user would not type');
});

// ─── seeds for a foreign storefront ─────────────────────────────────────────

test('seeds come from the glossary first, then incumbent titles, then --seeds', async () => {
	// The order is the priority: an agreed translation beats a mined word, and a
	// human passing --seeds is adding to the pile rather than replacing it.
	const out = mineSeeds({
		titles: ['Fahrtenbuch: Auto Kosten', 'Auto Kosten Tracker', 'Spritverbrauch Auto Kosten'],
		glossary: { terms: { 'car log': { 'de-DE': 'Fahrtenbuch' } } },
		locale: 'de-DE',
		exclude: ['Tracker'],
		extra: ['tankbuch'],
		top: 8,
	});
	assert.equal(out.from.fahrtenbuch, 'glossary: car log', 'the glossary claims the term first');
	assert.match(out.from['auto kosten'], /top results \(3 apps\)/);
	assert.equal(out.from.tankbuch, '--seeds');
	assert.ok(!Object.keys(out.from).includes('tracker'), 'an excluded word is not mined');
});

test('a glossary with no entry for this locale contributes nothing', () => {
	const out = mineSeeds({
		titles: ['Fahrtenbuch Auto'],
		glossary: { terms: { 'car log': { 'fr-FR': 'Carnet' } } },
		locale: 'de-DE',
		exclude: [],
		extra: [],
		top: 8,
	});
	assert.ok(!Object.values(out.from).some((o) => o.startsWith('glossary')));
});

test('a word only one app uses is still offered when no word is shared', () => {
	// A market too small to have a shared noun still needs seeds; falling back
	// to the single-app words beats probing the storefront with nothing.
	const out = mineSeeds({ titles: ['Fahrtenbuch'], glossary: {}, locale: 'de-DE', exclude: [], extra: [], top: 8 });
	assert.match(out.from.fahrtenbuch, /top results \(1 app\)/, 'one app, singular');
});

test('a blank or already-seen seed is not pushed twice', () => {
	const out = mineSeeds({ titles: [], glossary: {}, locale: 'de-DE', exclude: [], extra: ['Tankbuch', 'tankbuch', '  ', ''], top: 8 });
	assert.deepEqual(out.seeds, ['tankbuch']);
});

// ─── what a translator must not touch, and what they must agree on ──────────

test('brand nouns are the app name plus the capitalised words that are not sentence case', () => {
	// Sentence case makes the first word ambiguous — "Glovebox tracks your car"
	// starts with a capital because every sentence does — so it only counts when
	// it is the app's own name.
	const cfg = { name: 'Glovebox' };
	const out = brandNouns(cfg, { name: 'Glovebox for CarPlay', subtitle: 'Track every Service' });
	assert.ok(out.includes('Glovebox'));
	assert.ok(out.includes('CarPlay'));
	assert.ok(out.includes('Service'));
	assert.ok(!out.includes('Track'), 'a capitalised first word that is not the app name is sentence case');
	assert.ok(!out.includes('for'));
});

test('a token that is only punctuation is not a brand noun', () => {
	// A listing written as "Glovebox — Car log" leaves a bare dash as a token;
	// telling a translator not to translate "—" is noise in the one list they
	// have to read carefully.
	const out = brandNouns({ name: 'Glovebox' }, { name: 'Glovebox — Car log' });
	assert.deepEqual(out, ['Glovebox', 'Car']);
});

test('a repo with no configured name still reports the brand words in its listing', () => {
	const out = brandNouns({}, { name: 'Glovebox for CarPlay' });
	assert.deepEqual(out, ['CarPlay'], 'nothing to anchor the first word on, so it is not claimed');
});

test('product nouns are the whole field and the words worth agreeing on', () => {
	const out = productNouns({ name: 'Car maintenance log', subtitle: '' }, { locale: 'en', exclude: ['log'] });
	assert.ok(out.includes('Car maintenance log'), 'the phrase itself is a noun to agree on');
	assert.ok(out.includes('maintenance'));
	assert.ok(!out.includes('log'), 'an excluded word is not one to agree on');
	assert.ok(out.includes('car'), 'a three-letter noun is still a noun to agree on');
	assert.deepEqual(productNouns({}, { locale: 'en', exclude: [] }), []);
});

// ─── where each keyword's evidence came from ────────────────────────────────

test('a keyword is credited to the strongest evidence behind it', async () => {
	// `manual` is the one that matters: it means a human asserted the term and
	// nothing in the harvest or the analytics corroborates it.
	const harvest = await harvestIndex(await locRepo({ 'aso/en-US/candidates.json': { terms: { 'fuel economy': {} } } }), 'en-US');
	const analytics = await analyticsIndex(
		await locRepo({ '.asc/analytics/en-US-terms.json': { rows: [{ term: 'car log' }] } }),
		'en-US',
	);
	const out = provenanceFor(['car log', 'fuel economy', 'invented', 'TODO(de-DE) translate'], { harvest, analytics, locale: 'en' });
	assert.deepEqual(out, { 'car log': 'analytics', 'fuel economy': 'harvest', invented: 'manual' });
	assert.ok(!('TODO(de-DE) translate' in out), 'an unfinished draft term has no provenance to report yet');
});

test('with no artifacts at all every keyword is a human assertion', () => {
	assert.deepEqual(provenanceFor(['car log'], { harvest: null, analytics: null, locale: 'en' }), { 'car log': 'manual' });
});
