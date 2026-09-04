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

test('a listing with nothing to say at all reports clean', async () => {
	const dir = await appRepo({ 'store/staged/en-US.json': {
		locale: 'en-US', name: 'Glovebox', subtitle: 'Car maintenance log',
		keywords: 'oil change,service log,mileage tracker,repair history,garage notes,fuel economy,car care',
		description: 'Glovebox keeps every service, repair and fill-up for your car in one place, so the next owner — or the next mechanic — can see exactly what was done and when.',
		promotionalText: 'Now with reminders', whatsNew: 'Reminders for every service interval.',
		supportUrl: 'https://demo.example/support', privacyPolicyUrl: 'https://demo.example/privacy',
	} });
	const cfg = await cfgOf(dir);
	const rows = await rowsOf((r) => live.checkListing(r, cfg));
	assert.equal(rows[0].level, 'ok');
	assert.equal(rows[0].detail, 'clean');
});

test('a version list that is neither an array nor data-wrapped reads as empty', async () => {
	setBin('asc', [['versions list', { out: { meta: { total: 0 } } }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /does not exist on app 111/);
});

test('a version row that carries versionString flat is matched too', async () => {
	setBin('asc', [['versions list', { out: { data: [{ versionString: '1.0.0', appStoreState: 'IN_REVIEW' }] } }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.match(row.detail, /IN_REVIEW/);
});

test('a build payload with no rows anywhere warns rather than throwing', async () => {
	setBin('asc', [['builds list', { out: { meta: {} } }]]);
	assert.match(only(await rowsOf((r) => live.checkBuild(r, '111')), 'build').detail, /no builds on app 111/);
});

test('a build with neither number nor state still reports', async () => {
	setBin('asc', [['builds list', { out: { data: [{ attributes: {} }] } }]]);
	const row = only(await rowsOf((r) => live.checkBuild(r, '111')), 'build');
	assert.match(row.detail, /newest build \? is UNKNOWN/);
});

test('validate: a summary that is not an object reads as every field absent', async () => {
	setBin('asc', [['^validate', { out: { summary: 'clean' } }]]);
	const row = only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /0 blocking/);
});

test('screenshots: an asc that cannot list them says so rather than reporting none', async () => {
	setBin('asc', [
		['versions list', { out: { data: [{ id: 'ver-1', attributes: { versionString: '1.0.0' } }] } }],
		['localizations list', { out: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] } }],
		['screenshots list', { out: '', err: 'unauthorized', code: 1 }],
	]);
	const { localizationId } = await import('../src/lib/shots-asc.mjs');
	const cfg = await cfgOf(await appRepo());
	const row = only(await rowsOf((r) => live.checkScreenshots(r, cfg, '111', '1.0.0', localizationId)), 'screenshots');
	assert.equal(row.level, 'skip');
});

test('a legal URL whose fetch throws a bare string is still reported', async () => {
	const cfg = await cfgOf(await appRepo({}, { legal: { privacyUrl: 'https://demo.example/p', supportUrl: null } }));
	const { withFetch } = await import('./fixtures/cmd.mjs');
	const report = new Report('t');
	await withFetch(async () => {
		throw 'socket hang up';
	}, () => live.checkLegal(report, cfg));
	assert.equal(report.rows[0].level, 'fail');
	assert.match(report.rows[0].detail, /socket hang up/);
	assert.equal(report.rows[1].level, 'skip', 'an unset URL is not a dead one');
});

test('screenshots: a localization lookup that throws a bare string skips the row', async () => {
	const cfg = await cfgOf(await appRepo());
	const row = only(await rowsOf((r) => live.checkScreenshots(r, cfg, '111', '1.0.0', () => Promise.reject('no session'))), 'screenshots');
	assert.equal(row.level, 'skip');
	assert.match(row.detail, /no session/);
});

test('screenshots: a payload with no sets, and sets with nothing in them, both fail', async () => {
	const withLoc = (extra) => setBin('asc', [
		['versions list', { out: { data: [{ id: 'ver-1', attributes: { versionString: '1.0.0' } }] } }],
		['localizations list', { out: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] } }],
		...extra,
	]);
	const cfg = await cfgOf(await appRepo());
	const { localizationId } = await import('../src/lib/shots-asc.mjs');

	withLoc([['screenshots list', { out: { meta: {} } }]]);
	assert.match(only(await rowsOf((r) => live.checkScreenshots(r, cfg, '111', '1.0.0', localizationId)), 'screenshots').detail, /has none on App Store Connect/);

	withLoc([['screenshots list', { out: { sets: ['nonsense', { set: null, screenshots: null }] } }]]);
	assert.match(only(await rowsOf((r) => live.checkScreenshots(r, cfg, '111', '1.0.0', localizationId)), 'screenshots').detail, /has none on App Store Connect/);
});

test('export compliance names the value it found, whatever wrapper it was in', async () => {
	const cfg = await cfgOf(await appRepo({ 'app.json': { expo: { ios: { infoPlist: { ITSAppUsesNonExemptEncryption: false } } } } }));
	const row = only(await rowsOf((r) => live.checkEncryption(r, cfg)), 'export compliance');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /ITSAppUsesNonExemptEncryption: false/);
});

test('eu trader: an explicit false reads differently from an unset one', async () => {
	const explicit = await cfgOf(await appRepo({}, { store: { locales: ['de-DE'] }, legal: { euTrader: false } }));
	assert.match(only(await rowsOf((r) => live.checkEuTrader(r, explicit)), 'eu trader').detail, /euTrader is false/);

	const unset = await cfgOf(await appRepo({}, { store: { locales: ['de-DE'] }, legal: {} }));
	assert.match(only(await rowsOf((r) => live.checkEuTrader(r, unset)), 'eu trader').detail, /euTrader is unset/);
});

test('ota: a tree that matches its lock is reported unchanged', async () => {
	const dir = await appRepo({ 'package.json': { name: 'demo', dependencies: {} } });
	const cfg = await cfgOf(dir);
	const { writeLock } = await import('../src/lib/native.mjs');
	await writeLock(cfg, { version: '1.0.0', deps: {}, config: {}, builtAt: '2026-01-01T00:00:00.000Z' });
	const row = only(await rowsOf((r) => live.checkOta(r, cfg, '1.0.0')), 'ota');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /native surface unchanged since lock/);
});

test('qa: a clean report is an ok row naming the tier', async () => {
	const cfg = await cfgOf(await appRepo({ 'design/ux.json': { screens: [] }, 'qa/1.0.0/report.json': { version: '1.0.0', tier: 1, summary: { fail: 0, warn: 0, skipped: 0 } } }));
	const row = only(await rowsOf((r) => live.checkQa(r, cfg, '1.0.0')), 'qa');
	assert.equal(row.level, 'ok');
	assert.match(row.detail, /tier 1/);
});

test('qa: a report with no summary block at all is still read', async () => {
	const cfg = await cfgOf(await appRepo({ 'design/ux.json': { screens: [] }, 'qa/1.0.0/report.json': { version: '1.0.0', tier: 2 } }));
	const row = only(await rowsOf((r) => live.checkQa(r, cfg, '1.0.0')), 'qa');
	assert.equal(row.level, 'ok');
});

test('ascReachable: a payload that is not an object reads as no credentials', async () => {
	setBin('asc', [['auth status', { out: '"a string"' }]]);
	assert.match((await live.ascReachable(false)).why, /no App Store Connect credentials/);
});

test('an asc that exits non-zero with nothing to say is still a failure that says so', async () => {
	setBin('asc', [['age-rating view', { out: '', code: 0 }]]);
	const row = only(await rowsOf((r) => live.checkAgeRating(r, '111')), 'age rating');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /empty response/);
});

test('a versions payload holding something that is not a row does not crash the match', async () => {
	setBin('asc', [['versions list', { out: { data: ['nonsense'] } }]]);
	const row = only(await rowsOf((r) => live.checkAscVersion(r, '111', '1.0.0')), 'asc version');
	assert.equal(row.level, 'ok', 'the first row stands in, whatever it is');
});

test('validate: a payload that is not an object at all reports no blockers', async () => {
	setBin('asc', [['^validate', { out: '"nothing to report"' }]]);
	const row = only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate');
	assert.equal(row.level, 'ok');
});

test('validate: errors without a blocking count still fail', async () => {
	setBin('asc', [['^validate', { out: { summary: { blocking: 0, errors: 2, warnings: 0, infos: 0 } } }]]);
	assert.equal(only(await rowsOf((r) => live.checkValidate(r, '111', '1.0.0')), 'validate').level, 'fail');
});
