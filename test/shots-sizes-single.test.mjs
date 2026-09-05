// `ship shots sizes` formatting edges that a single shared fetchSizes cache
// (memoized per `--all`) cannot exercise alongside the happy-path rows in
// shots-command.test.mjs: a device type Apple is still rolling out, which
// ships with no family and no dimensions yet, and the singular case for both
// the row-count note and the `--all` heading.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/shots.mjs');

test('sizes renders a lone, still-rolling-out row: no family, no dimensions, singular note', async () => {
	setBin('asc', [['screenshots sizes', { out: { sizes: [{ displayType: 'APP_VISION_PRO' }] } }]]);
	const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app' }, prefix: 'ship-shots-single-' });
	const { out } = await capture(() => inDir(dir, () => run({ args: ['sizes'], flags: { all: true } })));
	assert.match(out, /\(all families\)/, 'the --all heading text only ever rendered for a multi-row, non-json call before');
	assert.match(out, /APP_VISION_PRO/);
	assert.match(out, /1 display type — source/, 'a single row is "1 display type", not "1 display types"');
});
