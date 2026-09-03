// collectRevenue's "no RevenueCat API key" branch, isolated in its own process
// (node --test gives each file its own process) so it cannot race against the
// other status-biz tests that deliberately set REVENUECAT_V2_KEY — and so it
// never depends on whether this machine happens to have a real ~/.omp/revenuecat.key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

delete process.env.REVENUECAT_V2_KEY;
delete process.env.REVENUECAT_API_KEY;
// apiKey() falls back to ~/.omp/revenuecat.key when the env vars are unset;
// HOME is pointed at an empty temp dir so that fallback finds nothing here.
const fakeHome = await mkdtemp(join(tmpdir(), 'ship-fake-home-'));
process.env.HOME = fakeHome;

const { collectRevenue } = await import('../src/lib/status-biz.mjs');

test('collectRevenue reports skipped when there is no RevenueCat API key anywhere', async () => {
	const d = await collectRevenue({ cfg: { revenuecat: {} } });
	assert.equal(d.skipped, 'no RevenueCat API key');
});

test.after(async () => {
	await rm(fakeHome, { recursive: true, force: true });
});
