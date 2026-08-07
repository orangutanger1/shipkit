// Listing rules. Each assertion here maps to something App Store Connect or
// Apple's indexer punishes, so a "harmless" refactor that loses one is a
// regression in ranking or a rejected submission, not a style change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordList, lintListing, normaliseKeywords, parseStrings } from '../src/lib/locales.mjs';
import { packKeywords } from '../src/lib/appstore.mjs';

const listing = (data) => ({ locale: 'en-US', file: '/tmp/en-US.json', data: { locale: 'en-US', ...data } });
const complete = {
	name: 'Glovebox',
	subtitle: 'Car service log',
	keywords: 'oil,tyre,brakes,mileage',
	description: 'x'.repeat(200),
};
const problems = (data) => lintListing(listing(data));
const fields = (data, level) => problems(data).filter((p) => p.level === level).map((p) => p.field);

test('a complete listing lints clean', () => {
	assert.deepEqual(fields(complete, 'fail'), []);
});

test('every required field is a failure when empty', () => {
	assert.deepEqual(fields({}, 'fail').sort(), ['description', 'keywords', 'name', 'subtitle']);
});

test('whitespace does not satisfy a required field', () => {
	assert.ok(fields({ ...complete, name: '   ' }, 'fail').includes('name'));
});

test('a space after a comma in keywords is a failure, not a warning', () => {
	// Apple indexes the space, so "a, b" costs one character per term for nothing.
	const p = problems({ ...complete, keywords: 'oil, tyre' }).find((x) => /spaces after commas/.test(x.message));
	assert.ok(p, 'expected a comma-space finding');
	assert.equal(p.level, 'fail');
});

test('duplicate keywords fail case-insensitively', () => {
	const p = problems({ ...complete, keywords: 'oil,Oil' }).find((x) => x.level === 'fail');
	assert.match(p.message, /duplicate/);
});

test('over-limit fields fail and are measured in code points, not bytes', () => {
	// 31 emoji = 31 characters to Apple, 124 bytes to Buffer.byteLength.
	const p = problems({ ...complete, name: '🚗'.repeat(31) }).find((x) => x.field === 'name');
	assert.equal(p.level, 'fail');
	assert.match(p.message, /31\/30/);
});

test('a name of exactly the limit passes', () => {
	assert.deepEqual(fields({ ...complete, name: 'x'.repeat(30) }, 'fail'), []);
});

test('keywords already in name or subtitle are warned about, not failed', () => {
	const p = problems({ ...complete, keywords: 'glovebox,tyre' }).find((x) => x.level === 'warn' && /already indexed/.test(x.message));
	assert.ok(p, 'expected a wasted-slot warning');
	assert.match(p.message, /glovebox/);
});

test('a locale field disagreeing with the filename fails', () => {
	const p = lintListing({ locale: 'de-DE', file: '/tmp/de-DE.json', data: { ...complete, locale: 'en-US' } });
	assert.ok(p.some((x) => x.field === 'locale' && x.level === 'fail'));
});

test('non-https legal URLs fail', () => {
	assert.ok(fields({ ...complete, supportUrl: 'http://example.com' }, 'fail').includes('supportUrl'));
	assert.deepEqual(fields({ ...complete, supportUrl: 'https://example.com' }, 'fail'), []);
});

test('keywordList trims and drops empties', () => {
	assert.deepEqual(keywordList(' oil , , tyre '), ['oil', 'tyre']);
	assert.deepEqual(keywordList(null), []);
});

test('normaliseKeywords drops case-duplicates and keeps first-seen order', () => {
	assert.equal(normaliseKeywords('oil,Tyre,OIL,brakes'), 'oil,Tyre,brakes');
});

test('packKeywords never exceeds the limit and counts the separator', () => {
	const { keywords, used, limit } = packKeywords(
		[{ keyword: 'car maintenance' }, { keyword: 'oil change reminder' }],
		{ limit: 20 },
	);
	assert.equal(limit, 20);
	assert.ok(used <= 20, `used ${used}`);
	assert.equal(keywords.length, used, 'used must be the real field length');
});

test('packKeywords skips words already indexed by name and subtitle', () => {
	const { keywords } = packKeywords([{ keyword: 'car maintenance log' }], { alreadyIndexed: 'Glovebox Car Log' });
	assert.deepEqual(keywords.split(',').filter(Boolean), ['maintenance']);
});

test('packKeywords emits each word once across phrases', () => {
	const { keywords } = packKeywords([{ keyword: 'car log' }, { keyword: 'car service' }]);
	assert.deepEqual(keywords.split(','), ['car', 'log', 'service']);
});

test('parseStrings reads key/value pairs and unescapes', () => {
	const parsed = parseStrings('"name" = "Beacon";\n"desc" = "line1\\nline2 \\"quoted\\"";\n');
	assert.equal(parsed.name, 'Beacon');
	assert.equal(parsed.desc, 'line1\nline2 "quoted"');
});

test('parseStrings ignores comments and malformed lines', () => {
	const parsed = parseStrings('/* header */\n"a" = "1";\nnot a pair\n"b" = "2";');
	assert.deepEqual(parsed, { a: '1', b: '2' });
});
