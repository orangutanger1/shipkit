// Keyword scoring primitives: candidate filtering, demand blending, and the
// competition/commodity/saturation heuristics `aso.mjs` fuses into a viability
// ranking. These are unit-level because the arms below are numeric edge cases
// (a missing storefront field, an empty result page) that a full command run
// would only exercise by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capture } from './fixtures/cmd.mjs';
import {
	pickCandidates,
	demand,
	demandTable,
	commodity,
	saturation,
	score,
	scoreAll,
	brandCollisions,
	packKeywords,
	progressLine,
} from '../src/lib/appstore-score.mjs';

test('pickCandidates drops a brand name matched by the exclude list', () => {
	// exclude is how a project keeps its own app name out of its harvested
	// keyword pool; without a real regex built from it, brand noise would be
	// scored as if it were an opportunity.
	const out = pickCandidates(['glovebox log', 'car maintenance log'], { exclude: ['glovebox'] });
	assert.deepEqual(out, ['car maintenance log']);
});

test('pickCandidates drops blank, ampersand/colon, and app-suffix terms', () => {
	const out = pickCandidates(['   ', 'salt & pepper', 'recipes: easy', 'todo app', 'car log'], {});
	assert.deepEqual(out, ['car log']);
});

test('demand falls back to seed count alone for a legacy string[] entry with no rank', () => {
	// The legacy artifact shape carries no rank at all, so `rankOf` returns
	// null and `demand` has to still order terms by how many seeds surfaced them.
	const many = demand(['a', 'b', 'c']);
	const none = demand([]);
	assert.ok(many > none);
});

test('demandTable defaults a missing terms map to an empty harvest', () => {
	assert.deepEqual(demandTable(undefined), new Map());
});

test('demandTable ignores an analytics row with no term, rather than crashing on it', () => {
	// A malformed or partial `-terms.json` row should not stop every other
	// term in the file from getting its measured demand.
	const terms = { 'car log': { seeds: ['car log'], rank: 1 } };
	const table = demandTable(terms, { analytics: { rows: [{ impressions: 50 }, { term: 'car log', impressions: 100 }] } });
	assert.equal(table.get('car log').demand, 100);
});

test('demandTable reads a volume entry from the object shape as well as the bare-number shape', () => {
	const terms = { 'car log': { seeds: ['car log'], rank: 1 } };
	const table = demandTable(terms, { volume: { terms: { 'car log': { popularity: 40, difficulty: 12 } } } });
	assert.equal(table.get('car log').demand, 40);
	assert.equal(table.get('car log').difficulty, 12);
});

test('commodity returns null when the storefront returned no results', () => {
	assert.equal(commodity(null, { term: 'car log' }), null);
	assert.equal(commodity([], { term: 'car log' }), null);
});

test('commodity treats a row with no title or rating count as an unmatched, ratingless app', () => {
	// iTunes omits fields it has no value for; a row missing both should not
	// throw and should not count toward `proven`.
	const out = commodity([{}], { term: 'car log', tractionFloor: 1 });
	assert.equal(out.matches, 0);
	assert.equal(out.proven, 0);
});

test('saturation returns null when the storefront returned no results', () => {
	assert.equal(saturation(null, { term: 'car log' }), null);
	assert.equal(saturation([], { term: 'car log' }), null);
});

test('saturation treats a row missing name, seller, ratings and release date as undated and unmatched', () => {
	const out = saturation([{}], { term: 'car log' });
	assert.equal(out.dated, 0);
	assert.equal(out.apps[0].name, null);
	assert.equal(out.apps[0].seller, null);
	assert.equal(out.apps[0].ratings, 0);
	assert.equal(out.apps[0].titleMatch, false);
});

test('saturation with no term never claims a title match', () => {
	// needle is '' when term is omitted; a blank needle would otherwise
	// `.includes('')` every title and inflate cloneShare for free.
	const out = saturation([{ trackName: 'Anything', releaseDate: '2024-01-01' }], {});
	assert.equal(out.apps[0].titleMatch, false);
});

test('score returns null when the storefront returned no results', () => {
	assert.equal(score('car log', null), null);
	assert.equal(score('car log', []), null);
});

test('score tolerates a row with no title, rating count or price', () => {
	const out = score('car log', [{}], { demand: 50 });
	assert.equal(out.exactTitleMatches, 0);
	assert.equal(out.weakAppsTop10, 1);
	assert.equal(out.paidTop10, 0);
	assert.equal(out.top3[0].ratings, 0);
});

/** Swap `globalThis.fetch` for the duration of `fn`, always restoring it. */
async function withFetch(handler, fn) {
	const real = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = real;
	}
}

test('scoreAll reads a bare-number demand from a plain-object demands map', async () => {
	// aso.mjs passes `demands` as a plain object (from demandTable via
	// Object.fromEntries or a hand-built map), not a Map — demandOf has to
	// read both shapes, and a bare number (not a DemandRow) is what a caller
	// gives it directly.
	const results = [{ trackName: 'Car Log', userRatingCount: 5 }];
	const out = await withFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results }) }),
		() => scoreAll(['car log'], { country: 'us', lang: 'en' }, { demands: { 'car log': 10 } }),
	);
	assert.equal(out[0].demand, 10);
});

test('scoreAll reads a DemandRow object out of a Map, and reports progress with the score', async () => {
	const results = [{ trackName: 'Car Log', userRatingCount: 5 }];
	const seen = [];
	const out = await withFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results }) }),
		() =>
			scoreAll(['car log'], { country: 'gb', lang: 'en' }, {
				demands: new Map([['car log', { demand: 30, source: 'volume' }]]),
				onProgress: (...args) => seen.push(args),
			}),
	);
	assert.equal(out[0].demand, 30);
	assert.equal(seen.length, 1);
	assert.equal(seen[0][3], out[0].viability);
});

test('scoreAll scores a term with no demand supplied at all', async () => {
	// aso.mjs's `--terms` path can run without a demand table (no analytics,
	// no volume file, no autocomplete rank yet) — demandOf then returns
	// undefined, and score() must fall back to its own 100 default rather
	// than receiving an explicit option object with a bogus `demand` key.
	const results = [{ trackName: 'Car Log', userRatingCount: 5 }];
	const out = await withFetch(
		async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results }) }),
		() => scoreAll(['car log'], { country: 'de', lang: 'en' }, {}),
	);
	assert.equal(out[0].demand, 100);
});

test('brandCollisions returns no rows for a blank name', () => {
	assert.deepEqual(brandCollisions('   ', [{ trackName: 'Anything' }]), []);
});

test('brandCollisions defaults a missing results list to an empty search', () => {
	assert.deepEqual(brandCollisions('glovebox', null), []);
	assert.deepEqual(brandCollisions('glovebox', undefined), []);
});

test('brandCollisions tolerates a matching row missing every optional field', () => {
	const out = brandCollisions('glovebox', [{ trackName: 'Glovebox' }]);
	assert.equal(out.length, 1);
	assert.equal(out[0].id, null);
	assert.equal(out[0].seller, null);
	assert.equal(out[0].ratings, 0);
	assert.equal(out[0].released, null);
	assert.equal(out[0].url, null);
	assert.equal(out[0].exact, true);
});

test('brandCollisions skips a row with no title, and reports no id for a matching one with none', () => {
	// A row with no trackName can never match the bounded regex and must not
	// throw building the (empty) title; a row that does match but has no
	// trackId — a storefront quirk seen on delisted apps — still reports.
	const out = brandCollisions('glovebox', [{}, { trackName: 'Glovebox App', trackId: undefined }]);
	assert.equal(out.length, 1);
	assert.equal(out[0].id, null);
});

test('progressLine shows the percentage, and the arrow only when there is something to point at', async () => {
	// A sweep prints one of these per term. The arrow suffix is what carries the
	// result, so a call with nothing to report must not print an empty arrow.
	const { out: bare } = await capture(() => progressLine(1, 4, 'car log'));
	assert.match(bare, /\[ 25%\] car log/);
	assert.doesNotMatch(bare, /→/);
	const { out: withExtra } = await capture(() => progressLine(4, 4, 'car log', '18 results'));
	assert.match(withExtra, /\[100%\] car log → 18 results/);
});
