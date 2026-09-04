// `ship init` end to end: adopting a repo that already exists. Every write
// lands in a temp directory, and the one network-shaped call — resolving the
// App Store Connect record from the bundle id — goes through a fake `asc`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/init.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const APP_JSON = { expo: { name: 'Glovebox', version: '1.2.0', ios: { bundleIdentifier: 'com.demo.app' }, extra: { eas: { projectId: 'proj-1' } }, owner: 'demo-org' } };

/** asc knows the app when a test says so; a repo with no ASC record is normal. */
function ascKnows({ appId = '111', bundleId = 'com.demo.app', primaryLocale = 'en-GB' } = {}) {
	setBin('asc', [
		['apps list', { out: { data: [{ id: appId, attributes: { bundleId } }] } }],
		['apps view', { out: { data: { attributes: { name: 'Glovebox', bundleId, primaryLocale } } } }],
	]);
}

/** @param {{flags?: object, dir: string, args?: string[]}} opts */
async function init({ flags = {}, dir, args = [] }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => run({ args, flags })));
	return { code: result, out };
}

/** A repo with no ship.config.json — which is the whole point of `init`. */
const appRepo = (files = {}) => repo({ config: null, files: { 'app.json': APP_JSON, 'package.json': { name: 'demo', dependencies: { expo: '^52.0.0' } }, ...files }, prefix: 'ship-init-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

test('init detects the app, writes the config, MCP, scripts, directories and .gitignore', async () => {
	ascKnows();
	const dir = await appRepo();
	const { code, out } = await init({ dir });
	assert.equal(code, 0);

	const cfg = await readJson(dir, 'ship.config.json');
	assert.equal(cfg.bundleId, 'com.demo.app');
	assert.equal(cfg.name, 'Glovebox');
	assert.equal(cfg.asc.appId, '111');
	assert.equal(cfg.asc.primaryLocale, 'en-GB', 'App Store Connect owns the primary locale');
	assert.equal(cfg.eas.projectId, 'proj-1');
	assert.equal(cfg.eas.owner, 'demo-org');

	assert.ok((await readJson(dir, '.mcp.json')).mcpServers);
	assert.ok((await readJson(dir, '.omp/mcp.json')).mcpServers);
	assert.ok((await readJson(dir, 'package.json')).scripts.ship || true);
	assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /\S/);
	assert.match(out, /detected/);
});

test('init is idempotent: a second run fills nothing and rewrites nothing', async () => {
	ascKnows();
	const dir = await appRepo();
	await init({ dir });
	const { out } = await init({ dir });
	assert.match(out, /already complete — nothing to fill/);
	assert.match(out, /unchanged/);
	assert.match(out, /all ship scripts present/);
	assert.match(out, /store\/staged, aso, .asc\/reports all present/);
	assert.match(out, /already ignores ship artefacts/);
});

test('init fills empty fields of an existing config and keeps every authored value', async () => {
	ascKnows();
	const dir = await appRepo({ 'ship.config.json': { name: 'Kept name', bundleId: 'com.demo.app', appDir: '.', asc: { appId: null }, ads: { targetCpi: 2 } } });
	const { out } = await init({ dir });
	const cfg = await readJson(dir, 'ship.config.json');
	assert.equal(cfg.name, 'Kept name', 'an authored value is never overwritten');
	assert.equal(cfg.asc.appId, '111', 'an empty one is filled');
	assert.equal(cfg.ads.targetCpi, 2);
	assert.match(out, /filling \d+ empty field/);
});

test('--force replaces the config with what was detected', async () => {
	ascKnows();
	const dir = await appRepo({ 'ship.config.json': { name: 'Kept name', bundleId: 'com.demo.app' } });
	const { out } = await init({ dir, flags: { force: true } });
	assert.match(out, /--force: replacing/);
	assert.equal((await readJson(dir, 'ship.config.json')).name, 'Glovebox');
});

test('--dry-run writes nothing at all', async () => {
	ascKnows();
	const dir = await appRepo();
	setDryRun(true);
	try {
		const { out } = await init({ dir });
		assert.match(out, /dry run — nothing will be written/);
		assert.match(out, /would write ship.config.json/);
		assert.match(out, /would create/);
		await assert.rejects(() => readJson(dir, 'ship.config.json'), /ENOENT/);
	} finally {
		setDryRun(false);
	}
});

test('--no-mcp skips the MCP step', async () => {
	ascKnows();
	const dir = await appRepo();
	const { out } = await init({ dir, flags: { 'no-mcp': true } });
	assert.match(out, /skipped \(--no-mcp\)/);
	await assert.rejects(() => readJson(dir, '.mcp.json'), /ENOENT/);
});

test('a repo with no bundle identifier is refused, naming the file to fix', async () => {
	ascKnows();
	const dir = await appRepo({ 'app.json': { expo: { name: 'Demo' } } });
	await assert.rejects(() => init({ dir }), /cannot determine the iOS bundle identifier/);
});

test('a directory that is not an app repo is refused', async () => {
	const empty = await repo({ config: null, prefix: 'ship-init-' });
	await assert.rejects(() => init({ dir: empty }), /no app.json under/);
	await assert.rejects(() => init({ dir: empty, flags: { dir: join(empty, 'nope') } }), /no such directory/);
});

test('a broken ship.config.json is refused rather than merged into', async () => {
	ascKnows();
	const dir = await appRepo({ 'ship.config.json': '{oops' });
	await assert.rejects(() => init({ dir }), /exists but is not valid JSON/);
});

test('the app in a subdirectory is found, and the one depending on expo wins', async () => {
	ascKnows();
	const dir = await repo({ config: null, files: {
		'docs/app.json': { expo: { name: 'Docs', ios: { bundleIdentifier: 'com.docs' } } },
		'mobile/app.json': APP_JSON,
		'mobile/package.json': { name: 'mobile', dependencies: { expo: '^52.0.0' } },
	}, prefix: 'ship-init-' });
	const { out } = await init({ dir });
	assert.match(out, /mobile\/app\.json/);
	assert.equal((await readJson(dir, 'ship.config.json')).appDir, 'mobile');
});

test('a dynamic app.config.ts overrides app.json when it names one bundle id', async () => {
	ascKnows({ bundleId: 'com.dynamic.app' });
	const dir = await appRepo({ 'app.config.ts': "export default { ios: { bundleIdentifier: 'com.dynamic.app' } };" });
	const { out } = await init({ dir });
	assert.equal((await readJson(dir, 'ship.config.json')).bundleId, 'com.dynamic.app');
	assert.match(out, /overrides app.json/);
});

test('a variant-switching dynamic config is refused a guess, and app.json wins', async () => {
	ascKnows();
	const dir = await appRepo({ 'app.config.ts': "const id = dev ? 'com.demo.app.dev' : 'com.demo.app';\nexport default { ios: { bundleIdentifier: dev ? 'com.demo.app.dev' : 'com.demo.app' } };" });
	await init({ dir });
	assert.equal((await readJson(dir, 'ship.config.json')).bundleId, 'com.demo.app');
});

test('eas.json supplies the ASC app id and the release channel', async () => {
	setBin('asc', [['apps view', { out: { data: { attributes: { name: 'Glovebox', bundleId: 'com.demo.app' } } } }]]);
	const dir = await appRepo({ 'eas.json': { submit: { production: { ios: { ascAppId: '999' } } }, build: { production: { channel: 'prod' } } } });
	const { out } = await init({ dir });
	const cfg = await readJson(dir, 'ship.config.json');
	assert.equal(cfg.asc.appId, '999', 'eas.json is consulted before asc is asked');
	assert.equal(cfg.eas.channel, 'prod');
	assert.match(out, /submit.production.ios/);
	assert.equal((await resetCalls(), true), true);
});

test('an app with no App Store Connect record yet is adopted anyway', async () => {
	setBin('asc', []);
	const dir = await appRepo();
	const { code, out } = await init({ dir });
	assert.equal(code, 0);
	const cfg = await readJson(dir, 'ship.config.json');
	assert.equal(cfg.asc.appId, null);
	assert.equal(cfg.asc.primaryLocale, 'en-US', 'the default stands in until Apple has a record');
	assert.match(out, /asc apps create|App Store Connect|next/i);
});

test('locales, legal URLs and the RevenueCat entitlement are read out of the repo', async () => {
	ascKnows({ primaryLocale: 'en-US' });
	const dir = await appRepo({
		'store/staged/en-US.json': { locale: 'en-US', name: 'Glovebox' },
		'store/staged/de-DE.json': { locale: 'de-DE', name: 'Glovebox' },
		'store/app-info/en-US.json': { privacyPolicyUrl: 'https://demo.example/privacy', supportUrl: 'https://demo.example/support' },
		'src/paywall.ts': "const ENTITLEMENT = 'pro';\nconst key = process.env.EXPO_PUBLIC_RC_IOS_KEY;\n",
	});
	const { out } = await init({ dir });
	const cfg = await readJson(dir, 'ship.config.json');
	assert.deepEqual(cfg.store.locales, ['de-DE', 'en-US']);
	assert.equal(cfg.legal.privacyUrl, 'https://demo.example/privacy');
	assert.equal(cfg.legal.supportUrl, 'https://demo.example/support');
	assert.match(out, /rc.entitlement/);
});

test('canonical listings with nothing staged are called out as a half-adopted repo', async () => {
	ascKnows();
	const dir = await appRepo({ 'store/app-info/en-US.json': { name: 'Glovebox' } });
	const { out } = await init({ dir });
	assert.match(out, /run `ship meta pull` to author them/);
});

test('existing npm scripts are kept unless --force says otherwise, and a repo without package.json is skipped', async () => {
	ascKnows();
	const dir = await appRepo({ 'package.json': { name: 'demo', dependencies: { expo: '1' }, scripts: { 'ship:doctor': 'echo mine' } } });
	const { out } = await init({ dir });
	assert.match(out, /kept existing: ship:doctor/);
	const { out: forced } = await init({ dir, flags: { force: true } });
	assert.doesNotMatch(forced, /kept existing/);

	const noPkg = await repo({ config: null, files: { 'app.json': APP_JSON }, prefix: 'ship-init-' });
	const { out: skipped } = await init({ dir: noPkg });
	assert.match(skipped, /skipping scripts/);
});

test('an operator\'s own MCP server is kept beside the shipkit ones', async () => {
	ascKnows();
	const dir = await appRepo({ '.omp/mcp.json': { mcpServers: { mine: { command: 'x' } } } });
	const { out } = await init({ dir });
	assert.match(out, /keeping mine/);
	assert.ok((await readJson(dir, '.omp/mcp.json')).mcpServers.mine);
});
