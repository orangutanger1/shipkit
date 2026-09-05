// The pure report-parsing surface: number coercion, CSV/TSV sniffing, the row
// normaliser that reads whatever field name an export used, and the wide/long
// funnel folders. Everything here is unit-tested directly against
// lib/report-parse.mjs — analytics.test.mjs covers the same functions through
// the re-export analytics.mjs exposes, this file covers the shapes that
// re-export never needs to drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	foldRecords,
	missingFromListing,
	normaliseRow,
	parseDelimited,
	parseFunnelExport,
	parseSpreadsheetNumber,
} from '../src/lib/report-parse.mjs';

test('a non-finite number, however it arrives, reads as zero', () => {
	// Analytics rows are plain JS objects before they ever touch JSON, so a
	// caller can hand parseSpreadsheetNumber an actual NaN or Infinity, not
	// just a string that fails to parse.
	assert.equal(parseSpreadsheetNumber(NaN), 0);
	assert.equal(parseSpreadsheetNumber(Infinity), 0);
	assert.equal(parseSpreadsheetNumber('not a number'), 0);
});

test('missingFromListing accepts the staged keyword field as an array of slots', () => {
	const rows = [{ term: 'car maintenance log', impressions: 4000, pageViews: 400, installs: 120 }];
	// `ship aso` stages keywords as an array of packed slots, not one joined
	// string; the field has to be joined before tokenising.
	const missing = missingFromListing(rows, ['glovebox', 'receipts'], 'en-US');
	assert.deepEqual(missing.map((m) => m.term), ['car maintenance log']);
});

test('a row that is not an object at all normalises to an empty term, not a crash', () => {
	// Term files are read back from disk after a human can have edited them —
	// a stray string or array entry in the JSON must not throw.
	assert.deepEqual(normaliseRow('oops'), { term: '', impressions: 0, pageViews: 0, installs: 0, conversionRate: 0 });
	assert.deepEqual(normaliseRow(['oops']), { term: '', impressions: 0, pageViews: 0, installs: 0, conversionRate: 0 });
});

test('normaliseRow reads whichever column name the export used', () => {
	// Apple's own export and third-party pulls disagree on every column name;
	// each alternate spelling needs its own case to prove the fallback chain.
	assert.equal(normaliseRow({ keyword: 'glovebox' }).term, 'glovebox');
	assert.equal(normaliseRow({}).term, '');
	assert.equal(normaliseRow({ pageviews: '12' }).pageViews, 12);
	assert.equal(normaliseRow({ views: '12' }).pageViews, 12);
	assert.equal(normaliseRow({ downloads: '5' }).installs, 5);
	assert.equal(normaliseRow({ units: '5' }).installs, 5);
});

test('conversion rate falls back to the exported figure when impressions is zero', () => {
	// Some exports report a conversion rate for a term row that has aged out of
	// impressions; without impressions to derive it from, take the field as-is.
	const row = normaliseRow({ term: 'x', impressions: 0, installs: 0, conversionRate: '4.5%' });
	assert.equal(row.conversionRate, 4.5);
});

test('parseDelimited tolerates an absent or blank export', () => {
	assert.deepEqual(parseDelimited(undefined), []);
	// No non-blank line at all — the header sniff must not throw on an empty find().
	assert.deepEqual(parseDelimited('\n\n\n'), []);
	// A header with no data rows under it is not a report.
	assert.deepEqual(parseDelimited('term,impressions\n'), []);
});

test('parseDelimited sniffs a semicolon export from a locale that uses it', () => {
	const records = parseDelimited('term;impressions;installs\nkeyword;100;10');
	assert.deepEqual(records, [{ term: 'keyword', impressions: '100', installs: '10' }]);
});

test('a doubled quote inside a quoted cell is a literal quote, not a delimiter', () => {
	const records = parseDelimited('term,note\n"widget","5\'\' screen ""pro"""');
	assert.equal(records[0].note, '5\'\' screen "pro"');
});

test('a ragged row shorter than the header fills the missing cells with empty strings', () => {
	const records = parseDelimited('term,impressions,installs\nkeyword,100');
	assert.deepEqual(records[0], { term: 'keyword', impressions: '100', installs: '' });
});

test('foldRecords keeps only rows inside the requested territory, blank territory included', () => {
	const records = [
		{ Term: 'a', Territory: 'US', Impressions: '10' },
		{ Term: 'b', Territory: '', Impressions: '20' },
		{ Term: 'c', Territory: 'FR', Impressions: '30' },
	];
	const { terms } = foldRecords(records, { territory: 'us' });
	// The blank-territory row is not FR, but it is also not US: a missing
	// territory value on a row must not silently count as "in every territory".
	assert.deepEqual(terms.map((t) => t.term).sort(), ['a']);
});

test('foldRecords drops rows for an event it does not recognise, or that has none at all', () => {
	// A hand-edited JSON pull can carry rows of uneven shape; column roles are
	// read off the first row, so a later row can simply lack the Event key.
	const records = [
		{ Event: 'Impression', Counts: '100' },
		{ Event: 'Refund', Counts: '9' },
		{ Counts: '4' }, // dropped its own Event cell
	];
	const { funnel } = foldRecords(records);
	assert.equal(funnel.impressions, 100);
	assert.equal(funnel.installs, 0);
});

test('a row missing its territory cell entirely is not "in every territory"', () => {
	const records = [
		{ Term: 'a', Territory: 'US', Impressions: '10' },
		{ Term: 'b', Impressions: '20' }, // no Territory key on this row at all
	];
	const { terms } = foldRecords(records, { territory: 'us' });
	assert.deepEqual(terms.map((t) => t.term), ['a']);
});

test('a row missing its term cell folds into the funnel but not into any term bucket', () => {
	const records = [{ Term: 'a', Impressions: '20' }, { Impressions: '10' }];
	const { funnel, terms } = foldRecords(records);
	assert.equal(funnel.impressions, 30);
	assert.deepEqual(terms.map((t) => t.term), ['a']);
});

test('foldRecords tolerates a long-format row with no term column at all', () => {
	const records = [{ Event: 'Impression', Counts: '5' }];
	const { funnel, terms } = foldRecords(records);
	assert.equal(funnel.impressions, 5);
	assert.deepEqual(terms, []);
});

test('foldRecords breaks an installs tie by impressions, the larger audience', () => {
	const records = [
		{ Term: 'a', Impressions: '100', Installs: '10' },
		{ Term: 'b', Impressions: '50', Installs: '10' },
	];
	const { terms } = foldRecords(records);
	assert.deepEqual(terms.map((t) => t.term), ['a', 'b']);
});

test('parseFunnelExport skips a null entry in a bare JSON array', () => {
	const steps = parseFunnelExport(JSON.stringify([null, { name: 'signup', users: 10 }]));
	assert.equal(steps.length, 2);
	assert.equal(steps[0].name, 'step 1');
	assert.equal(steps[0].users, 0);
});

test('parseFunnelExport reads name and users off unlabelled keys when no header matches', () => {
	// PostHog-shaped rows: no column the sniffer recognises as a name/count
	// header, so it must fall back to the literal `name`/`users` fields.
	const steps = parseFunnelExport(JSON.stringify([{ name: 'onboarded', users: 42 }]));
	assert.deepEqual(steps, [{ name: 'onboarded', users: 42, kind: undefined }]);
});

test('a row whose headers name neither a step nor a count still gets a numbered step', () => {
	// A funnel export with columns this sniffer has never seen (no Step/Name
	// column, no Users/Count column) must not throw — it falls back to
	// "step N" with zero users rather than crashing the pull.
	const steps = parseFunnelExport('foo,bar\nx,y');
	assert.deepEqual(steps, [{ name: 'step 1', users: 0, kind: undefined }]);
});
