// `ship doctor` end to end. Everything it probes is a process boundary, so the
// seams are the process: fake `asc`/`npx` binaries shadow the real ones on
// PATH, HOME points at a temp dir so the MCP search and the RevenueCat key file
// are ours, and globalThis.fetch answers for Astro and RevenueCat. The no-key
// RevenueCat branch lives in doctor-command-no-key.test.mjs, because apiKey()
// caches its answer for the life of the process.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch, writeFiles } from './fixtures/cmd.mjs';

const HOME = await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
const BIN = await fakeBins(['asc', 'npx']);
// A second directory holding only `npx`, so one test can take `asc` off PATH
// without also taking away the eas probe that runs after it.
const NPX_ONLY = await fakeBins(['npx']);

const { run, help } = await import('../src/commands/doctor.mjs');

/** The healthy answers; a test overrides only the line it is about. */
const AUTH = { credentials: [{ name: 'Team', keyId: 'ABC123', isDefault: true }] };
const ADS_AUTH = { credentials: [{ name: 'Ads' }], active: { name: 'Ads' } };
const APP = { data: { attributes: { name: 'Demo', bundleId: 'com.demo.app' } } };

function asc({ auth = AUTH, ads = ADS_AUTH, app = APP } = {}) {
	setBin('asc', [
		['^ads auth status', { out: ads }],
		['^auth status', { out: auth }],
		['^apps view', { out: app }],
	]);
}

function npx({ version = '16.3.0', whoami = 'demo-account', versionCode = 0, whoamiCode = 0 } = {}) {
	setBin('npx', [
		['--version', { out: version, code: versionCode }],
		['whoami', { out: whoami, code: whoamiCode }],
	]);
}

/** Astro unreachable (the Linux default) unless a test says otherwise. */
const astroDown = () => Promise.reject(new Error('ECONNREFUSED'));

/**
 * @param {{args?: string[], flags?: object, fetch?: typeof globalThis.fetch, dir?: string}} opts
 * @returns {Promise<{code: number, out: string}>}
 */
async function doctor({ args = [], flags = {}, fetch: handler, dir } = {}) {
	await resetCalls();
	const stub = handler ?? (async (url) => (String(url).includes('127.0.0.1:8089') ? astroDown() : json({ items: [] })));
	const { result, out } = await capture(() =>
		inDir(dir ?? process.cwd(), () => withFetch(stub, () => run({ args, flags }))),
	);
	return { code: result, out };
}

test('help names every check the command runs', () => {
	for (const line of ['asc ads', 'revenuecat', 'mcp', '--deep']) assert.match(help, new RegExp(line));
});

test('a healthy machine and repo reports every check green and exits 0', async () => {
	asc();
	npx();
	const dir = await repo({ config: { asc: { appId: '111' } }, files: { 'app.json': { expo: { ios: { bundleIdentifier: 'com.demo.app' } } }, 'store/staged/en-US.json': {}, 'aso/keep.json': {} } });
	const { code, out } = await doctor({ dir });
	assert.equal(code, 0);
	assert.match(out, /node/);
	assert.match(out, /Team \(key ABC123\)/);
	assert.match(out, /· default/);
	assert.match(out, /Ads \(1 credential\)/);
	assert.match(out, /16\.3\.0/);
	assert.match(out, /demo-account/);
	assert.match(out, /1 locale file/);
	assert.match(out, /com\.demo\.app/);
});

test('--deep asks asc to validate the stored credentials over the network', async () => {
	asc();
	npx();
	await doctor({ flags: { deep: true }, dir: await repo() });
	const authCall = (await calls()).find((call) => call.bin === 'asc' && call.args[0] === 'auth');
	assert.deepEqual(authCall?.args, ['auth', 'status', '--validate', '--output', 'json']);
});

test('--json emits the report as JSON rather than a table', async () => {
	asc();
	npx();
	const { out } = await doctor({ flags: { json: true }, dir: await repo() });
	const parsed = JSON.parse(out);
	assert.ok(parsed.rows.some((row) => row.name === 'node'));
});

test('a credential that is not the default, and a second one, are both named', async () => {
	asc({ auth: { credentials: [{ name: 'Team', keyId: 'ABC', isDefault: false }, { name: 'Other', keyId: 'DEF' }] } });
	npx();
	const { out } = await doctor({ dir: await repo() });
	assert.match(out, /NOT default/);
	assert.match(out, /\+1 more/);
});

test('a credential whose validation is not "works" fails rather than warns', async () => {
	asc({ auth: { credentials: [{ name: 'Team', keyId: 'ABC', isDefault: true, validation: 'expired' }], warnings: ['clock skew'] } });
	npx();
	const { code, out } = await doctor({ dir: await repo() });
	assert.equal(code, 1);
	assert.match(out, /validation: expired/);
	assert.match(out, /clock skew/);
});

test('a validation of "works" is the one value that stays green', async () => {
	asc({ auth: { credentials: [{ name: 'Team', keyId: 'ABC', isDefault: true, validation: 'works' }] } });
	npx();
	const { code } = await doctor({ dir: await repo({ config: { asc: { appId: '111' } } }) });
	assert.equal(code, 0);
});

test('no stored App Store Connect credentials is a failure', async () => {
	asc({ auth: { credentials: [] } });
	npx();
	const { code, out } = await doctor({ dir: await repo() });
	assert.equal(code, 1);
	assert.match(out, /asc auth login/);
});

test('missing Apple Ads credentials warn, because they are a separate store', async () => {
	asc({ ads: { credentials: [] } });
	npx();
	const { code, out } = await doctor({ dir: await repo({ config: { asc: { appId: '111' } } }) });
	assert.equal(code, 0, 'a warning is not a failure');
	assert.match(out, /no Apple Ads credentials/);
});

test('with no active Apple Ads credential the first one is named, and the count pluralises', async () => {
	asc({ ads: { credentials: [{ name: 'First' }, { name: 'Second' }] } });
	npx();
	const { out } = await doctor({ dir: await repo() });
	assert.match(out, /First \(2 credentials\)/);
});

test('asc missing from PATH skips both auth checks instead of running them', async () => {
	npx();
	const saved = process.env.PATH;
	process.env.PATH = NPX_ONLY;
	try {
		const { code, out } = await doctor({ dir: await repo() });
		assert.equal(code, 1);
		assert.match(out, /not on PATH/);
		assert.match(out, /skipped: asc missing/);
	} finally {
		process.env.PATH = saved;
	}
});

test('an unreachable eas-cli skips the account check rather than reporting it logged out', async () => {
	asc();
	npx({ version: '', versionCode: 1 });
	const { code, out } = await doctor({ dir: await repo() });
	assert.equal(code, 1);
	assert.match(out, /exited 1/);
	assert.match(out, /skipped: eas-cli unreachable/);
});

test('a logged-out eas account warns', async () => {
	asc();
	npx({ whoami: 'Not logged in' });
	const { out } = await doctor({ dir: await repo() });
	assert.match(out, /logged out/);
});

test('an empty whoami warns too, without pretending the account is named ""', async () => {
	asc();
	npx({ whoami: '', whoamiCode: 1 });
	const { out } = await doctor({ dir: await repo() });
	assert.match(out, /logged out/);
});

test('RevenueCat reports the projects the repo key can see, and switching is named', async () => {
	asc();
	npx();
	await mkdir(join(HOME, '.omp', 'revenuecat'), { recursive: true });
	await writeFile(join(HOME, '.omp', 'revenuecat', 'demo.key'), 'project-key');
	const dir = await repo({ config: { revenuecat: { projectId: 'projX', key: 'demo' } } });
	const { out } = await doctor({
		dir,
		fetch: async (url) => {
			const href = String(url);
			if (href.includes('127.0.0.1:8089')) return astroDown();
			if (href.includes('/projects/projX')) return json({ id: 'projX' });
			return json({ items: [{ id: 'projX', name: 'Demo' }] });
		},
	});
	assert.match(out, /1 project: Demo/);
	assert.match(out, /via ~?.*demo\.key/);
});

test('a RevenueCat error is reported as a failed check, not thrown', async () => {
	asc();
	npx();
	const { code, out } = await doctor({
		dir: await repo(),
		fetch: async (url) => (String(url).includes('127.0.0.1:8089') ? astroDown() : json({ message: 'bad key' }, 401)),
	});
	assert.equal(code, 1);
	assert.match(out, /revenuecat/);
});

test('every MCP config source is searched, and a reachable Astro is reported', async () => {
	asc();
	npx();
	const dir = await repo();
	await writeFiles(dir, { '.mcp.json': { mcpServers: { revenuecat: {} } }, '.omp/mcp.json': { mcpServers: { astro: {} } } });
	await writeFiles(HOME, { '.claude.json': { mcpServers: {}, projects: { [dir]: { mcpServers: { 'apple-ads': {} } } } } });
	const { out } = await doctor({
		dir,
		fetch: async (url) => (String(url).includes('127.0.0.1:8089') ? new Response('ok') : json({ items: [] })),
	});
	assert.match(out, /mcp revenuecat/);
	assert.match(out, /astro endpoint/);
	assert.match(out, /reachable at/);
});

test('an undeclared MCP server is a skip that names the fix', async () => {
	asc();
	npx();
	const { out } = await doctor({ dir: await repo() });
	assert.match(out, /ship init` to wire MCP/);
});

test('no ship.config.json skips the repo checks entirely', async () => {
	asc();
	npx();
	const { out } = await doctor({ dir: await repo({ config: null }) });
	assert.match(out, /no ship.config.json from/);
});

test('a repo with no asc.appId fails, because nothing downstream can resolve the app', async () => {
	asc();
	npx();
	const { code, out } = await doctor({ dir: await repo() });
	assert.equal(code, 1);
	assert.match(out, /no asc.appId/);
});

test('an appId that resolves to nothing fails naming the id', async () => {
	asc({ app: {} });
	npx();
	const { code, out } = await doctor({ dir: await repo({ config: { asc: { appId: '999' } } }) });
	assert.equal(code, 1);
	assert.match(out, /id 999 did not resolve/);
});

test('an app whose bundle id disagrees with ship.config.json fails', async () => {
	asc({ app: { data: { attributes: { name: 'Demo', bundleId: 'com.other.app' } } } });
	npx();
	const { code, out } = await doctor({ dir: await repo({ config: { asc: { appId: '111' } } }) });
	assert.equal(code, 1);
	assert.match(out, /com\.other\.app, ship\.config\.json says com\.demo\.app/);
});

test('an app with no bundle id at all still reports, rather than reading as a mismatch', async () => {
	asc({ app: { data: { attributes: { name: 'Demo' } } } });
	npx();
	const { code, out } = await doctor({ dir: await repo({ config: { asc: { appId: '111' } } }) });
	assert.equal(code, 0);
	assert.match(out, /no bundle id/);
});

test('app.json without ios.bundleIdentifier skips the cross-check instead of failing', async () => {
	asc();
	npx();
	const dir = await repo({ config: { asc: { appId: '111' } }, files: { 'app.json': { expo: { name: 'Demo' } } } });
	const { code, out } = await doctor({ dir });
	assert.equal(code, 0);
	assert.match(out, /app.config.ts\/js/);
});

test('app.json that disagrees with ship.config.json fails', async () => {
	asc();
	npx();
	const dir = await repo({ config: { asc: { appId: '111' } }, files: { 'app.json': { expo: { ios: { bundleIdentifier: 'com.stale.app' } } } } });
	const { code, out } = await doctor({ dir });
	assert.equal(code, 1);
	assert.match(out, /app\.json says com\.stale\.app/);
});

test('an empty store/staged warns, and so does a missing aso dir', async () => {
	asc();
	npx();
	const dir = await repo({ config: { asc: { appId: '111' } } });
	await mkdir(join(dir, 'store', 'staged'), { recursive: true });
	const { code, out } = await doctor({ dir });
	assert.equal(code, 0);
	assert.match(out, /is empty/);
	assert.match(out, /ship aso harvest/);
});

test('an old node runtime fails the very first check', async () => {
	asc();
	npx();
	const real = process.versions.node;
	Object.defineProperty(process.versions, 'node', { value: '18.19.0', configurable: true });
	try {
		const { code, out } = await doctor({ dir: await repo() });
		assert.equal(code, 1);
		assert.match(out, /needs node >= 20/);
	} finally {
		Object.defineProperty(process.versions, 'node', { value: real, configurable: true });
	}
});

test('an asc that answers with nothing reads as no credentials, not as a crash', async () => {
	setBin('asc', []);
	npx();
	const { code, out } = await doctor({ dir: await repo() });
	assert.equal(code, 1);
	assert.match(out, /no stored App Store Connect credentials/);
	assert.match(out, /no Apple Ads credentials/);
});

test('the agent-level mcp config counts, and a file declaring no servers is skipped', async () => {
	asc();
	npx();
	const dir = await repo();
	await writeFiles(dir, { '.mcp.json': { version: 1 } });
	await writeFiles(HOME, { '.omp/agent/mcp.json': { mcpServers: { astro: {} } }, '.claude.json': {} });
	const { out } = await doctor({ dir });
	assert.match(out, /mcp astro/);
	assert.match(out, /agent\/mcp\.json/);
});

test('a non-Error thrown by the RevenueCat client is still reported as text', async () => {
	asc();
	npx();
	const { code, out } = await doctor({
		dir: await repo(),
		fetch: async (url) => {
			if (String(url).includes('8089')) return astroDown();
			throw 'socket hang up';
		},
	});
	assert.equal(code, 1);
	assert.match(out, /socket hang up/);
});

test('several staged locales pluralise', async () => {
	asc();
	npx();
	const dir = await repo({ config: { asc: { appId: '111' } }, files: { 'store/staged/en-US.json': {}, 'store/staged/de-DE.json': {}, 'store/staged/notes.txt': 'ignored' } });
	const { out } = await doctor({ dir });
	assert.match(out, /2 locale files/);
});
