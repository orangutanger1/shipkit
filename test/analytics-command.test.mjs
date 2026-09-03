// `ship analytics diagnose` end to end over a temp repo. Nothing here touches
// the network: the command reads the artifacts `pull` and `onboarding` write,
// so the test writes those artifacts and runs the command over them.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/commands/analytics.mjs';
import { flowsIn } from '../src/lib/flows.mjs';

/** Run silently, keeping whatever was written to stdout for the `--json` tests. */
const quiet = async (fn) => {
	const saved = { out: process.stdout.write, err: process.stderr.write };
	let captured = '';
	process.stdout.write = (chunk) => {
		captured += chunk;
		return true;
	};
	process.stderr.write = () => true;
	try {
		return { code: await fn(), stdout: captured };
	} finally {
		process.stdout.write = saved.out;
		process.stderr.write = saved.err;
	}
};

async function repo(files = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-analytics-'));
	await writeFile(join(dir, 'ship.config.json'), JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', version: '1.0.0' }));
	for (const [rel, body] of Object.entries(files)) {
		await mkdir(join(dir, rel, '..'), { recursive: true });
		await writeFile(join(dir, rel), JSON.stringify(body));
	}
	return dir;
}

async function inRepo(dir, args, flags = {}) {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await quiet(() => run({ args, flags }));
	} finally {
		process.chdir(cwd);
	}
}

const exit = async (...args) => (await inRepo(...args)).code;

const FUNNEL = '.asc/analytics/en-US-funnel.json';
const ONBOARDING = '.asc/analytics/en-US-onboarding.json';

const healthy = { locale: 'en-US', impressions: 10_000, pageViews: 1200, installs: 500, retention: { rate: 0.1 }, sessions: { perDevice: 6 }, crashes: { perDevice: 0.001 } };

test('a healthy repo diagnoses nothing and exits 0', async () => {
	const dir = await repo({ [FUNNEL]: healthy, [ONBOARDING]: { steps: [{ name: 'welcome', users: 100 }, { name: 'paywall', users: 90 }], installs: 500, paid: 40 } });
	assert.equal(await exit(dir, ['diagnose']), 0);
});

test('a leaking stage exits 1 so a script can act on it', async () => {
	const dir = await repo({ [FUNNEL]: { ...healthy, pageViews: 100 } });
	assert.equal(await exit(dir, ['diagnose']), 1);
});

test('--json carries the verdicts, the culprit and where to work', async () => {
	const dir = await repo({
		[FUNNEL]: { ...healthy, pageViews: 100 },
		'design/ux.json': { screens: [{ id: 'welcome', route: '/welcome', flow: flowsIn('activation')[0] }] },
	});
	const { stdout } = await inRepo(dir, ['diagnose'], { json: true });
	const out = JSON.parse(stdout);
	assert.equal(out.locale, 'en-US');
	assert.equal(out.culprit.stage, 'impression→pageview');
	// The join the flow vocabulary exists for: a verdict reaches a real screen.
	assert.deepEqual(out.screens, [{ id: 'welcome', route: '/welcome', flow: flowsIn('activation')[0] }]);
});

test('diagnose refuses when nothing has been pulled, and says what to run', async () => {
	const dir = await repo();
	await assert.rejects(() => exit(dir, ['diagnose']), (err) => {
		assert.match(err.message, /nothing to diagnose for en-US/);
		assert.match(err.hint, /ship analytics pull/);
		return true;
	});
});

test('an onboarding file alone still diagnoses the stages after install', async () => {
	// No funnel at all: the store stages are unmeasured, not failing.
	const dir = await repo({ [ONBOARDING]: { steps: [{ name: 'welcome', users: 100 }, { name: 'paywall', users: 20 }], installs: 100, paid: 1 } });
	assert.equal(await exit(dir, ['diagnose']), 1);
});
