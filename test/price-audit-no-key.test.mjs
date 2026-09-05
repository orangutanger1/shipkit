// The one `ship price audit` case that cannot share a process with the others:
// the RevenueCat key is resolved once and cached for the life of the process, so
// a machine with no key at all needs a process where that cache was never filled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/price.mjs');

test('audit with no RevenueCat key skips the offerings rather than failing', async () => {
	// The offerings are half the ladder, but a missing key is a machine that was
	// never set up — not a paywall finding, and not a reason to lose the asc half.
	setBin('asc', [['auth status', { out: { credentials: [] } }]]);
	const dir = await repo({ config: { asc: { appId: '111' }, price: { basePriceUsd: 4.99 } }, prefix: 'ship-price-' });
	const { out } = await capture(() => inDir(dir, () => run({ args: ['audit'], flags: { json: true } })));
	const offerings = JSON.parse(out).rows.find((r) => r.name === 'offerings');
	assert.equal(offerings.level, 'skip');
	assert.match(offerings.detail, /no RevenueCat v2 key — see `ship doctor`/);
});
