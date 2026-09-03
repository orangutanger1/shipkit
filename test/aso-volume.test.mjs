// Measured popularity out of the Apple Ads keyword-suggestion endpoint.
// The payloads below are real responses captured from a live ad account on
// 2026-09-03, trimmed to twelve rows; the grammar assertions pin the three
// things this endpoint does that no other v1 `/query` does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { POPULARITY_FLOOR, suggestionRows, suggestionsBody } from '../src/lib/ads-v1.mjs';
import { collectPopularity, volumeTerms } from '../src/lib/aso-volume.mjs';
import { v1Suggestions } from '../src/lib/ads-http.mjs';

/** "car care" — a seed Apple has real data for, and its expansion. */
const CAR_CARE = {
	result: [
		{ text: 'carfax', popularity: 31 },
		{ text: 'car maintenance tracker', popularity: 27 },
		{ text: 'car care', popularity: 26 },
		{ text: 'carfax car care', popularity: 17 },
		{ text: 'car maintenance', popularity: 14 },
		{ text: 'carfax care', popularity: 12 },
		{ text: 'vin check', popularity: 12 },
		{ text: 'car fax', popularity: 12 },
		{ text: 'car fox', popularity: 9 },
		{ text: 'carfax canada car care', popularity: 9 },
		{ text: 'carcare', popularity: 8 },
		{ text: 'car maintenance log', popularity: 8 },
	],
	pagination: { offset: 0, pageSize: 12, totalCount: 19 },
	error: null,
};

/** The same term asked about directly: Apple echoes it back at the floor. */
const CAR_MAINTENANCE_LOG = {
	result: [{ text: 'car maintenance log', popularity: 5 }],
	pagination: { offset: 0, pageSize: 12, totalCount: 1 },
	error: null,
};

/** What a scalar `value` earns. The complaint names no field, which is why the
 * array rule is a comment in ads-v1.mjs rather than something to rediscover. */
const SCALAR_REJECTED = {
	result: null,
	pagination: null,
	error: { code: 'VALIDATION_ERROR', message: 'Request body is not readable', details: [{ code: 'REQUEST_INVALID', message: 'Request body is not readable', info: null }] },
};

test('suggestionsBody sends every filter value as an array', () => {
	const body = suggestionsBody({ adamId: 6797103341, term: 'car care', countries: ['US'] });
	const filters = /** @type {any[]} */ (body.filters);
	for (const f of filters) assert.ok(Array.isArray(f.value), `${f.field} must carry an array`);
	assert.deepEqual(filters[0], { field: 'promotedObjectId', operator: 'EQUALS', value: ['6797103341'] });
	assert.deepEqual(filters[1], { field: 'promotedObjectType', operator: 'EQUALS', value: ['APPSTORE_APP'] });
});

test('suggestionsBody omits terms and countries when it has none', () => {
	const filters = /** @type {any[]} */ (suggestionsBody({ adamId: 1 }).filters);
	assert.equal(filters.length, 2);
	assert.deepEqual(suggestionsBody({ adamId: 1 }).pagination, { pageSize: 100, offset: 0 });
});

test('suggestionRows reads the captured payload and drops unusable rows', () => {
	const rows = suggestionRows(CAR_CARE);
	assert.equal(rows.length, 12);
	assert.deepEqual(rows[0], { text: 'carfax', popularity: 31 });
	assert.deepEqual(suggestionRows({ result: [{ text: '', popularity: 9 }, { text: 'x' }, { text: 'y', popularity: 3 }] }), [{ text: 'y', popularity: 3 }]);
	assert.deepEqual(suggestionRows(SCALAR_REJECTED), []);
});

test('v1Suggestions posts to the suggestions path and returns pairs', async () => {
	/** @type {any} */
	let sent = null;
	/** @type {any} */
	const doFetch = async (url, init) => {
		sent = { url, body: JSON.parse(init.body) };
		return { ok: true, status: 200, text: async () => JSON.stringify(CAR_CARE) };
	};
	const rows = await v1Suggestions({ adAccountId: 23259140, fetch: doFetch, token: async () => 't' }, { adamId: 6797103341, term: 'car care', countries: ['US'] });
	assert.equal(sent.url, 'https://api.ads.apple.com/v1/suggestions/keywords/query');
	assert.equal(sent.body.filters.length, 4);
	assert.equal(rows[2].popularity, 26);
});

test('collectPopularity reads only the row for the term it asked about', async () => {
	/** @type {string[]} */
	const asked = [];
	/** @param {string} term */
	const ask = async (term) => {
		asked.push(term);
		return suggestionRows(term === 'car care' ? CAR_CARE : CAR_MAINTENANCE_LOG);
	};
	// "car maintenance log" rides along in the first answer at 8, and is asked
	// about anyway: an expansion popularity is relative to its seed, so 8 and
	// the 5 a direct ask returns are not the same measurement.
	const out = await collectPopularity(['car care', 'car maintenance log'], ask, { concurrency: 1 });
	assert.deepEqual(asked, ['car care', 'car maintenance log']);
	assert.equal(out.calls, 2);
	assert.equal(out.found.get('car care'), 26);
	assert.equal(out.found.get('car maintenance log'), 5);
	assert.deepEqual(out.unanswered, []);
	assert.deepEqual(out.overBudget, []);
});

test('collectPopularity ignores expansion rows for terms it did not ask about', async () => {
	/** @param {string} term */
	const ask = async (term) => suggestionRows(term === 'car care' ? CAR_CARE : { result: [] });
	const out = await collectPopularity(['car care'], ask, { concurrency: 1 });
	assert.deepEqual([...out.found.keys()], ['car care']);
});

test('collectPopularity normalises case and de-duplicates the ask list', async () => {
	/** @type {string[]} */
	const asked = [];
	/** @param {string} term */
	const ask = async (term) => {
		asked.push(term);
		return [{ text: term.toUpperCase(), popularity: 40 }];
	};
	const out = await collectPopularity(['  Car Care ', 'car care', '', 'vin check'], ask, { concurrency: 4 });
	assert.deepEqual(asked, ['car care', 'vin check']);
	assert.deepEqual(out.wanted, ['car care', 'vin check']);
	assert.equal(out.found.get('car care'), 40);
});

test('collectPopularity stops at the call budget and names what it never asked', async () => {
	/** @param {string} term */
	const ask = async (term) => [{ text: term, popularity: 20 }];
	const out = await collectPopularity(['a', 'b', 'c', 'd', 'e'], ask, { max: 3, concurrency: 2 });
	assert.equal(out.calls, 3);
	assert.deepEqual(out.overBudget, ['d', 'e']);
	assert.deepEqual(out.unanswered, []);
});

test('collectPopularity counts a term Apple answered nothing about as unmeasured', async () => {
	/** @param {string} term */
	const ask = async (term) => (term === 'a' ? [{ text: 'a', popularity: 30 }] : []);
	const out = await collectPopularity(['a', 'b'], ask, { concurrency: 2 });
	assert.equal(out.calls, 2);
	assert.deepEqual(out.unanswered, ['b']);
	assert.deepEqual(out.overBudget, []);
});

test('collectPopularity reports progress per batch', async () => {
	/** @type {number[]} */
	const seen = [];
	/** @param {string} term */
	const ask = async (term) => [{ text: term, popularity: 20 }];
	/** @param {number} done */
	const onProgress = (done) => seen.push(done);
	await collectPopularity(['a', 'b', 'c'], ask, { concurrency: 2, onProgress });
	assert.deepEqual(seen, [2, 3]);
});

test('volumeTerms drops the floor and keeps only terms we asked about', () => {
	const found = new Map([
		['car care', 26],
		['car maintenance log', POPULARITY_FLOOR],
		['carfax', 31],
	]);
	const { terms, floor } = volumeTerms(found, ['car care', 'car maintenance log', 'never answered']);
	// `carfax` was never asked about, so it never belongs in volume.json even
	// though the collection carries a number for it.
	assert.deepEqual(Object.keys(terms), ['car care']);
	assert.deepEqual(terms['car care'], { popularity: 26 });
	assert.deepEqual(floor, ['car maintenance log']);
});

test('volumeTerms treats a below-floor reading as no reading', () => {
	const { terms, floor } = volumeTerms(new Map([['a', 4]]), ['a']);
	assert.deepEqual(terms, {});
	assert.deepEqual(floor, ['a']);
});
