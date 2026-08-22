// The volume importer, which is the only place a real popularity number can enter
// the ASO pipeline.
//
// `demandTable` ranks a `volume` entry above the autocomplete-rank estimate, so
// whatever this parser accepts becomes the demand half of `opportunity` for every
// term it covers. That makes two properties load-bearing and both are pinned here:
// an unparseable row is dropped rather than defaulted (a fabricated 50 outranks
// real terms), and a saved Apple Ads Platform API v1 response imports with no
// hand-editing — the payloads below are copied from Apple's API preview guide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseVolume } from '../src/commands/aso.mjs';

test('normaliseVolume reads the hand-written and legacy shapes', () => {
	assert.deepEqual(normaliseVolume({ 'car maintenance log': 62 }, 'en-US').terms, {
		'car maintenance log': { popularity: 62 },
	});
	assert.deepEqual(normaliseVolume({ terms: { 'Service Reminder': { popularity: 41, difficulty: 30 } } }, 'en-US').terms, {
		'service reminder': { popularity: 41, difficulty: 30 },
	});
	assert.deepEqual(normaliseVolume([{ keyword: 'oil change', volume: 55 }], 'en-US').terms, {
		'oil change': { popularity: 55 },
	});
});

// POST /v1/suggestions/keywords/query — the per-term lookup, saved verbatim.
test('normaliseVolume imports a v1 keyword-suggestions response', () => {
	const payload = {
		result: [
			{ text: 'productivity app', popularity: 85 },
			{ text: 'task manager', popularity: 72 },
			{ text: 'to do list', popularity: 68 },
		],
		pagination: { offset: 0, pageSize: 20, totalCount: 3 },
	};
	assert.deepEqual(normaliseVolume(payload, 'en-US').terms, {
		'productivity app': { popularity: 85 },
		'task manager': { popularity: 72 },
		'to do list': { popularity: 68 },
	});
});

// POST /v1/insights/apps/search-term-popularity/query — double-wrapped in result.rows.
test('normaliseVolume imports a v1 search-term-popularity response on the 0-100 axis', () => {
	const payload = {
		result: {
			rows: [
				{ week: '2025-01-12', searchTerm: 'task manager', rankInGenre: 1, searchPopularityInGenre: 95, searchPopularity1to100: 88, searchPopularity1to5: 5 },
				{ week: '2025-01-12', searchTerm: 'calendar planner', rankInGenre: 3, searchPopularityInGenre: 76, searchPopularity1to100: 72, searchPopularity1to5: 4 },
			],
		},
		pagination: { offset: 0, pageSize: 20, totalCount: 2 },
		error: null,
	};
	const { terms } = normaliseVolume(payload, 'en-US');
	// searchPopularity1to100, not the 1-5 column: a 5 read as 0-100 would rank below
	// every rank-estimated candidate.
	assert.deepEqual(terms, {
		'task manager': { popularity: 88 },
		'calendar planner': { popularity: 72 },
	});
});

test('normaliseVolume falls back to the genre-relative column when the absolute one is absent', () => {
	const { terms } = normaliseVolume({ result: { rows: [{ searchTerm: 'to do list app', searchPopularityInGenre: 89 }] } }, 'en-US');
	assert.deepEqual(terms, { 'to do list app': { popularity: 89 } });
});

test('normaliseVolume keeps the newest week when a multi-week pull repeats a term', () => {
	// Deliberately out of chronological order: import order must not decide demand.
	const rows = [
		{ week: '2025-01-12', searchTerm: 'task manager', searchPopularity1to100: 88 },
		{ week: '2025-01-05', searchTerm: 'task manager', searchPopularity1to100: 40 },
		{ week: '2025-01-19', searchTerm: 'task manager', searchPopularity1to100: 91 },
		{ week: '2025-01-11', searchTerm: 'task manager', searchPopularity1to100: 12 },
	];
	assert.equal(normaliseVolume({ result: { rows } }, 'en-US').terms['task manager'].popularity, 91);
});

test('normaliseVolume drops unparseable rows instead of defaulting them', () => {
	const { terms } = normaliseVolume(
		{ result: [{ text: 'real term', popularity: 30 }, { text: 'no number' }, { popularity: 90 }, { text: '  ', popularity: 10 }] },
		'en-US',
	);
	assert.deepEqual(terms, { 'real term': { popularity: 30 } });
});

test('normaliseVolume clamps popularity to the 0-100 axis', () => {
	const { terms } = normaliseVolume([{ term: 'over', popularity: 140 }, { term: 'under', popularity: -3 }], 'en-US');
	assert.equal(terms.over.popularity, 100);
	assert.equal(terms.under.popularity, 0);
});
