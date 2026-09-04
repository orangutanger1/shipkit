// The one `ship doctor` branch that cannot share a process with the others:
// apiKey() caches its answer, so a run with no RevenueCat key anywhere needs a
// process where the key was never set. Everything else is covered in
// doctor-command.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, setBin, withFetch } from './fixtures/cmd.mjs';

delete process.env.REVENUECAT_V2_KEY;
delete process.env.REVENUECAT_API_KEY;
await fakeHome();
await fakeBins(['asc', 'npx']);

const { run } = await import('../src/commands/doctor.mjs');

test('with no key anywhere, RevenueCat is skipped and the fix is named', async () => {
	setBin('asc', [['^ads auth status', { out: { credentials: [{ name: 'Ads' }] } }], ['^auth status', { out: { credentials: [{ name: 'T', keyId: 'K', isDefault: true }] } }]]);
	setBin('npx', [['--version', { out: '16.0.0' }], ['whoami', { out: 'demo' }]]);
	const dir = await repo();
	const { out } = await capture(() =>
		inDir(dir, () => withFetch(async (url) => (String(url).includes('8089') ? Promise.reject(new Error('down')) : json({ items: [] })), () => run({ args: [], flags: {} }))),
	);
	assert.match(out, /REVENUECAT_V2_KEY/);
	assert.match(out, /revenuecat\.key/);
});
