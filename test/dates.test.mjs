import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, daysUntil, daysElapsed, isoDay } from '../src/lib/dates.mjs';

const NOW = Date.parse('2026-09-01T12:00:00Z');

test('DAY_MS is exactly one day in milliseconds', () => {
	assert.equal(DAY_MS, 86_400_000);
});

test('daysUntil counts down in whole days, rounding', () => {
	assert.equal(daysUntil('2026-09-04T12:00:00Z', NOW), 3);
	assert.equal(daysUntil('2026-09-02T00:00:00Z', NOW), 1); // 12h away rounds to 1
	assert.equal(daysUntil('2026-09-01T12:00:00Z', NOW), 0);
	assert.equal(daysUntil('2026-08-30T12:00:00Z', NOW), -2);
});

test('daysUntil returns null without a timestamp', () => {
	assert.equal(daysUntil(null, NOW), null);
	assert.equal(daysUntil(undefined, NOW), null);
	assert.equal(daysUntil('', NOW), null);
});

test('daysElapsed counts whole days since, flooring', () => {
	assert.equal(daysElapsed('2026-08-30T12:00:00Z', NOW), 2);
	assert.equal(daysElapsed('2026-08-31T12:00:00Z', NOW), 1); // exactly one day
	assert.equal(daysElapsed('2026-08-31T18:00:00Z', NOW), 0); // 18h floors to 0
	assert.equal(daysElapsed(Date.parse('2026-08-25T12:00:00Z'), NOW), 7);
});

test('daysElapsed returns null when the input carries no date', () => {
	assert.equal(daysElapsed('not a date', NOW), null);
	assert.equal(daysElapsed(undefined, NOW), null);
	assert.equal(daysElapsed(null, NOW), null);
});

test('isoDay renders the UTC calendar day', () => {
	assert.equal(isoDay(Date.parse('2026-09-01T12:00:00Z')), '2026-09-01');
	assert.equal(isoDay(Date.parse('2026-12-31T23:30:00Z')), '2026-12-31');
});
