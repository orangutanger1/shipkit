// The App Store Connect half of the shots workflow — id resolution, the cap
// arithmetic, asc's varying validate/list shapes, and the two upload paths —
// exercised directly against a fake `asc`. `test/shots-command.test.mjs`
// drives the same code through `ship shots`, but a couple of things only show
// up with responses no real command run produces on the happy path: a version
// list without a matching locale, a `screenshots list` shaped nothing like the
// others, more than one blocked group at once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeBins, fakeHome, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const lib = await import('../src/lib/shots-asc.mjs');
const { ascFindings, capPreflight, capVerdict, dimsOf, fetchSizes, localizationId, reportUpload, uploadAppScoped, uploadPerLocale } = lib;

// ── dimsOf ───────────────────────────────────────────────────────────────────

test('dimsOf treats a sizes row with no dimensions field as accepting none', () => {
	// asc has shipped rows with a family and no dimensions before (a device type
	// still being rolled out); dimsOf must not throw reading .map off it.
	assert.deepEqual(dimsOf({ displayType: 'APP_VISION_PRO' }), []);
});

// ── fetchSizes shapes ────────────────────────────────────────────────────────
// Memoized per `all`, so each shape needs its own key to avoid reading the
// previous test's cache.

test('fetchSizes accepts a bare array, not just a {sizes:} wrapper', async () => {
	setBin('asc', [['screenshots sizes', { out: [{ displayType: 'APP_IPHONE_65', dimensions: [{ width: 1, height: 2 }] }] }]]);
	const rows = await fetchSizes({ all: true });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].displayType, 'APP_IPHONE_65');
});

test('fetchSizes falls back to a {data:} wrapper when there is no {sizes:}', async () => {
	setBin('asc', [['screenshots sizes', { out: { data: [{ displayType: 'APP_IPAD_PRO', dimensions: [] }] } }]]);
	const rows = await fetchSizes({ all: false });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].displayType, 'APP_IPAD_PRO');
});

// ── localizationId ───────────────────────────────────────────────────────────

test('localizationId falls back to the first row when none carries the requested locale', async () => {
	setBin('asc', [
		['versions list', { out: { data: [{ id: 'ver-fallback' }] } }],
		['localizations list', { out: { data: [{ id: 'loc-only', attributes: { locale: 'fr-FR' } }] } }],
	]);
	// asc filtered by --locale already; a row present with a different locale
	// tag on it is asc disagreeing with itself, not a reason to fail the call.
	assert.equal(await localizationId('app-fb', '1.0.0', 'en-US'), 'loc-only');
});

test('localizationId refuses a version with no matching localization at all', async () => {
	setBin('asc', [
		['versions list', { out: { data: [{ id: 'ver-none' }] } }],
		['localizations list', { out: { data: [] } }],
	]);
	await assert.rejects(
		() => localizationId('app-none', '1.0.0', 'de-DE'),
		/version 1\.0\.0 has no de-DE localization/,
	);
});

// ── ascFindings ──────────────────────────────────────────────────────────────

test('ascFindings reads nothing out of a response that is not an object', () => {
	assert.deepEqual(ascFindings(null), []);
	assert.deepEqual(ascFindings(/** @type {any} */ ('nope')), []);
});

test('ascFindings names the file for a per-result finding, even one with no message', () => {
	const res = {
		results: [
			{ file: 'shot.png', errors: [{ code: 42 }], warnings: ['low contrast'] },
		],
	};
	const found = ascFindings(res);
	assert.equal(found[0].level, 'fail');
	assert.equal(found[0].message, 'shot.png', 'a per-result finding with no message still names the file');
	assert.equal(found[1].level, 'warn');
	assert.match(found[1].message, /shot\.png low contrast/);
});

test('ascFindings stringifies a bare finding object that carries neither message nor detail', () => {
	const found = ascFindings({ errors: [{ code: 42 }] });
	assert.match(found[0].message, /"code":42/);
});

test('ascFindings copes with a results row that names its file by `path`, or carries only one of errors/warnings', () => {
	const found = ascFindings({
		results: [
			{ path: 'store/en-US/01.png', errors: [{ code: 1 }] },
			{ file: 'store/en-US/02.png', warnings: [{ code: 2 }] },
		],
	});
	assert.equal(found.length, 2);
	assert.equal(found[0].level, 'fail');
	assert.match(found[0].message, /store\/en-US\/01\.png/, '`path` names the file when there is no `file`');
	assert.equal(found[1].level, 'warn');
	assert.match(found[1].message, /store\/en-US\/02\.png/);
});

test('ascFindings names nothing when a results row carries neither `file` nor `path`', () => {
	const found = ascFindings({ results: [{ errors: ['orphaned'] }] });
	assert.equal(found[0].message, 'orphaned');
});

test('ascFindings reports `valid: false` by its own message, then its reason, then a default', () => {
	assert.deepEqual(ascFindings({ valid: false, message: 'bad path' }), [{ level: 'fail', message: 'bad path' }]);
	assert.deepEqual(ascFindings({ valid: false, reason: 'no images' }), [{ level: 'fail', message: 'no images' }]);
	assert.deepEqual(ascFindings({ valid: false }), [{ level: 'fail', message: 'asc reported the path invalid' }]);
	// valid: false alongside a real error is not a second, redundant finding.
	assert.deepEqual(ascFindings({ valid: false, errors: ['real problem'] }), [{ level: 'fail', message: 'real problem' }]);
});

// ── capPreflight / remoteSets shapes ─────────────────────────────────────────

const group = (over = {}) => ({ locale: 'en-US', displayType: 'IPHONE_65', count: 1, dir: '/tmp/x', files: [{ width: 1242, height: 2688 }], ...over });

function withIds(extra) {
	setBin('asc', [
		['versions list', { out: { data: [{ id: 'ver-1' }] } }],
		['localizations list', { out: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] } }],
		...extra,
	]);
}

test('capPreflight treats a screenshots list with no `sets` array as nothing attached', async () => {
	withIds([['screenshots list', { out: { meta: {} } }]]);
	// Nothing attached means nothing to append to — this must not throw or warn.
	await capPreflight({ appId: 'a', version: '1.0.0', groups: [group()], replace: false, force: false });
});

test('capPreflight skips a set entry with no display type and one whose screenshots is not a list', async () => {
	withIds([['screenshots list', { out: { sets: [
		{ set: {}, screenshots: [{ attributes: { imageAsset: { width: 1, height: 1 } } }] },
		{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: 'oops' },
	] } }]]);
	// Neither entry contributes a count Apple would reject against; the group
	// still reads as empty-remote, so this must resolve rather than throw.
	await capPreflight({ appId: 'a', version: '1.0.0', groups: [group()], replace: false, force: false });
});

test('capPreflight warns rather than blocks a plain append under the cap', async () => {
	withIds([['screenshots list', { out: { sets: [
		{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: [{ attributes: { imageAsset: { width: 1242, height: 2688 } } }] },
	] } }]]);
	// 1 already attached + 1 local = 2, well under the cap, same dimensions:
	// safe to append, but still worth a heads-up about what --skip-existing does.
	await capPreflight({ appId: 'a', version: '1.0.0', groups: [group()], replace: false, force: false });
});

test('capPreflight blocks a set whose attached dimensions do not match what is local', async () => {
	withIds([['screenshots list', { out: { sets: [
		{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: [{ attributes: { imageAsset: { width: 1284, height: 2778 } } }] },
	] } }]]);
	try {
		await capPreflight({ appId: 'a', version: '1.0.0', groups: [group()], replace: false, force: false });
		assert.fail('expected capPreflight to refuse');
	} catch (err) {
		assert.match(err.hint, /attached set is 1284x2778, these are 1242x2688/);
	}
});

test('capPreflight names every blocked group when more than one is over the cap', async () => {
	const nine = Array.from({ length: 9 }, () => ({ attributes: { imageAsset: { width: 1242, height: 2688 } } }));
	withIds([['screenshots list', { out: { sets: [
		{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: nine },
		{ set: { attributes: { screenshotDisplayType: 'APP_IPAD_PRO' } }, screenshots: nine },
	] } }]]);
	const groups = [group({ count: 3 }), group({ displayType: 'IPAD_PRO', count: 3, files: [{ width: 2048, height: 2732 }] })];
	await assert.rejects(
		() => capPreflight({ appId: 'a', version: '1.0.0', groups, replace: false, force: false }),
		/refusing to append to 2 sets/,
	);
});

// ── capVerdict: --replace bypasses the arithmetic entirely ──────────────────

test('capVerdict never asks about the remote set when --replace clears it first', () => {
	assert.deepEqual(capVerdict({ remote: 20, local: 20, replace: true }), { over: false, total: 20, appending: false, mixed: [] });
});

// ── uploadPerLocale / uploadAppScoped: pluralization and failure reporting ──

test('uploadPerLocale pluralizes its own step label and reports a rejection by locale', async () => {
	withIds([
		['screenshots upload', { out: '', err: '', code: 1 }],
	]);
	const groups = [group({ count: 2, files: [{ width: 1242, height: 2688 }, { width: 1242, height: 2688 }] })];
	const results = await uploadPerLocale({ appId: 'a', version: '1.0.0', groups, mode: ['--skip-existing'] });
	assert.equal(results[0].ok, false);
	// No stderr from asc: the message falls back to naming the exit code.
	assert.equal(results[0].locale, 'en-US');
});

test('uploadAppScoped pluralizes locales and files across more than one of each', async () => {
	setBin('asc', [['screenshots upload', { out: { data: { id: 'up' } } }]]);
	const groups = [group(), group({ locale: 'de-DE' })];
	const results = await uploadAppScoped({ appId: 'a', version: '1.0.0', platform: 'IOS', root: '/tmp/root', groups, mode: ['--skip-existing'] });
	assert.equal(results[0].count, 2);
	assert.deepEqual(results[0].locales.sort(), ['de-DE', 'en-US']);
});

test('uploadAppScoped falls back to naming the exit code when asc gives no stderr', async () => {
	setBin('asc', [['screenshots upload', { out: '', err: '', code: 3 }]]);
	const results = await uploadAppScoped({ appId: 'a', version: '1.0.0', platform: 'IOS', root: '/tmp/root', groups: [group()], mode: [] });
	assert.equal(results[0].ok, false);
});

// ── reportUpload ─────────────────────────────────────────────────────────────

test('reportUpload --json reports a clean run as ok with exit 0', () => {
	const code = reportUpload({
		appId: 'a', version: '1.0.0', flags: { json: true },
		results: [{ locale: 'en-US', displayType: 'IPHONE_65', count: 1, ok: true, result: null }],
	});
	assert.equal(code, 0);
});

test('reportUpload names every rejected locale/displayType pair when more than one fails', () => {
	assert.throws(
		() =>
			reportUpload({
				appId: 'a', version: '1.0.0', flags: {},
				results: [
					{ locale: 'en-US', displayType: 'IPHONE_65', count: 1, ok: false, result: null },
					{ locale: 'de-DE', displayType: 'IPHONE_65', count: 1, ok: false, result: null },
				],
			}),
		/2 uploads rejected by asc/,
	);
});

test('reportUpload names an app-scoped failure by its display type and locale count', () => {
	try {
		reportUpload({
			appId: 'a', version: '1.0.0', flags: {},
			results: [
				{ locales: ['en-US', 'de-DE'], displayType: 'IPHONE_65', count: 2, ok: false, result: null },
				{ locales: ['en-US'], displayType: 'IPAD_PRO', count: 1, ok: true, result: null },
			],
		});
		assert.fail('expected reportUpload to throw');
	} catch (err) {
		assert.match(err.hint, /IPHONE_65 \(2 locales\)/);
	}
});

test('reportUpload still names an app-scoped failure when the row carries no locales at all', () => {
	// `locales` is optional on an UploadResult; a row that never got past a
	// bare app-scoped call still has to be nameable in the failure hint.
	try {
		reportUpload({
			appId: 'a', version: '1.0.0', flags: {},
			results: [{ displayType: 'IPHONE_65', count: 1, ok: false, result: null }],
		});
		assert.fail('expected reportUpload to throw');
	} catch (err) {
		assert.match(err.hint, /IPHONE_65 \(0 locales\)/);
	}
});
