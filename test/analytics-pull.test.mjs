// How `analytics pull` finds the reports Apple has produced.
//
// The fixture is a real `asc analytics view --request-id … --date …
// --include-segments` answer, captured 2026-09-03 and trimmed to three reports
// with the signed download URLs redacted. It is here because the payload's
// shape is the whole reason the old three-level walk found nothing: instance
// relationship listings carry no processingDate, and this one does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { REPORTS, daysBetween, segmentsOfView } from '../src/lib/analytics-api.mjs';

const VIEW = JSON.parse(await readFile(new URL('./fixtures/analytics-view-date.json', import.meta.url), 'utf8'));
const REQUEST = '841f7624-2233-43e8-ada1-48dbb755ed2c';

test('daysBetween covers an inclusive window', () => {
	assert.deepEqual(daysBetween('2026-08-28', '2026-08-31'), ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
	assert.deepEqual(daysBetween('2026-08-28', '2026-08-28'), ['2026-08-28']);
	assert.deepEqual(daysBetween('2026-08-29', '2026-08-28'), []);
});

test('daysBetween crosses a month boundary', () => {
	assert.deepEqual(daysBetween('2026-08-30', '2026-09-02'), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});

test('segmentsOfView reads every segment of every instance', () => {
	const segments = segmentsOfView(VIEW, { requestId: REQUEST });
	// The captured day carries a two-segment instance. Both must survive: one
	// segment per instance is exactly the assumption that lost data before.
	const downloads = segments.filter((s) => s.report === REPORTS.downloads);
	assert.equal(downloads.length, 2);
	assert.equal(new Set(downloads.map((s) => s.instance)).size, 1);
	assert.deepEqual(downloads.map((s) => s.id), ['7e055502-4a89-4ab1-a5ba-b1b5ce2ff023', '1e8517b6-a3bc-4a3b-b467-f6d2fe3f67d1']);
});

test('segmentsOfView carries the instance processingDate onto each segment', () => {
	for (const seg of segmentsOfView(VIEW, { requestId: REQUEST })) {
		assert.equal(seg.date, '2026-08-28');
		assert.equal(seg.requestId, REQUEST);
	}
});

test('segmentsOfView keeps only the reports asked for', () => {
	const only = segmentsOfView(VIEW, { requestId: REQUEST, wanted: new Set([REPORTS.installDelete]) });
	assert.deepEqual(only.map((s) => s.report), [REPORTS.installDelete]);
	assert.deepEqual(segmentsOfView(VIEW, { requestId: REQUEST, wanted: new Set(['No Such Report']) }), []);
});

test('segmentsOfView reads one granularity only', () => {
	// Apple publishes a DAILY *and* a WEEKLY instance under one processingDate.
	// Summing both counts the week on top of the day.
	const view = {
		data: [{
			name: REPORTS.engagement,
			instances: [
				{ id: 'day', processingDate: '2026-08-28', granularity: 'DAILY', segments: [{ id: 'd1' }] },
				{ id: 'week', processingDate: '2026-08-28', granularity: 'WEEKLY', segments: [{ id: 'w1' }] },
			],
		}],
	};
	assert.deepEqual(segmentsOfView(view, { requestId: REQUEST }).map((s) => s.id), ['d1']);
	assert.deepEqual(segmentsOfView(view, { requestId: REQUEST, granularity: 'WEEKLY' }).map((s) => s.id), ['w1']);
});

test('segmentsOfView tolerates the empty shapes Apple sends for a quiet day', () => {
	assert.deepEqual(segmentsOfView({ data: null }, { requestId: REQUEST }), []);
	assert.deepEqual(segmentsOfView(undefined, { requestId: REQUEST }), []);
	assert.deepEqual(segmentsOfView({ data: [{ name: REPORTS.downloads, instances: null }] }, { requestId: REQUEST }), []);
	assert.deepEqual(
		segmentsOfView({ data: [{ name: REPORTS.downloads, instances: [{ id: 'i', processingDate: '2026-08-28', granularity: 'DAILY', segments: null }] }] }, { requestId: REQUEST }),
		[],
	);
});
