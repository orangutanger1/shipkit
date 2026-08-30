// The native fingerprint decides whether an OTA can brick installed clients,
// so its two historical blind spots get their own tests: scoped packages that
// carry native code but do not start with `react-native-`, and ranges that
// moved inside node_modules without package.json changing (the 2026-08-25
// incident family).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeDep, nativeFingerprint, otaSafety } from '../src/lib/native.mjs';

test('scoped packages that embed native code are not classified as pure JS', () => {
	assert.equal(isNativeDep('posthog-react-native'), true);
	assert.equal(isNativeDep('@notifee/react-native'), true);
	assert.equal(isNativeDep('@shopify/react-native-skia'), true);
	assert.equal(isNativeDep('react-native-purchases'), true);
});

test('unknown packages default to native: a false unsafe costs a rebuild, a false safe costs the app', () => {
	assert.equal(isNativeDep('@shopify/flash-list'), true);
	assert.equal(isNativeDep('some-totally-unknown-package'), true);
});

test('the pure-JS allowlist still exempts tooling and react itself', () => {
	assert.equal(isNativeDep('react'), false);
	assert.equal(isNativeDep('typescript'), false);
	assert.equal(isNativeDep('zod'), false);
});

async function withApp(files, fn) {
	const root = await mkdtemp(join(tmpdir(), 'ship-native-'));
	const app = join(root, 'app');
	for (const [rel, content] of Object.entries(files)) {
		const file = join(app, rel);
		await mkdir(join(file, '..'), { recursive: true });
		await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, '\t'));
	}
	// native-lock.json lives at the repo root (.asc/), not inside the app dir.
	async function writeLock(lock) {
		await mkdir(join(root, '.asc'), { recursive: true });
		await writeFile(join(root, '.asc', 'native-lock.json'), JSON.stringify(lock, null, '\t'));
	}
	try {
		return await fn({ root, app, writeLock });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const pkg = {
	dependencies: {
		expo: '~52.0.0',
		'posthog-react-native': '^4.63.0',
		react: '19.0.0',
	},
};

test('the fingerprint records the node_modules-resolved version, not the declared range', async () => {
	await withApp(
		{
			'package.json': pkg,
			'node_modules/expo/package.json': { name: 'expo', version: '52.1.1' },
			'node_modules/posthog-react-native/package.json': { name: 'posthog-react-native', version: '4.63.6' },
		},
		async ({ app }) => {
			const deps = await nativeFingerprint(app);
			// `npm update` moved these inside the ranges without touching package.json.
			assert.equal(deps.expo, '52.1.1');
			assert.equal(deps['posthog-react-native'], '4.63.6');
			assert.equal(deps.react, undefined);
		},
	);
});

test('without node_modules the fingerprint falls back to the declared range', async () => {
	await withApp({ 'package.json': pkg }, async ({ app }) => {
		const deps = await nativeFingerprint(app);
		assert.equal(deps.expo, '~52.0.0');
	});
});

test('a lockfile-resolved version change inside a declared range is OTA UNSAFE', async () => {
	await withApp(
		{
			'package.json': pkg,
			'node_modules/expo/package.json': { name: 'expo', version: '52.1.1' },
			'node_modules/posthog-react-native/package.json': { name: 'posthog-react-native', version: '4.63.6' },
		},
		async ({ root, app, writeLock }) => {
			await writeLock({
				version: '1.0.0',
				deps: { expo: '52.0.3', 'posthog-react-native': '4.63.6' },
				config: {},
			});
			const verdict = await otaSafety({ root, paths: { app } }, '1.0.0');
			// package.json is byte-identical to build time; the binary is not.
			assert.equal(verdict.safe, false);
			assert.deepEqual(verdict.changed, ['expo']);
		},
	);
});

test('identical resolved versions are OTA SAFE', async () => {
	await withApp(
		{
			'package.json': pkg,
			'node_modules/expo/package.json': { name: 'expo', version: '52.0.3' },
			'node_modules/posthog-react-native/package.json': { name: 'posthog-react-native', version: '4.63.6' },
		},
		async ({ root, app, writeLock }) => {
			await writeLock({
				version: '1.0.0',
				deps: { expo: '52.0.3', 'posthog-react-native': '4.63.6' },
				config: {},
			});
			const verdict = await otaSafety({ root, paths: { app } }, '1.0.0');
			assert.equal(verdict.safe, true);
		},
	);
});
