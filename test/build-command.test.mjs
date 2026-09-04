// `ship build` — the EAS invocation and, the reason this is a command at all,
// the native baseline it leaves behind for `ship ota` to diff against.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['npx']);

const { run } = await import('../src/commands/build.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0', eas: { profile: 'production', platform: 'ios' } };
const APP_JSON = { expo: { version: '1.2.0', platforms: ['ios'], ios: { bundleIdentifier: 'com.demo.app' } } };
const PKG = { name: 'demo', dependencies: { 'expo-updates': '~0.25.0', react: '19.0.0' } };

/** @param {{flags?: object, dir: string, args?: string[]}} opts */
async function build({ flags = {}, dir, args = [] }) {
	await resetCalls();
	setBin('npx', [['eas-cli@latest build', { out: '' }]]);
	const { result, out } = await capture(() => inDir(dir, () => run({ args, flags })));
	return { code: result, out };
}

const buildRepo = (files = {}) => repo({ config: CONFIG, files: { 'app.json': APP_JSON, 'package.json': PKG, ...files }, prefix: 'ship-build-' });
const lockOf = (dir) => readFile(join(dir, '.asc', 'native-lock.json'), 'utf8').then(JSON.parse);

test('build takes no arguments and refuses --local on this host', async () => {
	const dir = await buildRepo();
	await assert.rejects(() => build({ dir, args: ['now'] }), /unexpected argument "now"/);
	await assert.rejects(() => build({ dir, flags: { local: true } }), /local iOS builds are not possible on this host/);
});

test('a build records the native baseline OTA is judged against', async () => {
	const dir = await buildRepo();
	const { code, out } = await build({ dir });
	assert.equal(code, 0);
	const lock = await lockOf(dir);
	assert.equal(lock.version, '1.2.0');
	assert.equal(lock.profile, 'production');
	assert.equal(lock.queued, false);
	assert.deepEqual(Object.keys(lock.deps), ['expo-updates'], 'only the native dependencies are pinned');
	assert.match(out, /no baseline on record yet/);
	assert.match(out, /native baseline written/);

	const eas = (await calls())[0];
	assert.deepEqual(eas.args.slice(1), ['eas-cli@latest', 'build', '--platform', 'ios', '--profile', 'production', '--non-interactive']);
});

test('a second build reports the baseline it replaces', async () => {
	const dir = await buildRepo();
	await build({ dir });
	const { out } = await build({ dir });
	assert.match(out, /previous baseline: 1.2.0 recorded/);
});

test('--no-wait queues the build and says the baseline is a queue-time one', async () => {
	const dir = await buildRepo();
	const { code, out } = await build({ dir, flags: { 'no-wait': true } });
	assert.equal(code, 0);
	assert.equal((await lockOf(dir)).queued, true);
	assert.match(out, /not waiting/);
	assert.match(out, /baseline recorded at queue time/);
	assert.ok((await calls())[0].args.includes('--no-wait'));

	const explicit = await buildRepo();
	await build({ dir: explicit, flags: { wait: 'false' } });
	assert.equal((await lockOf(explicit)).queued, true);
});

test('--json prints a summary instead of eas output', async () => {
	const dir = await buildRepo();
	const { out } = await build({ dir, flags: { json: true, profile: 'preview' } });
	const summary = JSON.parse(out.slice(out.indexOf('{')));
	assert.equal(summary.profile, 'preview');
	assert.equal(summary.version, '1.2.0');
});

test('--dry-run queues nothing and leaves the lock exactly as it was', async () => {
	const dir = await buildRepo();
	setDryRun(true);
	try {
		const { code, out } = await build({ dir, flags: { json: true } });
		assert.equal(code, 0);
		assert.match(out, /native baseline left exactly as it was/);
		assert.equal(JSON.parse(out.slice(out.indexOf('{'))).dryRun, true);
		assert.ok(!existsSync(join(dir, '.asc', 'native-lock.json')));
	} finally {
		setDryRun(false);
	}
});
