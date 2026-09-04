// The one `ship shots` case that needs its own process: `asc screenshots sizes`
// is memoised for the life of the run (an upload across N locales otherwise
// asks Apple the same question N times and earns 429s), so a run against an
// asc that answers with nothing needs a process where nothing was cached.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/shots.mjs');

test('an asc that lists no screenshot sizes is reported, not treated as none accepted', async () => {
	setBin('asc', []);
	const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app' }, prefix: 'ship-shots-' });
	await assert.rejects(
		() => capture(() => inDir(dir, () => run({ args: ['sizes'], flags: {} }))),
		/asc screenshots sizes returned nothing/,
	);
});
