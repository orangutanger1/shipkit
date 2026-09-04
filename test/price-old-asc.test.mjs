// The one `ship price` case that cannot share a process with the others: the
// installed-asc capability probe caches `asc <cmd> --help` for the life of the
// process, so a run against an asc too old to price territories needs a process
// where that cache was never filled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/price.mjs');

test('an asc too old to price territories is named, with what it does offer', async () => {
	setBin('asc', [['^pricing --help', { out: '  usage: asc pricing\n' }]]);
	const dir = await repo({ config: { asc: { appId: '111' }, price: { basePriceUsd: 4.99 } }, prefix: 'ship-price-' });
	await assert.rejects(
		() => capture(() => inDir(dir, () => run({ args: ['show'], flags: {} }))),
		/the installed asc has no `pricing current` command/,
	);
});
