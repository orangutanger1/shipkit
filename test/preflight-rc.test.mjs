// The RevenueCat row of preflight, in the two shapes that need a key: a project
// with nothing to report, and one whose audit has findings. apiKey() caches for
// the life of the process, so a run *with* a key cannot share a process with
// the no-key case in preflight-live-edges.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeHome, inDir, json, repo, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';

const { Report } = await import('../src/log.mjs');
const { checkRevenueCat } = await import('../src/lib/preflight-live.mjs');
const { loadConfig } = await import('../src/config.mjs');

const cfgOf = (config) =>
	repo({ config: { name: 'Demo', bundleId: 'com.demo.app', asc: { appId: '111' }, ...config }, prefix: 'ship-pfrc-' }).then((dir) => inDir(dir, () => loadConfig()));

async function rowsOf(cfg, fetch) {
	const report = new Report('t');
	await withFetch(fetch, () => checkRevenueCat(report, cfg));
	return report.rows;
}

/** @param {{projects?: object[], entitlements?: object[], offerings?: object[]}} [opts] */
const account = ({ projects = [{ id: 'projX', name: 'Demo' }], entitlements = [{ id: 'e', lookup_key: 'pro' }], offerings = [{ id: 'o', lookup_key: 'default', is_current: true }] } = {}) =>
	async (url) => {
		const path = new URL(String(url)).pathname;
		if (path.endsWith('/entitlements')) return json({ items: entitlements });
		if (path.endsWith('/offerings')) return json({ items: offerings });
		if (path.endsWith('/v2/projects')) return json({ items: projects });
		return json({ items: [] });
	};

test('a repo naming no project skips, rather than auditing whatever the key can see', async () => {
	const cfg = await cfgOf({ revenuecat: {} });
	const rows = await rowsOf(cfg, account({ projects: [{ id: 'a' }, { id: 'b' }] }));
	assert.equal(rows[0].level, 'skip');
	assert.match(rows[0].detail, /no revenuecat.projectId/);
});

test('a project the key cannot see is unresolved, not broken', async () => {
	const cfg = await cfgOf({ revenuecat: { projectId: 'nope' } });
	const rows = await rowsOf(cfg, account());
	assert.equal(rows[0].level, 'skip');
	assert.match(rows[0].detail, /project unresolved|no revenuecat/);
});

test('a healthy project reports the findings the audit produced', async () => {
	const cfg = await cfgOf({ revenuecat: { projectId: 'projX', entitlement: 'pro' } });
	const rows = await rowsOf(cfg, account());
	assert.ok(rows.length);
	assert.ok(rows.every((r) => r.name.startsWith('rc')));
});
