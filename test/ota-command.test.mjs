// `ship ota` end to end: the native-graph gate, the environment gate, and the
// two halves of the publish. The outer half re-execs itself under `eas
// env:exec`; the inner half is invoked directly here with --inner, which is
// exactly what that re-exec does. `eas`, `npx` and the update server are all
// stubbed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin, withFetch, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['npx', 'eas']);

const { run } = await import('../src/commands/ota.mjs');
const { setDryRun } = await import('../src/exec.mjs');
const { nativeConfigFingerprint, nativeFingerprint } = await import('../src/lib/native.mjs');

const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0', eas: { channel: 'production', environment: 'production' }, ota: { requiredEnv: ['EXPO_PUBLIC_RC_IOS_KEY'] } };
const APP_JSON = { expo: { name: 'Demo', version: '1.2.0', platforms: ['ios'], updates: { url: 'https://u.expo.dev/proj-1' }, ios: { bundleIdentifier: 'com.demo.app' } } };
const PKG = { name: 'demo', dependencies: { 'expo-updates': '~0.25.0', react: '19.0.0' } };

/**
 * The lock `ship build` would have written for this tree — fingerprinted from
 * the tree itself, so "unchanged" means what the command means by it.
 * @param {object} [over] what a test wants to differ from the built binary
 */
async function lock(dir, over = {}) {
	return {
		version: '1.2.0', builtAt: '2026-08-01T00:00:00.000Z',
		deps: await nativeFingerprint(dir), config: await nativeConfigFingerprint(dir),
		...over,
	};
}

/** @param {Record<string, unknown>} [files] @param {object} [config] */
async function otaRepo(files = {}, config = {}) {
	const dir = await repo({ config: { ...CONFIG, ...config }, files: { 'app.json': APP_JSON, 'package.json': PKG, ...files }, prefix: 'ship-ota-' });
	if (!('.asc/native-lock.json' in files)) await writeFiles(dir, { '.asc/native-lock.json': await lock(dir) });
	return dir;
}

/** @param {{flags?: object, dir: string, args?: string[], fetch?: typeof globalThis.fetch}} opts */
async function ota({ flags = {}, dir, args = [], fetch }) {
	await resetCalls();
	const call = () => inDir(dir, () => run({ args, flags }));
	const { result, out } = await capture(() => (fetch ? withFetch(fetch, call) : call()));
	return { code: result, out };
}

test('ota takes no arguments', async () => {
	const dir = await otaRepo();
	await assert.rejects(() => ota({ dir, args: ['publish'] }), /unexpected argument "publish"/);
});

test('--check on an unchanged tree reports OTA SAFE and publishes nothing', async () => {
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { check: true } });
	assert.equal(code, 0);
	assert.match(out, /OTA SAFE/);
	assert.match(out, /baseline: 1.2.0 built/);
	assert.equal((await calls()).length, 0);
});

test('a changed native dependency makes the tree unsafe, and --check exits 1', async () => {
	const dir = await otaRepo({ '.asc/native-lock.json': { version: '1.2.0', builtAt: '2026-08-01T00:00:00.000Z', deps: { 'expo-updates': '~0.24.0', 'react-native-purchases': '^8.0.0' }, config: {} } });
	const { code, out } = await ota({ dir, flags: { check: true } });
	assert.equal(code, 1);
	assert.match(out, /OTA UNSAFE/);
	assert.match(out, /expo-updates/);
	assert.match(out, /react-native-purchases/);
	assert.match(out, /run `ship build`/);
});

test('no recorded build at all is unsafe, and publishing is refused', async () => {
	const dir = await otaRepo({ '.asc/native-lock.json': null });
	const { code } = await ota({ dir, flags: { check: true } });
	assert.equal(code, 1);
	await assert.rejects(() => ota({ dir, flags: { message: 'fix' } }), /native graph drifted since the last build/);
});

test('a version bump invalidates the baseline, because runtimeVersion moved', async () => {
	const dir = await otaRepo({ '.asc/native-lock.json': { version: '1.1.0', builtAt: '2026-08-01T00:00:00.000Z', deps: {}, config: {} } });
	const { out } = await ota({ dir, flags: { check: true } });
	assert.match(out, /app version moved 1.1.0 → 1.2.0/);
});

test('a changed native config key is drift too', async () => {
	const dir = await otaRepo({ '.asc/native-lock.json': { version: '1.2.0', builtAt: '2026-08-01T00:00:00.000Z', deps: { 'expo-updates': '~0.25.0' }, config: { platforms: ['ios', 'android'] } } });
	const { out } = await ota({ dir, flags: { check: true } });
	assert.match(out, /OTA UNSAFE/);
});

test('publishing needs a message, and --force is the only way past drift', async () => {
	const dir = await otaRepo();
	await assert.rejects(() => ota({ dir, flags: {} }), /--message is required/);

	const drifted = await otaRepo({ '.asc/native-lock.json': { version: '1.2.0', builtAt: '2026-08-01T00:00:00.000Z', deps: {}, config: {} } });
	const { out } = await ota({ dir: drifted, flags: { force: true, message: 'fix paywall copy' } });
	assert.match(out, /publishing an OTA over a CHANGED NATIVE GRAPH/);
});

test('the outer half re-execs itself inside the EAS environment', async () => {
	setBin('npx', [['env:exec', { out: '' }]]);
	const dir = await otaRepo();
	const { code } = await ota({ dir, flags: { message: 'fix paywall copy', environment: 'staging', branch: 'beta' } });
	assert.equal(code, 0);
	const call = (await calls()).find((c) => c.args.includes('env:exec'));
	assert.equal(call.args[call.args.indexOf('env:exec') + 1], 'staging');
	assert.match(call.args.join(' '), /ota --inner --branch beta/);
	assert.match(call.args.join(' '), /--message-b64 [A-Za-z0-9+/=]+/, 'the message crosses the shell as base64');
});

test('a failing publish names the environment it failed in', async () => {
	setBin('npx', [['env:exec', { out: '', code: 2 }]]);
	const dir = await otaRepo();
	await assert.rejects(() => ota({ dir, flags: { message: 'fix' } }), /failed inside the production environment \(exit 2\)/);
});

test('--dry-run publishes nothing and leaves the baseline alone', async () => {
	const dir = await otaRepo();
	setDryRun(true);
	try {
		const { code, out } = await ota({ dir, flags: { message: 'fix' } });
		assert.equal(code, 0);
		assert.match(out, /dry run — no update published/);
	} finally {
		setDryRun(false);
	}
});

// ── the inner half, as `eas env:exec` invokes it ─────────────────────────────

const BUNDLE = (key) => `var x=1;/*${key}*/`;

/** expo export writes one bundle; eas update answers with the published entry. */
function innerBins({ key = 'rc-key-value', platform = 'ios', updateId = 'upd-1', updateCode = 0 } = {}) {
	setBin('npx', [
		['expo export', { out: '', files: { [`dist/_expo/static/js/${platform}/index-abc.hbc`]: BUNDLE(key) } }],
		['eas-cli@latest update', { out: JSON.stringify([{ id: updateId, platform }]), code: updateCode }],
	]);
}

const served = (id) => async () => new Response(`{"id":"${id}"}`);

test('the inner half verifies the secret reached the bundle, publishes, and checks what is served', async () => {
	innerBins();
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix paywall copy').toString('base64'), platforms: 'ios' }, fetch: served('upd-1') });
	assert.equal(code, 0);
	assert.match(out, /ios: index-abc.hbc verified \(md5 [0-9a-f]{32}\)/);
	assert.match(out, /production serves update upd-1/);
});

test('the inner half refuses to publish a bundle the secret did not reach', async () => {
	innerBins({ key: 'something-else' });
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	const dir = await otaRepo();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/did not reach the ios bundle — this is the crash, refusing to publish/,
	);
});

test('the inner half refuses when the environment does not define the key at all', async () => {
	innerBins();
	delete process.env.EXPO_PUBLIC_RC_IOS_KEY;
	const dir = await otaRepo();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/absent from the production environment/,
	);
});

test('the inner half needs a message of its own', async () => {
	const dir = await otaRepo();
	await assert.rejects(() => ota({ dir, flags: { inner: true } }), /ota inner: no message to publish/);
});

test('an export that produced no bundle, or several, is a refusal', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [['expo export', { out: '' }]]);
	const dir = await otaRepo();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/expo export produced nothing to verify/,
	);

	setBin('npx', [['expo export', { out: '', files: { 'dist/_expo/static/js/ios/a.hbc': 'x', 'dist/_expo/static/js/ios/b.hbc': 'y' } }]]);
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/expected exactly one ios bundle .*found 2/,
	);
});

test('a failing eas update, and a branch serving something else, are both reported', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	innerBins({ updateCode: 1 });
	const dir = await otaRepo();
	await assert.rejects(() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }), /eas update failed \(exit 1\)/);

	innerBins();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-other') }),
		/serves upd-other for ios, not the upd-1 just published/,
	);
});

test('an update server that answers badly is reported as such', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	innerBins();
	const dir = await otaRepo();
	const flags = { inner: true, 'message-b64': Buffer.from('fix').toString('base64') };
	await assert.rejects(() => ota({ dir, flags, fetch: async () => new Response('nope', { status: 500 }) }), /answered 500 for the ios manifest/);
	await assert.rejects(() => ota({ dir, flags, fetch: async () => new Response('no manifest here') }), /answered with no manifest at all/);
	await assert.rejects(() => ota({ dir, flags, fetch: async () => new Response('{not json') }), /something that is not a manifest/);
});

test('without expo.updates.url the inner half says it cannot verify what is served', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	innerBins();
	const dir = await otaRepo({ 'app.json': { expo: { ...APP_JSON.expo, updates: undefined } } });
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } });
	assert.equal(code, 0);
	assert.match(out, /cannot verify what production serves/);
});

test('an environment with no EXPO_PUBLIC_ values at all is a warning, not a crash', async () => {
	const saved = Object.keys(process.env).filter((k) => k.startsWith('EXPO_PUBLIC_'));
	const values = saved.map((k) => [k, process.env[k]]);
	for (const k of saved) delete process.env[k];
	try {
		innerBins();
		const dir = await otaRepo({}, { ota: { requiredEnv: [] } });
		const { out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
		assert.match(out, /defines no EXPO_PUBLIC_\* values/);
	} finally {
		for (const [k, v] of values) process.env[k] = v;
	}
});
