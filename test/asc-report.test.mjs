import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsOf, reportRows, metric } from '../src/lib/asc-report.mjs';

test('rowsOf passes a bare array through', () => {
	assert.deepEqual(rowsOf([1, 2]), [1, 2]);
	assert.deepEqual(rowsOf([]), []);
});

test('rowsOf unwraps every known list key', () => {
	for (const key of ['data', 'items', 'results', 'versions', 'builds', 'prices', 'tags', 'findings', 'issues', 'keywords', 'localizations']) {
		assert.deepEqual(rowsOf({ [key]: ['x'] }), ['x'], key);
	}
});

test('rowsOf unwraps the nested Apple Ads pagination shape', () => {
	assert.deepEqual(rowsOf({ data: { data: [1] } }), [1]);
});

test('rowsOf wraps a single object by default', () => {
	assert.deepEqual(rowsOf({ id: 'a' }), [{ id: 'a' }]);
});

test('rowsOf refuses to invent a row when allowSingle is false', () => {
	assert.deepEqual(rowsOf({ id: 'a' }, { allowSingle: false }), []);
	assert.deepEqual(rowsOf({ data: { campaign: {} } }, { allowSingle: false }), []);
	assert.deepEqual(rowsOf(null, { allowSingle: false }), []);
	assert.deepEqual(rowsOf('text', { allowSingle: false }), []);
});

test('rowsOf returns [] for junk input', () => {
	assert.deepEqual(rowsOf(null), []);
	assert.deepEqual(rowsOf(undefined), []);
	assert.deepEqual(rowsOf('text'), []);
});

test('reportRows finds node.row arrays anywhere in the payload', () => {
	assert.deepEqual(
		reportRows({ reportingDataResponse: { row: [{ a: 1 }] } }),
		[{ a: 1 }],
	);
	assert.deepEqual(reportRows({ data: { reportingDataResponse: { row: [2] } } }), [2]);
	assert.deepEqual(reportRows({ deep: { nested: { row: [3] } } }), [3]);
});

test('reportRows returns [] when no row array exists', () => {
	assert.deepEqual(reportRows({}), []);
	assert.deepEqual(reportRows(null), []);
	assert.deepEqual(reportRows({ row: 'not an array' }), []);
});

test('metric unwraps Apple Ads money objects and coerces junk to 0', () => {
	assert.equal(metric({ amount: 12.5, currency: 'USD' }), 12.5);
	assert.equal(metric(4), 4);
	assert.equal(metric('7'), 7);
	assert.equal(metric(null), 0);
	assert.equal(metric(undefined), 0);
	assert.equal(metric({}), 0);
});
