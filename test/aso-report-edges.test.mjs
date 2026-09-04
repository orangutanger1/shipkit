// The pure half of `ship aso`: seed resolution, the volume importer's several
// input shapes, the packed proposal, and the projections the report renders
// from. Each is called directly with the degenerate inputs a real artifact
// eventually turns out to have.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	auditFindings, byLength, competitorRows, competitorVocabulary, keywordLintFindings,
	mergeDemands, normaliseVolume, packedProposal, reporter, scoredTerms, seedsFor,
	sourceLocale, tagNames, topCompetitorIds,
} from '../src/lib/aso-report.mjs';

const cfg = (over = {}) => ({
	name: 'Demo', file: '/tmp/demo/ship.config.json',
	asc: { primaryLocale: 'en-US' }, loc: {}, aso: {},
	...over,
});

test('byLength sorts short first, then alphabetically', () => {
	assert.deepEqual(['bb', 'a', 'ab'].sort(byLength), ['a', 'ab', 'bb']);
});

test('scored terms are read from either artifact shape, or none', () => {
	assert.deepEqual(scoredTerms({ terms: [1] }), [1]);
	assert.deepEqual(scoredTerms({ scored: [2] }), [2]);
	assert.deepEqual(scoredTerms(null), []);
});

test('mergeDemands annotates only the terms it has a row for', () => {
	const scored = [{ keyword: 'a' }, { keyword: 'b' }];
	mergeDemands(scored, new Map([['a', { source: 'volume.json', difficulty: 42 }], ['c', { source: 'x' }]]));
	assert.deepEqual(scored[0], { keyword: 'a', demandSource: 'volume.json', difficulty: 42 });
	assert.deepEqual(scored[1], { keyword: 'b' }, 'a term with no measurement keeps none');

	const noDifficulty = [{ keyword: 'a' }];
	mergeDemands(noDifficulty, new Map([['a', { source: 'autocomplete' }]]));
	assert.equal(noDifficulty[0].difficulty, undefined);
});

test('the source locale is the authored one, whichever field names it', () => {
	assert.equal(sourceLocale(cfg()), 'en-US');
	assert.equal(sourceLocale(cfg({ loc: { sourceLocale: 'de-DE' } })), 'de-DE');
});

test('seeds fall back to the staged listing, and say so when there is nothing at all', async () => {
	const listing = { locale: 'en-US', data: { name: 'Glovebox', subtitle: 'Car maintenance log' } };
	const fromListing = await seedsFor(cfg(), 'en-US', {}, async () => listing);
	assert.equal(fromListing.origin, 'staged en-US name + subtitle');
	assert.ok(fromListing.seeds.length);

	const nothing = await seedsFor(cfg(), 'en-US', {}, async () => null);
	assert.equal(nothing.origin, 'nothing');
	assert.deepEqual(nothing.seeds, []);
});

test('a no-space language keeps the short tokens every other market drops', async () => {
	const listing = { locale: 'ja-JP', data: { name: '家計簿 アプリ', subtitle: '記録' } };
	const ja = await seedsFor(cfg(), 'ja-JP', {}, async () => listing);
	assert.ok(ja.seeds.length, 'two-character Japanese words are whole words, not stop words');
});

test('--seeds wins over everything and counts as a cross-language sweep', async () => {
	const out = await seedsFor(cfg({ aso: { seeds: ['ignored'] } }), 'de-DE', { seeds: ' a , b ,, ' }, async () => null);
	assert.deepEqual(out.seeds, ['a', 'b']);
	assert.equal(out.origin, '--seeds');
	assert.equal(out.mismatch, true, 'English seeds pointed at a German storefront is the mistake this flags');
});

test('the volume importer reads a bare map, a rows array, and a wrapped result', () => {
	assert.equal(normaliseVolume({ 'oil change': 62 }, 'en-US').terms['oil change'].popularity, 62);
	assert.equal(normaliseVolume({ terms: { 'oil change': { popularity: 40 } } }, 'en-US').terms['oil change'].popularity, 40);
	assert.equal(
		normaliseVolume({ terms: [{ keyword: 'oil change', popularity: 30, difficulty: 12 }] }, 'en-US').terms['oil change'].difficulty,
		12,
	);
	assert.equal(normaliseVolume([{ keyword: 'oil change', popularity: 20 }], 'en-US').terms['oil change'].popularity, 20);
});

test('the volume importer clamps to Apple\'s 0-100 scale', () => {
	const clamped = normaliseVolume({ high: 500, low: -5 }, 'en-US').terms;
	assert.equal(clamped.high.popularity, 100);
	assert.equal(clamped.low.popularity, 0);
});

test('a packed proposal against an empty listing proposes everything and removes nothing', () => {
	const scored = [{ keyword: 'oil change', opportunity: 40, demand: 50 }, { keyword: 'service log', opportunity: 30, demand: 40 }];
	const p = packedProposal(scored, {}, 'en-US', 0);
	assert.equal(p.current, '');
	assert.ok(p.keywords.length);
	assert.deepEqual(p.removed, []);

	const empty = packedProposal([], { name: 'Demo', keywords: 'kept' }, 'en-US', 0);
	assert.equal(empty.keywords, '');
	assert.deepEqual(empty.removed, ['kept']);
});

test('competitor ids stop at the cap, and skip apps with no id', () => {
	const scored = [{ top3: [{ id: 1 }, { noId: true }] }, { top3: [{ id: 2 }, { id: 3 }] }, { top3: [{ id: 4 }] }];
	assert.deepEqual(topCompetitorIds(scored), ['1', '2', '3']);
	assert.deepEqual(topCompetitorIds([{}]), [], 'a term with no top-3 block contributes nothing');
});

test('competitor rows and vocabulary tolerate apps missing every optional field', () => {
	const rows = competitorRows([{ trackId: 1 }]);
	assert.deepEqual({ ratings: rows[0].ratings, price: rows[0].price }, { ratings: 0, price: 0 });
	assert.deepEqual(competitorVocabulary([{}], 'en-US'), []);
});

test('tag names are read from whichever field asc used, and blanks are dropped', () => {
	assert.deepEqual(tagNames([{ name: 'a' }, { displayName: 'b' }, { attributes: { name: 'c' } }, { id: 'd' }, {}]), ['a', 'b', 'c', 'd']);
});

test('audit findings default to a warning, and name themselves from whatever the row carries', () => {
	assert.deepEqual(auditFindings([{ severity: 'ERROR', field: 'keywords', detail: 'too long' }]), [
		{ level: 'fail', name: 'asc keywords', detail: 'too long' },
	]);
	assert.deepEqual(auditFindings([{ status: 'mystery' }]), [{ level: 'warn', name: 'asc keywords', detail: '{"status":"mystery"}' }]);
});

test('a clean keyword field is reported as clean, with its length', () => {
	// A full field with no repeats and nothing already indexed by the name.
	const staged = [{ locale: 'en-US', file: 'x', data: { locale: 'en-US', name: 'Glovebox', subtitle: 'Keep it running', keywords: 'oil change,service log,mileage,repair history,garage notes,fuel economy,car care' } }];
	const [row] = keywordLintFindings(staged);
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /\/100 chars/);
});

test('progress reporting is silenced by --json, because --json owns stdout', () => {
	assert.equal(reporter({ json: true }), undefined);
	assert.equal(typeof reporter({}), 'function');
});

// ── the printed views ───────────────────────────────────────────────────────
// Rendering is where a sparse artifact turns into a crash or a blank column,
// so each view is asked to render one that is missing every optional field.

const { capture } = await import('./fixtures/cmd.mjs');
const view = await import('../src/lib/aso-report.mjs');

const rendered = async (fn) => (await capture(fn)).out;

test('the harvest view names the overflow, and an empty sweep as throttling', async () => {
	const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`term ${i}`, { seeds: ['s'] }]));
	assert.match(await rendered(() => view.printHarvest({ locale: 'en-US', file: 'f', terms: many })), /5 more/);
	assert.match(await rendered(() => view.printHarvest({ locale: 'en-US', file: 'f', terms: {} })), /Apple may be throttling/);
});

test('the volume view renders a term with no popularity, no difficulty, and both budget notes', async () => {
	const out = await rendered(() =>
		view.printVolume({
			locale: 'en-US', file: 'f', imported: 1, source: 'Apple Ads',
			artifact: { terms: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, {}])) },
			floor: ['t1'], overBudget: ['t2'], wanted: 30,
		}),
	);
	assert.match(out, /… 5 more/);
	assert.match(out, /sit at Apple's floor/);
	assert.match(out, /never asked about/);
});

test('the volume view renders an artifact with no terms block at all', async () => {
	assert.ok(await rendered(() => view.printVolume({ locale: 'en-US', file: 'f', imported: 0, source: null, artifact: {} })));
});

test('the score view marks a measured demand and tolerates a term with no competitor', async () => {
	const out = await rendered(() =>
		view.printScore({
			locale: 'en-US', file: 'f', count: 2,
			scored: [
				{ keyword: 'a', demand: 50, demandSource: 'volume.json', competition: 1, opportunity: 2, viability: 3, results: 10, medianRatings: 100, exactTitleMatches: 0, top3: [{ name: 'Rival' }] },
				{ keyword: 'b', demand: 10, demandSource: 'rank', competition: 1, opportunity: 2, viability: 3, results: 10, medianRatings: 100, exactTitleMatches: 0 },
			],
		}),
	);
	assert.match(out, /50\*/, 'a measured demand is starred; an autocomplete rank is not');
	assert.match(out, /Rival/);
});

test('the proposal view renders an empty field, a full one, and what it dropped', async () => {
	const empty = await rendered(() => view.printProposal({ locale: 'en-US', name: 'Demo', subtitle: '', current: '', keywords: '', used: 0, limit: 100, added: [], removed: [], kept: [], covered: [] }));
	assert.match(empty, /\(empty\)/);

	const full = await rendered(() => view.printProposal({ locale: 'en-US', name: 'Demo', subtitle: '', current: 'a', keywords: 'x'.repeat(100), used: 100, limit: 100, added: ['x'], removed: [], kept: [], covered: ['name word'] }));
	assert.match(full, /full/);
	assert.match(full, /already indexed by name\/subtitle/);
});

test('the competitor view renders an app that carries nothing but its ratings', async () => {
	const out = await rendered(() =>
		view.printCompetitors({ locale: 'en-US', market: { country: 'US' }, ids: [1], apps: [{ ratings: 0 }], vocabulary: [{ apps: 2, word: 'log' }], file: 'f' }),
	);
	assert.match(out, /free/);
	assert.match(out, /2× log/);
});
