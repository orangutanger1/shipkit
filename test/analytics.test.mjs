// Conversion truth. Two things here decide what the keyword loop does next:
// which converting terms the keyword field is missing, and which funnel stage
// is losing the users. Both are pure; neither is allowed to touch the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARK, bottleneck, foldRecords, missingFromListing, parseDelimited } from '../src/commands/analytics.mjs';

const row = (term, impressions, pageViews, installs) => ({ term, impressions, pageViews, installs });

test('a converting term the keyword field does not carry is the finding', () => {
	const rows = [row('car maintenance log', 4000, 400, 120), row('glovebox', 900, 200, 60)];
	const missing = missingFromListing(rows, 'glovebox,receipts,mileage', 'en-US');
	assert.deepEqual(missing.map((m) => m.term), ['car maintenance log']);
	assert.equal(missing[0].installs, 120);
});

test('a converting term already in the keyword field is excluded', () => {
	const rows = [row('service reminder', 1000, 200, 50)];
	// Packed one word per slot: coverage is per token, not per phrase.
	assert.deepEqual(missingFromListing(rows, 'service,reminder,mileage', 'en-US'), []);
	assert.deepEqual(missingFromListing(rows, 'service reminder', 'en-US'), []);
});

test('terms that never converted are not listing edits', () => {
	const rows = [row('free car app', 50_000, 900, 0)];
	assert.deepEqual(missingFromListing(rows, 'glovebox', 'en-US'), []);
});

test('stop words inside a term are not a coverage gap', () => {
	const rows = [row('log for the car', 800, 200, 40)];
	assert.deepEqual(missingFromListing(rows, 'log,car', 'en-US'), []);
});

test('Japanese coverage is decided by segmentation, not whitespace', () => {
	const keywords = 'カレンダー,予定,管理';
	// The bug this guards: no whitespace split of the field ever contains 予定管理.
	assert.ok(!keywords.split(/[\s,]+/).includes('予定管理'));

	const rows = [row('予定管理', 5000, 800, 200), row('家計簿', 3000, 300, 90)];
	const missing = missingFromListing(rows, keywords, 'ja-JP');
	assert.deepEqual(missing.map((m) => m.term), ['家計簿'], '予定管理 is covered by 予定 + 管理');
});

test('findings are ranked by installs, the thing being bought', () => {
	const rows = [row('a', 10, 5, 3), row('b', 10_000, 900, 40), row('c', 10, 5, 3)];
	const missing = missingFromListing(rows, '', 'en-US');
	assert.deepEqual(missing.map((m) => m.term), ['b', 'a', 'c']);
});

test('missingFromListing survives an empty pull and an empty field', () => {
	assert.deepEqual(missingFromListing([], 'car', 'en-US'), []);
	assert.deepEqual(missingFromListing(undefined, undefined, 'en-US'), []);
});

test('a zero-impression funnel reports zero, never NaN', () => {
	const b = bottleneck({ impressions: 0, pageViews: 0, installs: 0 });
	for (const k of ['viewRate', 'installRate', 'conversionRate']) {
		assert.ok(Number.isFinite(b[k]), `${k} must be finite`);
		assert.equal(b[k], 0);
	}
	assert.equal(b.stage, 'impressions');
	assert.equal(b.healthy, false);
	assert.match(b.fix, /aso score/);
});

test('page views without installs does not divide by zero either', () => {
	const b = bottleneck({ impressions: 1000, pageViews: 0, installs: 0 });
	assert.equal(b.installRate, 0);
	assert.equal(b.stage, 'impression→pageview');
});

test('a weak impression→pageview rate is an ASO problem', () => {
	const b = bottleneck({ impressions: 100_000, pageViews: 2000, installs: 900 });
	assert.ok(b.viewRate < BENCHMARK.viewRate);
	assert.ok(b.installRate > BENCHMARK.installRate);
	assert.equal(b.stage, 'impression→pageview');
	assert.match(b.fix, /icon, title and subtitle/);
});

test('a weak pageview→install rate is a screenshot / paywall problem', () => {
	const b = bottleneck({ impressions: 10_000, pageViews: 3000, installs: 150 });
	assert.ok(b.viewRate > BENCHMARK.viewRate);
	assert.ok(b.installRate < BENCHMARK.installRate);
	assert.equal(b.stage, 'pageview→install');
	assert.match(b.fix, /screenshots|paywall/);
});

test('both stages above benchmark is healthy', () => {
	const b = bottleneck({ impressions: 10_000, pageViews: 2000, installs: 800 });
	assert.equal(b.healthy, true);
	assert.equal(b.conversionRate, 0.08);
});

test('a tab-separated report with quoted cells parses into records', () => {
	const tsv = 'Search Term\tImpressions\tProduct Page Views\tInstalls\n"car, log"\t1,200\t300\t45\n';
	const [rec] = parseDelimited(tsv);
	assert.equal(rec['Search Term'], 'car, log');
	assert.equal(rec.Impressions, '1,200');
});

test('foldRecords sums a wide export by term and skips its own total row', () => {
	const csv = [
		'Search Term,Impressions,Product Page Views,Installs',
		'glovebox,100,40,10',
		'glovebox,100,40,10',
		'car log,50,20,5',
		'Total,250,100,25',
	].join('\n');
	const { terms, funnel, matched } = foldRecords(parseDelimited(csv));
	assert.equal(matched, true);
	assert.deepEqual(funnel, { impressions: 250, pageViews: 100, installs: 25 });
	assert.deepEqual(terms.map((t) => t.term), ['glovebox', 'car log']);
	assert.equal(terms[0].installs, 20);
	assert.equal(terms[0].conversionRate, 0.1);
});

test('foldRecords reads the long Event/Counts layout Apple ships over the API', () => {
	const tsv = [
		'Date\tEvent\tTerritory\tCounts',
		'2026-07-01\tImpression\tUS\t1000',
		'2026-07-01\tPage view\tUS\t200',
		'2026-07-01\tInstall\tUS\t60',
		'2026-07-01\tImpression\tDE\t500',
	].join('\n');
	const all = foldRecords(parseDelimited(tsv));
	assert.deepEqual(all.funnel, { impressions: 1500, pageViews: 200, installs: 60 });
	const us = foldRecords(parseDelimited(tsv), { territory: 'us' });
	assert.deepEqual(us.funnel, { impressions: 1000, pageViews: 200, installs: 60 });
});

test('a report with no readable columns is reported, not silently zeroed', () => {
	const { matched, funnel } = foldRecords(parseDelimited('Date,Crashes\n2026-07-01,3\n'));
	assert.equal(matched, false);
	assert.deepEqual(funnel, { impressions: 0, pageViews: 0, installs: 0 });
});
