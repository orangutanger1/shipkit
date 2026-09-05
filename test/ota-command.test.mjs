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

test('a corrupted lock file with no readable version for a dependency still renders the drift table', async () => {
	// native-lock.json is untrusted JSON off disk — a stale schema or a
	// hand-edit can leave a dep entry with no string version at all. The table
	// has to say "unknown" rather than throw building the row.
	const dir = await otaRepo({ '.asc/native-lock.json': { version: '1.2.0', builtAt: '2026-08-01T00:00:00.000Z', deps: { 'expo-updates': null, 'react-native-purchases': null }, config: {} } });
	const { out } = await ota({ dir, flags: { check: true } });
	assert.match(out, /OTA UNSAFE/);
	assert.match(out, /react-native-purchases/, 'removed: lock had no readable version for it');
	assert.match(out, /expo-updates/, 'changed: the lock side of the arrow is unknown');
	assert.match(out, /\? →/);
});

test('a protocol-1 multipart manifest response is read up to its boundary', async () => {
	innerBins();
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	const dir = await otaRepo();
	const multipart = async () => new Response('{"id":"upd-1"}\n---boundary\nContent-Type: text/plain\n\nignored\n');
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: multipart });
	assert.equal(code, 0);
	assert.match(out, /production serves update upd-1/);
});

test('a bundle exported as plain .js, not Hermes bytecode, is still found and verified', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.js': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: JSON.stringify([{ id: 'upd-1', platform: 'ios' }]) }],
	]);
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
	assert.equal(code, 0);
	assert.match(out, /index-abc\.js verified/);
});

test('an optional EXPO_PUBLIC_ value that did not inline is a note, not a refusal', async () => {
	innerBins();
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	process.env.EXPO_PUBLIC_OPTIONAL = 'never-lands-in-the-bundle';
	const dir = await otaRepo();
	try {
		const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
		assert.equal(code, 0);
		assert.match(out, /EXPO_PUBLIC_OPTIONAL defined but not inlined — fine if they are optional/);
	} finally {
		delete process.env.EXPO_PUBLIC_OPTIONAL;
	}
});

test('eas update publishing with no id at all for any platform is refused, not silently accepted', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: JSON.stringify([{ platform: 'android' }]) }],
	]);
	const dir = await otaRepo();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/eas update published nothing identifiable for ios/,
	);
});

test('eas update publishing one entry for a different platform than requested is still checked, by falling back to it', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: JSON.stringify([{ id: 'upd-x', platform: 'android' }]) }],
	]);
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-x') });
	assert.equal(code, 0);
	assert.match(out, /ios: production serves update upd-x/);
});

test('a served manifest with no id of its own is named "no update", not undefined', async () => {
	innerBins();
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	const dir = await otaRepo();
	await assert.rejects(
		() =>
			ota({
				dir,
				flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') },
				fetch: async () => new Response('{"note":"nothing recognisable"}'),
			}),
		/production serves no update for ios, not the upd-1 just published/,
	);
});

test('an environment nulled out of the config defaults to production, in both halves', async () => {
	// eas.environment is DEFAULTS-backed like everything else in ship.config.json,
	// so it is always 'production' unless the operator writes `"environment":
	// null` — deepMerge honours that the way it honours any other null override.
	const dir = await otaRepo({}, { eas: { channel: 'production', environment: null } });
	const { out } = await ota({ dir, flags: { check: true } });
	assert.match(out, /environment production/);

	innerBins();
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	const { out: innerOut } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
	assert.match(innerOut, /production serves update upd-1/);
});

test('an eas update call that answers with no parseable JSON at all is "nothing identifiable", not a crash', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: '' }],
	]);
	const dir = await otaRepo();
	await assert.rejects(
		() => ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') } }),
		/eas update published nothing identifiable for ios/,
	);
});

test('--platforms all exports and verifies every platform, not just ios', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export --platform ios', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['expo export --platform android', { out: '', files: { 'dist/_expo/static/js/android/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: JSON.stringify([{ id: 'upd-1', platform: 'ios' }, { id: 'upd-2', platform: 'android' }]) }],
	]);
	const byPlatform = async (_url, opts) => new Response(`{"id":"${opts.headers['expo-platform'] === 'android' ? 'upd-2' : 'upd-1'}"}`);
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { inner: true, platforms: 'all', 'message-b64': Buffer.from('fix').toString('base64') }, fetch: byPlatform });
	assert.equal(code, 0);
	assert.match(out, /ios: production serves update upd-1/);
	assert.match(out, /android: production serves update upd-2/);
});

test('eas update answering with a single object, not an array, still publishes and verifies', async () => {
	process.env.EXPO_PUBLIC_RC_IOS_KEY = 'rc-key-value';
	setBin('npx', [
		['expo export', { out: '', files: { 'dist/_expo/static/js/ios/index-abc.hbc': BUNDLE('rc-key-value') } }],
		['eas-cli@latest update', { out: JSON.stringify({ id: 'upd-1', platform: 'ios' }) }],
	]);
	const dir = await otaRepo();
	const { code, out } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
	assert.equal(code, 0);
	assert.match(out, /production serves update upd-1/);
});

test('ota.requiredEnv nulled out of the config requires nothing, rather than crashing on a missing default', async () => {
	// DEFAULTS deep-merges `ota: { requiredEnv: [] }` into every config, so this
	// key is normally always present — the one way around that default is the
	// operator explicitly writing `"ota": null`, which deepMerge honours.
	innerBins();
	delete process.env.EXPO_PUBLIC_RC_IOS_KEY;
	const dir = await otaRepo({}, { ota: null });
	const { code } = await ota({ dir, flags: { inner: true, 'message-b64': Buffer.from('fix').toString('base64') }, fetch: served('upd-1') });
	assert.equal(code, 0, 'no requiredEnv key is missing, so publishing is not refused');
});

test('an app.json with no expo.platforms at all publishes to "all", not nothing', async () => {
	setBin('npx', [['env:exec', { out: '' }]]);
	const dir = await otaRepo({ 'app.json': { expo: { name: 'Demo', version: '1.2.0', ios: { bundleIdentifier: 'com.demo.app' } } } });
	const { code } = await ota({ dir, flags: { message: 'fix' } });
	assert.equal(code, 0);
	const call = (await calls()).find((c) => c.args.includes('env:exec'));
	assert.match(call.args.join(' '), /--platforms all/);
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
