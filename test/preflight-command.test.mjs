// `ship preflight` end to end — the whole submission gate. Every live check
// goes through `asc` (a fake binary), the legal URLs and RevenueCat through
// fetch. The point of the command is that a missing credential is "unknown",
// not "blocked", so both halves are exercised.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
await fakeBins(['asc']);

const { run } = await import('../src/commands/preflight.mjs');

const CONFIG = {
	name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0',
	asc: { appId: '111', primaryLocale: 'en-US' },
	store: { locales: ['en-US'] },
	legal: { privacyUrl: 'https://demo.example/privacy', supportUrl: 'https://demo.example/support', euTrader: null },
	revenuecat: {},
};
const APP_JSON = { expo: { version: '1.2.0', ios: { bundleIdentifier: 'com.demo.app', infoPlist: { ITSAppUsesNonExemptEncryption: false } } } };
const LISTING = { locale: 'en-US', name: 'Demo', subtitle: 'Track your car', description: 'A long enough description to pass the lint rules for the staged listing check.', keywords: 'car,service', promotionalText: 'New', whatsNew: 'Fixes', supportUrl: 'https://demo.example/support' };

/** A healthy App Store Connect: version exists, build is VALID, everything answered. */
function ascHealthy(extra = []) {
	setBin('asc', [
		...extra,
		['^auth status', { out: { credentials: [{ name: 'Team' }] } }],
		['versions list', { out: { data: [{ id: 'ver-1', attributes: { versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION' } }] } }],
		['builds list', { out: { data: [{ attributes: { version: '42', processingState: 'VALID' } }] } }],
		['localizations list', { out: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] } }],
		['screenshots list', { out: { sets: [{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: [{ id: 's1' }, { id: 's2' }] }] } }],
		['^validate', { out: { summary: { blocking: 0, errors: 0, warnings: 0, infos: 0 }, checks: [] } }],
		['age-rating view', { out: { data: { attributes: { violenceCartoonOrFantasy: 'NONE', ageRatingOverride: 'NONE' } } } }],
		['apps content-rights view', { out: { data: { attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } } } }],
		['web auth status', { out: { authenticated: true } }],
		['web privacy pull', { out: { data: [{ type: 'appDataUsages', id: 'u1' }] } }],
	]);
}

/** Reachable legal URLs and a RevenueCat account with nothing to say. */
const netOk = async (url) => {
	const href = String(url);
	if (href.includes('demo.example')) return new Response('', { status: 200 });
	return json({ items: [] });
};

/** @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function preflight({ flags = {}, dir, fetch = netOk }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args: [], flags }))));
	return { code: result, out };
}

const pfRepo = (files = {}, config = {}) =>
	repo({ config: { ...CONFIG, ...config }, files: { 'app.json': APP_JSON, 'store/staged/en-US.json': LISTING, ...files }, prefix: 'ship-pf-' });

test('preflight needs a repo', async () => {
	const dir = await repo({ config: null, prefix: 'ship-pf-' });
	await assert.rejects(() => preflight({ dir }), /no ship.config.json in this repo/);
});

test('a ready version passes every check it can run', async () => {
	ascHealthy();
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 0);
	assert.match(out, /listing en-US/);
	assert.match(out, /version/);
	assert.match(out, /export compliance/);
	assert.match(out, /asc version.*PREPARE_FOR_SUBMISSION/s);
	assert.match(out, /build 42/);
	assert.match(out, /APP_IPHONE_65 ×2/);
	assert.match(out, /questionnaire complete/);
	assert.match(out, /1 data usage declaration/);
	assert.match(out, /privacy url/);
});

test('--offline runs only what needs no credentials, and skips the rest loudly', async () => {
	ascHealthy();
	const dir = await pfRepo();
	const { out } = await preflight({ dir, flags: { offline: true } });
	assert.match(out, /skipped: --offline/);
	assert.match(out, /listing en-US/, 'the offline half still runs');
});

test('--json emits the report', async () => {
	ascHealthy();
	const dir = await pfRepo();
	const { out } = await preflight({ dir, flags: { json: true, offline: true } });
	assert.ok(JSON.parse(out).rows.length);
});

test('with no credentials every live check is a skip, not a failure', async () => {
	setBin('asc', [['^auth status', { out: { credentials: [] } }]]);
	const dir = await pfRepo();
	const { out } = await preflight({ dir });
	assert.match(out, /no App Store Connect credentials/);
	assert.doesNotMatch(out, /does not exist on app/);
});

test('a listing that lints dirty, and no listing at all, both fail', async () => {
	ascHealthy();
	const overlong = await pfRepo({ 'store/staged/en-US.json': { ...LISTING, subtitle: 'x'.repeat(60) } });
	const { code, out } = await preflight({ dir: overlong, flags: { offline: true } });
	assert.equal(code, 1);
	assert.match(out, /listing en-US/);

	const none = await pfRepo({ 'store/staged/en-US.json': null });
	const { out: bare } = await preflight({ dir: none, flags: { offline: true } });
	assert.match(bare, /no locale files in/);
});

test('a version that disagrees with app.json is a hard failure', async () => {
	ascHealthy();
	const dir = await pfRepo({ 'app.json': { expo: { version: '1.1.0', ios: APP_JSON.expo.ios } } });
	const { code, out } = await preflight({ dir, flags: { offline: true } });
	assert.equal(code, 1);
	assert.match(out, /app.json says 1.1.0, shipping 1.2.0/);
});

test('a repo with no app.json skips the version and encryption checks', async () => {
	ascHealthy();
	const dir = await pfRepo({ 'app.json': null });
	const { out } = await preflight({ dir, flags: { offline: true } });
	assert.match(out, /no app.json to cross-check/);
	assert.match(out, /no app.json to read ios.infoPlist/);
});

test('the export compliance key is checked in both of its wrong states', async () => {
	ascHealthy();
	const missing = await pfRepo({ 'app.json': { expo: { version: '1.2.0', ios: { infoPlist: {} } } } });
	const { code, out } = await preflight({ dir: missing, flags: { offline: true } });
	assert.equal(code, 1);
	assert.match(out, /Waiting for Export Compliance/);

	const noCode = await pfRepo({ 'app.json': { expo: { version: '1.2.0', ios: { infoPlist: { ITSAppUsesNonExemptEncryption: true } } } } });
	const { out: warned } = await preflight({ dir: noCode, flags: { offline: true } });
	assert.match(warned, /self-classification report/);
});

test('an EU storefront with no declared trader is a failure', async () => {
	ascHealthy();
	const dir = await pfRepo({}, { store: { locales: ['en-US', 'de-DE'] } });
	const { code, out } = await preflight({ dir, flags: { offline: true } });
	assert.equal(code, 1);
	assert.match(out, /undeclared trader is pulled from every EU storefront/);

	const declared = await pfRepo({}, { store: { locales: ['de-DE'] }, legal: { ...CONFIG.legal, euTrader: true } });
	const { out: ok } = await preflight({ dir: declared, flags: { offline: true } });
	assert.match(ok, /eu trader.*declared/s);
});

test('the QA report is folded in: absent, stale, and failing are three different rows', async () => {
	ascHealthy();
	const noSpec = await pfRepo();
	const { out: skipped } = await preflight({ dir: noSpec, flags: { offline: true } });
	assert.match(skipped, /no design\/ux.json in this repo/);

	const missing = await pfRepo({ 'design/ux.json': { screens: [] } });
	const { out: absent } = await preflight({ dir: missing, flags: { offline: true } });
	assert.match(absent, /run `ship qa`/);

	const stale = await pfRepo({ 'design/ux.json': { screens: [] }, 'qa/1.2.0/report.json': { version: '1.1.0' } });
	const { out: old } = await preflight({ dir: stale, flags: { offline: true } });
	assert.match(old, /reports version 1.1.0, not 1.2.0/);

	const failing = await pfRepo({ 'design/ux.json': { screens: [] }, 'qa/1.2.0/report.json': { version: '1.2.0', tier: 1, summary: { fail: 2, warn: 0, skipped: 3 } } });
	const { out: bad } = await preflight({ dir: failing, flags: { offline: true } });
	assert.match(bad, /2 failing check\(s\)/);

	const warned = await pfRepo({ 'design/ux.json': { screens: [] }, 'qa/1.2.0/report.json': { version: '1.2.0', tier: 1, summary: { fail: 0, warn: 1 } } });
	const { out: warn } = await preflight({ dir: warned, flags: { offline: true } });
	assert.match(warn, /1 warning\(s\)/);
});

test('a version App Store Connect does not have is a failure that says so', async () => {
	ascHealthy([['versions list', { out: { data: [] } }]]);
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(out, /1.2.0 does not exist on app 111/);
});

test('no builds, and no VALID build, are two different warnings', async () => {
	ascHealthy([['builds list', { out: { data: [] } }]]);
	const dir = await pfRepo();
	const { out } = await preflight({ dir });
	assert.match(out, /no builds on app 111/);

	ascHealthy([['builds list', { out: { data: [{ attributes: { version: '43', processingState: 'PROCESSING' } }] } }]]);
	const { out: processing } = await preflight({ dir });
	assert.match(processing, /nothing VALID to attach yet/);
});

test('a version with no screenshots, and one with no iPhone set, are both blockers', async () => {
	ascHealthy([['screenshots list', { out: { sets: [] } }]]);
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(out, /Apple rejects a version with zero iPhone screenshots/);

	ascHealthy([['screenshots list', { out: { sets: [{ set: { attributes: { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' } }, screenshots: [{ id: 'a' }] }] } }]]);
	const { out: ipadOnly } = await preflight({ dir });
	assert.match(ipadOnly, /but no iPhone set/);
});

test('validate findings are folded in, in Apple\'s own fix order', async () => {
	ascHealthy([['^validate', { out: {
		summary: { blocking: 1, errors: 1, warnings: 1, infos: 0 },
		checks: [{ id: 'privacy', severity: 'ERROR', message: 'privacy policy URL missing' }],
		remediation: { steps: [{ order: 1, blocking: true, severity: 'ERROR', message: 'add a privacy URL', remediation: 'store/app-info' }] },
	} }]]);
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(out, /1 blocking/);
	assert.match(out, /1\./);
});

test('an asc that answers nothing for validate is a failure, not a pass', async () => {
	ascHealthy([['^validate', { out: '' }]]);
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(out, /asc validate returned nothing/);
});

test('an incomplete age rating and an unanswered rights question both block', async () => {
	ascHealthy([['age-rating view', { out: { data: { attributes: { violenceCartoonOrFantasy: null } } } }]]);
	const dir = await pfRepo();
	const { code, out } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(out, /unanswered:|no age rating declaration/);

	ascHealthy([['apps content-rights view', { out: { data: { attributes: {} } } }]]);
	const { out: rights } = await preflight({ dir });
	assert.match(rights, /has not answered the third-party content question/);
});

test('privacy labels need a web session, and an empty label is a blocker', async () => {
	ascHealthy([['web auth status', { out: { authenticated: false } }]]);
	const dir = await pfRepo();
	const { out } = await preflight({ dir });
	assert.match(out, /no Apple web session/);

	ascHealthy([['web privacy pull', { out: { data: [] } }]]);
	const { code, out: empty } = await preflight({ dir });
	assert.equal(code, 1);
	assert.match(empty, /declares no data collection/);
});

test('a dead legal URL fails, an unset one skips', async () => {
	ascHealthy();
	const dir = await pfRepo();
	const dead = async (url) => (String(url).includes('demo.example') ? new Response('', { status: 404 }) : json({ items: [] }));
	const { code, out } = await preflight({ dir, fetch: dead });
	assert.equal(code, 1);
	assert.match(out, /a dead policy URL is an automatic rejection/);

	const unreachable = async (url) => {
		if (String(url).includes('demo.example')) throw new Error('ENOTFOUND');
		return json({ items: [] });
	};
	const { out: down } = await preflight({ dir, fetch: unreachable });
	assert.match(down, /unreachable/);

	const noUrls = await pfRepo({}, { legal: { privacyUrl: null, supportUrl: null, euTrader: null } });
	const { out: unset } = await preflight({ dir: noUrls });
	assert.match(unset, /unset in ship.config.json/);
});

test('RevenueCat is audited when a project is configured, and skipped when it is not', async () => {
	ascHealthy();
	const dir = await pfRepo();
	const { out } = await preflight({ dir });
	assert.match(out, /rc .*project unresolved|no revenuecat.projectId/s, 'an account with no projects is unknown, not broken');

	const configured = await pfRepo({}, { revenuecat: { projectId: 'projX', entitlement: 'pro' } });
	const rc = async (url) => {
		const href = String(url);
		if (href.includes('demo.example')) return new Response('', { status: 200 });
		if (href.endsWith('/v2/projects')) return json({ items: [{ id: 'projX', name: 'Demo' }] });
		return json({ items: [] });
	};
	const { out: audited } = await preflight({ dir: configured, fetch: rc });
	assert.match(audited, /rc:/);
});

test('the OTA row rides along as information, never as a gate', async () => {
	ascHealthy();
	const dir = await pfRepo({ 'package.json': { name: 'demo', dependencies: {} } });
	const { out } = await preflight({ dir, flags: { offline: true } });
	assert.match(out, /ota/);
});
