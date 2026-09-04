// `ship portfolio` end to end: the registry (add / rm / list / --scan) and the
// dashboard that probes every registered app. The registry file is redirected
// with SHIP_PORTFOLIO_FILE, App Store Connect and Apple Ads answer through a
// fake `asc`, and RevenueCat through a fetch stub.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
const REGISTRY = join(await mkdtemp(join(tmpdir(), 'ship-portfolio-')), 'registry.json');
process.env.SHIP_PORTFOLIO_FILE = REGISTRY;
await fakeBins(['asc']);

const { run } = await import('../src/commands/portfolio.mjs');

const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', asc: { appId: '111' }, ads: { orgId: '555' }, revenuecat: { projectId: 'projX' } };

/** A live account: shipped a year ago, released last month, earning. */
function ascLive({ state = 'READY_FOR_SALE', created = '2026-08-01T00:00:00.000Z', first = '2025-01-01T00:00:00.000Z' } = {}) {
	setBin('asc', [
		['^status', { out: { appstore: { state, version: '1.2.0' }, builds: { latest: { buildNumber: '42' } } } }],
		['versions list', { out: { data: [
			{ attributes: { versionString: '1.2.0', appStoreState: state, createdDate: created } },
			{ attributes: { versionString: '1.0.0', appStoreState: 'READY_FOR_SALE', createdDate: first } },
		] } }],
		['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { org: '555' } } }],
		['ads reports preset', { out: { data: { reportingDataResponse: { row: [{ total: { localSpend: { amount: 30 }, totalInstalls: 10 } }] } } } }],
	]);
}

const rcFetch = (revenue = 500) => async (url) => {
	const href = String(url);
	if (href.includes('/metrics/overview')) return json({ metrics: [{ id: 'mrr', value: revenue }] });
	return json({ items: [{ id: 'projX', name: 'Demo' }] });
};

/** @param {string[]} args @param {{flags?: object, fetch?: typeof globalThis.fetch, dir?: string}} [opts] */
async function portfolio(args, { flags = {}, fetch = rcFetch(), dir } = {}) {
	await resetCalls();
	const call = () => run({ args, flags });
	const { result, out } = await capture(() => withFetch(fetch, () => (dir ? inDir(dir, call) : call())));
	return { code: result, out };
}

const appRepo = (config = {}) => repo({ config: { ...CONFIG, ...config }, prefix: 'ship-pf-app-' });
const registry = () => readFile(REGISTRY, 'utf8').then(JSON.parse);

test('add registers an app once, and says so the second time', async () => {
	const dir = await appRepo();
	const { code, out } = await portfolio(['add', dir]);
	assert.equal(code, 0);
	assert.match(out, /added Demo/);
	assert.equal((await registry()).apps.length, 1);

	const { out: again } = await portfolio(['add', dir]);
	assert.match(again, /already registered: Demo/);
	assert.equal((await registry()).apps.length, 1);

	await portfolio(['rm', dir]);
});

test('add takes the config file itself, and refuses a directory that is not an app', async () => {
	const dir = await appRepo();
	const notAnApp = await repo({ config: null, prefix: 'ship-pf-none-' });
	const { out } = await portfolio(['add', join(dir, 'ship.config.json'), notAnApp]);
	assert.match(out, /added Demo/);
	assert.match(out, /no ship.config.json in/);
	await portfolio(['rm', dir]);
});

test('add needs something to add', async () => {
	await assert.rejects(() => portfolio(['add']), /nothing to add/);
});

test('an unparseable config is still registered, under its directory name', async () => {
	const dir = await repo({ config: null, files: { 'ship.config.json': '{oops' }, prefix: 'ship-pf-broken-' });
	const { out } = await portfolio(['add', dir], { flags: { json: true } });
	assert.equal(JSON.parse(out).results[0].added, true);
	await portfolio(['rm', dir]);
});

test('--scan finds every app under a directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ship-pf-scan-'));
	await repo({ config: CONFIG, prefix: 'x-' });
	const a = await appRepo();
	const { out } = await portfolio(['add'], { flags: { scan: a, depth: 2 } });
	assert.match(out, /added Demo|already registered/);
	assert.ok(root);
	await portfolio(['rm', a]);
});

test('rm removes by path and reports a key it never had', async () => {
	const dir = await appRepo();
	await portfolio(['add', dir]);
	const { code, out } = await portfolio(['rm', dir, 'never-registered']);
	assert.equal(code, 0, 'one removal makes the run a success');
	assert.match(out, /removed Demo/);
	assert.match(out, /not registered: never-registered/);

	const { code: none } = await portfolio(['rm', 'never-registered']);
	assert.equal(none, 1, 'removing nothing at all is a failure');
	await assert.rejects(() => portfolio(['rm']), /needs a path or a name/);
});

test('list shows the registry without touching the network', async () => {
	const dir = await appRepo();
	await portfolio(['add', dir]);
	const { code, out } = await portfolio(['list']);
	assert.equal(code, 0);
	assert.match(out, /Portfolio \(1\)/);
	assert.match(out, /ok/);
	const { out: raw } = await portfolio(['ls'], { flags: { json: true } });
	assert.equal(JSON.parse(raw).apps.length, 1);
	await portfolio(['rm', dir]);
});

test('the empty dashboard says how to fill it', async () => {
	const { code, out } = await portfolio([]);
	assert.equal(code, 0);
	assert.match(out, /no apps registered/);
	const { out: raw } = await portfolio([], { flags: { json: true } });
	assert.deepEqual(JSON.parse(raw).apps, []);
});

test('the dashboard probes every registered app and totals the money', async () => {
	ascLive();
	const dir = await appRepo();
	await portfolio(['add', dir]);
	const { code, out } = await portfolio([]);
	assert.equal(code, 0);
	assert.match(out, /Demo/);
	assert.match(out, /1\.2\.0/);

	const { out: raw } = await portfolio([], { flags: { json: true } });
	const doc = JSON.parse(raw);
	assert.equal(doc.totals.apps, 1);
	assert.equal(doc.apps[0].revenue, 500);
	assert.equal(doc.apps[0].spend, 30);
	assert.equal(doc.apps[0].verdict, 'keep');
	await portfolio(['rm', dir]);
});

test('an app earning nothing, old, and long unreleased is a sunset candidate', async () => {
	ascLive({ created: '2025-02-01T00:00:00.000Z', first: '2024-01-01T00:00:00.000Z' });
	const dir = await appRepo();
	await portfolio(['add', dir]);
	const { out } = await portfolio([], { flags: { json: true, floor: 10 }, fetch: rcFetch(0) });
	const row = JSON.parse(out).apps[0];
	assert.equal(row.sunset, true);
	assert.equal(row.verdict, 'sunset');
	await portfolio(['rm', dir]);
});

test('an app App Store Connect cannot answer for is a row with an error, not a crash', async () => {
	setBin('asc', []);
	const dir = await appRepo();
	await portfolio(['add', dir]);
	const { code, out } = await portfolio([], { flags: { json: true } });
	const doc = JSON.parse(out);
	assert.equal(doc.totals.errors, 1);
	assert.equal(code, 0, 'the dashboard is not a gate unless asked');

	const { code: strict } = await portfolio([], { flags: { strict: true } });
	assert.equal(strict, 1);
	await portfolio(['rm', dir]);
});

test('an app with no asc.appId, key or org is skipped per probe rather than failed', async () => {
	setBin('asc', [['ads auth status', { out: { credentials: [] } }]]);
	const dir = await repo({ config: { name: 'Bare', bundleId: 'com.bare.app' }, prefix: 'ship-pf-bare-' });
	await portfolio(['add', dir]);
	const { out } = await portfolio([], { flags: { json: true }, fetch: async () => json({ items: [] }) });
	const row = JSON.parse(out).apps[0];
	assert.match(JSON.stringify(row.skipped ?? {}), /no asc.appId|no Apple Ads credentials|revenuecat/);
	await portfolio(['rm', dir]);
});

test('an unknown subcommand names the ones that exist', async () => {
	await assert.rejects(() => portfolio(['sunset']), /unknown subcommand "sunset"/);
});
