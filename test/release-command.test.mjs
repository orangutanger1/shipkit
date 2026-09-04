// `ship release` — the chain, its gates, and what it does when one fails. The
// steps are the real command modules; the repo they run against is a temp one
// with a fake `asc`, so preflight answers honestly and the later steps refuse
// for the reasons they would really refuse for.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, setBin, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc', 'npx']);

const { run } = await import('../src/commands/release.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const CONFIG = {
	name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0',
	asc: { appId: '111', primaryLocale: 'en-US' },
	store: { locales: ['en-US'] },
	legal: { privacyUrl: null, supportUrl: null, euTrader: null },
};
const APP_JSON = { expo: { version: '1.2.0', ios: { bundleIdentifier: 'com.demo.app', infoPlist: { ITSAppUsesNonExemptEncryption: false } } } };

/** @param {string[]} args @param {{flags?: object, dir: string}} opts */
async function release(args, { flags = {}, dir }) {
	setBin('asc', []);
	const { result, out } = await capture(() =>
		inDir(dir, () => withFetch(async () => json({ items: [] }), () => run({ args, flags }))),
	);
	return { code: result, out };
}

const releaseRepo = (files = {}) => repo({ config: CONFIG, files: { 'app.json': APP_JSON, ...files }, prefix: 'ship-release-' });

test('release takes no arguments and only the four steps it has', async () => {
	const dir = await releaseRepo();
	await assert.rejects(() => release(['now'], { dir }), /unexpected argument "now"/);
	await assert.rejects(() => release([], { dir, flags: { from: 'ship-it' } }), /unknown step "ship-it"/);
});

test('every step can be skipped, and the summary says why each was', async () => {
	const dir = await releaseRepo();
	const { code, out } = await release([], { dir, flags: { from: 'build', 'skip-build': true, 'skip-submit': true } });
	assert.equal(code, 0);
	assert.match(out, /resuming at build — earlier steps assumed done/);
	assert.match(out, /before --from build/);
	assert.match(out, /--skip-build/);
	assert.match(out, /--skip-submit/);
	assert.match(out, /Demo 1.2.0 released/);
	assert.match(out, /ship status --version 1.2.0/);
});

test('a failing step stops the chain and names the resume command', async () => {
	const dir = await releaseRepo();
	await assert.rejects(
		() => release([], { dir, flags: { offline: true, 'skip-build': true, 'skip-submit': true } }),
		/release stopped: preflight exited 1/,
	);
});

test('--force keeps going past a failure and reports it in the summary', async () => {
	const dir = await releaseRepo();
	const { code, out } = await release([], { dir, flags: { offline: true, force: true, 'skip-build': true, 'skip-submit': true } });
	assert.equal(code, 1, 'the chain finished, but the release did not succeed');
	assert.match(out, /--force: a failing step will not stop the chain/);
	assert.match(out, /preflight failed \(exit 1\)|preflight threw/);
	assert.match(out, /release completed with failures/);
	assert.match(out, /ship release --from preflight/);
});

test('a step that throws is caught under --force, and the summary marks it failed', async () => {
	const dir = await releaseRepo();
	const { code, out } = await release([], { dir, flags: { from: 'build', force: true, 'skip-submit': true } });
	assert.equal(code, 1);
	assert.match(out, /(threw|failed \(exit)/);
	assert.match(out, /failed/);
});

test('--dry-run narrates the chain without mutating anything', async () => {
	const dir = await releaseRepo();
	setDryRun(true);
	try {
		const { code, out } = await release([], { dir, flags: { from: 'build', 'skip-build': true, 'skip-submit': true } });
		assert.equal(code, 0);
		assert.match(out, /dry run — every step narrates its mutations/);
		assert.match(out, /nothing was mutated/);
	} finally {
		setDryRun(false);
	}
});
