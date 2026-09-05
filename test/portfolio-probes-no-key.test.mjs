// revenueProbe's "no RevenueCat API key" branch, isolated in its own process
// (node --test gives each file its own process) so it cannot race against
// portfolio-probes.test.mjs, which deliberately sets REVENUECAT_V2_KEY — and
// apiKey() caches its answer for the life of the process, so the two cannot
// share one.
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

const { liveContext } = await import('../src/lib/portfolio-probes.mjs');

test('the revenue probe skips instead of throwing when no key exists anywhere', async () => {
	const ctx = liveContext();
	const row = await ctx.revenueFor({ revenuecat: {} });
	assert.deepEqual(row, { monthly: null, skipped: 'no RevenueCat API key' });
});

test.after(async () => {
	await rm(fakeHome, { recursive: true, force: true });
});
