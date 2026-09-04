// The shapes each preflight check has to survive: an asc too old to answer, an
// asc that is not authenticated, one that errors, and the half-dozen payload
// layouts App Store Connect actually returns. Each check is called directly
// with its own Report, which is the smallest thing that proves the row.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { fakeBins, fakeHome, inDir, repo, setBin, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { Report } = await import('../src/log.mjs');
const live = await import('../src/lib/preflight-live.mjs');
const { loadConfig } = await import('../src/config.mjs');

/**
 * The rows one check produced, as `{name, level, detail}`. Nothing is printed:
 * a check pushes rows and `report.print()` — which this never calls — is what
 * writes. That keeps stdout free for the test runner's own output.
 */
async function rowsOf(fn) {
	const report = new Report('t');
	await fn(report);
	return report.rows;
}

const only = (rows, name) => rows.find((r) => r.name === name) ?? rows[0];

const cfgOf = (dir) => inDir(dir, () => loadConfig());
const appRepo = (files = {}, config = {}) =>
	repo({ config: { name: 'Demo', bundleId: 'com.demo.app', asc: { appId: '111', primaryLocale: 'en-US' }, store: { locales: ['en-US'] }, legal: {}, ...config }, files, prefix: 'ship-pfl-' });

// ── the three ways asc can decline to answer ────────────────────────────────

test('an asc too old for a subcommand warns and says to check by hand', async () => {
	setBin('asc', [['versions list', { out: '', err: 'unknown command "versions"', code: 1 }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /this asc cannot answer it/);
});

test('an unauthenticated asc is a skip — unknown, not blocked', async () => {
	setBin('asc', [['builds list', { out: '', err: 'not authenticated', code: 1 }]]);
	const row = only(await rowsOf((r) => live.checkBuild(r, '111')), 'build');
	assert.equal(row.level, 'skip');
	assert.match(row.detail, /App Store Connect unreachable/);
});

test('an asc that fails for any other reason is a failure that names it', async () => {
	setBin('asc', [['age-rating view', { out: '', err: 'internal server explosion', code: 2 }]]);
	const row = only(await rowsOf((r) => live.checkAgeRating(r, '111')), 'age rating');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /asc could not read it/);
});

test('a probe that throws outright is reported as unreachable, not as a crash', async () => {
	const saved = process.env.PATH;
	process.env.PATH = '/definitely/not/here';
	try {
		const row = only(await rowsOf((r) => live.checkBuild(r, '111')), 'build');
		assert.equal(row.level, 'skip');
	} finally {
		process.env.PATH = saved;
	}
});

// ── the payload layouts ─────────────────────────────────────────────────────

test('a bare array of versions reads the same as a data-wrapped one', async () => {
	setBin('asc', [['versions list', { out: [{ versionString: '1.0.0', state: 'READY_FOR_SALE' }] }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /READY_FOR_SALE/);
});

test('a version row with no state at all still reports, as UNKNOWN', async () => {
	setBin('asc', [['versions list', { out: { data: [{ attributes: { versionString: '9.9.9' } }] } }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.match(row.detail, /UNKNOWN/, 'the first row stands in when none matches the version asked for');
});

test('a build list that is a bare array is read too', async () => {
	setBin('asc', [['builds list', { out: [{ buildNumber: '7', processingState: 'VALID' }] }]]);
	const row = only(await rowsOf((r) => live.checkBuild(r, '111')), 'build');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /build 7/);
});

test('validate: a data.attributes.summary is read the same as a root one', async () => {
	setBin('asc', [['^validate', { out: { data: { attributes: { summary: { blocking: 0, errors: 0, warnings: 2, infos: 1 } } } } }]]);
	const row = only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /2 warning/);
});

test('validate: a payload with items and no summary lists them in fix order', async () => {
	setBin('asc', [['^validate', { out: { checks: [{ severity: 'ERROR', message: 'first', id: 'a' }, { severity: 'WARNING', message: 'second', id: 'b' }] } }]]);
	const rows = await rowsOf((r) => live.checkValidate(r, '111', '1.0.0'));
	assert.match(rows[0].name, /1\./);
	assert.match(rows[1].name, /2\./);
});

test('validate: a payload with neither summary nor items is Apple reporting no blockers', async () => {
	setBin('asc', [['^validate', { out: { ok: true } }]]);
	const row = only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /no blockers/);
});

test('validate: an unauthenticated asc skips rather than failing the version', async () => {
	setBin('asc', [['^validate', { out: '', err: 'unauthorized', code: 1 }]]);
	const row = only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate');
	assert.equal(row.level, 'skip');
});

test('age rating: an app with no declaration at all is a different failure from an incomplete one', async () => {
	setBin('asc', [['age-rating view', { out: { data: { attributes: {} } } }]]);
	const none = only(await rowsOf((r) => live.checkAgeRating(r, '111')), 'age rating');
	assert.match(none.detail, /no age rating declaration/);

	setBin('asc', [['age-rating view', { out: { data: { attributes: { violence: 'NONE', gambling: null } } } }]]);
	const gaps = only(await rowsOf((r) => live.checkAgeRating(r, '111')), 'age rating');
	assert.match(gaps.detail, /unanswered: gambling/);
});

test('content rights: NOT_ANSWERED reads as unanswered, a real value as the answer', async () => {
	setBin('asc', [['apps content-rights view', { out: { data: { attributes: { contentRightsDeclaration: 'NOT_ANSWERED' } } } }]]);
	assert.match(only(await rowsOf((r) => live.checkContentRights(r, '111')), 'content rights').detail, /has not answered/);

	setBin('asc', [['apps content-rights view', { out: { contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT' } }]]);
	const answered = only(await rowsOf((r) => live.checkContentRights(r, '111')), 'content rights');
	assert.equal(answered.level, 'ok');
	assert.match(answered.detail, /USES_THIRD_PARTY_CONTENT/);
});

test('privacy labels: an asc with no web privacy support warns rather than skipping', async () => {
	setBin('asc', [['web auth status', { out: '', err: 'unknown subcommand "web"', code: 1 }]]);
	const row = only(await rowsOf((r) => live.checkPrivacy(r, '111')), 'privacy labels');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /confirm the labels by hand/);
});

test('privacy labels: declarations are counted from whichever key carries them', async () => {
	setBin('asc', [['web auth status', { out: { authenticated: true } }], ['web privacy pull', { out: { dataTypes: [{ id: 'a' }, { id: 'b' }] } }]]);
	const row = only(await rowsOf((r) => live.checkPrivacy(r, '111')), 'privacy labels');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /2 data usage declarations/);
});

test('privacy labels: an asc that refuses the pull is reported as such', async () => {
	setBin('asc', [['web auth status', { out: { authenticated: true } }], ['web privacy pull', { out: '', err: 'forbidden', code: 1 }]]);
	const row = only(await rowsOf((r) => live.checkPrivacy(r, '111')), 'privacy labels');
	assert.equal(row.level, 'skip');
});

// ── the local checks ────────────────────────────────────────────────────────

test('a staged listing that will not parse fails the listing row rather than the run', async () => {
	const dir = await appRepo({ 'store/staged/en-US.json': '{oops' });
	const cfg = await cfgOf(dir);
	const row = only(await rowsOf((r) => live.checkListing(r, cfg)), 'listing');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /not valid JSON/);
});

test('a listing with only warnings warns; one with a failure fails', async () => {
	const dir = await appRepo({ 'store/staged/en-US.json': { locale: 'en-US', name: 'Demo', subtitle: 'Track your car', keywords: 'car', description: 'A description long enough to satisfy the App Store lint rules for this listing.', promotionalText: 'New', whatsNew: 'Fixes' } });
	const cfg = await cfgOf(dir);
	const warned = await rowsOf((r) => live.checkListing(r, cfg));
	assert.ok(warned.every((r) => r.level !== 'fail'));

	await writeFiles(dir, { 'store/staged/en-US.json': { locale: 'en-US', name: 'x'.repeat(40) } });
	const reloaded = await cfgOf(dir);
	const failed = await rowsOf((r) => live.checkListing(r, reloaded));
	assert.equal(failed[0].level, 'fail');
});

test('a version check reads app.json whether or not it is wrapped in expo', async () => {
	const wrappedCfg = await cfgOf(await appRepo({ 'app.json': { expo: { version: '2.0.0' } } }));
	assert.equal(only(await rowsOf((r) => live.checkVersion(r, wrappedCfg, '2.0.0')), 'version').level, 'ok');

	// An app.json with no `expo` block is not an Expo config at all, so there is
	// nothing to cross-check against.
	const bareCfg = await cfgOf(await appRepo({ 'app.json': { version: '2.0.0' } }));
	assert.match(only(await rowsOf((r) => live.checkVersion(r, bareCfg, '2.0.0')), 'version').detail, /no app.json to cross-check/);

	const noneCfg = await cfgOf(await appRepo({ 'app.json': { expo: { name: 'Demo' } } }));
	assert.match(only(await rowsOf((r) => live.checkVersion(r, noneCfg, '2.0.0')), 'version').detail, /declares no version/);
});

test('screenshots: a version with no localization skips rather than failing', async () => {
	setBin('asc', [['versions list', { out: { data: [] } }]]);
	const dir = await appRepo();
	const cfg = await cfgOf(dir);
	const { localizationId } = await import('../src/lib/shots-asc.mjs');
	const row = only(await rowsOf((r) => live.checkScreenshots(r, cfg, '111', '1.0.0', localizationId)), 'screenshots');
	assert.equal(row.level, 'skip');
});

test('rc: with no key at all the row is unknown, not a finding', async () => {
	// The harness strips ambient credentials, so this is a machine that has
	// never seen a RevenueCat key — which must read as "unknown", never as a
	// healthy project or a broken one.
	const cfg = await cfgOf(await appRepo({}, { revenuecat: { projectId: 'projX' } }));
	const row = only(await rowsOf((r) => live.checkRevenueCat(r, cfg)), 'rc');
	assert.equal(row.level, 'skip');
	assert.match(row.detail, /no RevenueCat v2 key/);
});

test('ota: a repo whose native surface cannot be read skips the row', async () => {
	const dir = await appRepo();
	const cfg = await cfgOf(dir);
	const row = only(await rowsOf((r) => live.checkOta(r, cfg, '1.0.0')), 'ota');
	assert.equal(row.level, 'skip');
	assert.match(row.detail, /cannot read the native surface/);
});

test('ascReachable: offline, no asc, a refusal, and no credentials each say why', async () => {
	assert.deepEqual(await live.ascReachable(true), { live: false, why: '--offline' });

	const saved = process.env.PATH;
	process.env.PATH = '/definitely/not/here';
	try {
		assert.match((await live.ascReachable(false)).why, /asc is not on PATH/);
	} finally {
		process.env.PATH = saved;
	}

	setBin('asc', [['auth status', { out: '', err: 'unauthorized', code: 1 }]]);
	assert.match((await live.ascReachable(false)).why, /asc auth status failed/);

	setBin('asc', [['auth status', { out: { credentials: [] } }]]);
	assert.match((await live.ascReachable(false)).why, /no App Store Connect credentials/);

	setBin('asc', [['auth status', { out: { credentials: [{ name: 'Team' }] } }]]);
	assert.deepEqual(await live.ascReachable(false), { live: true, why: null });
});
