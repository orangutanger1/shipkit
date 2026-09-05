// The audit rows and helpers no other test file reaches directly: apiKey's
// own no-env, no-file and ambient-file paths, resolveProject matching by name
// (and losing the race when the account changes between the key check and the
// listing), and the auditProject arms `ship rc audit` fixtures never fed —
// an "ios"-typed app, a bundle mismatch, an id-matched entitlement, and
// products nobody attached to an app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHome, json, withFetch } from './fixtures/cmd.mjs';

let n = 0;
/** A fresh revenuecat.mjs per test, so apiKey's module-lifetime cache starts empty. */
const freshRc = () => import(`../src/lib/revenuecat.mjs?a=${n++}`);

test('with no env var and no key file, an optional lookup is null rather than a thrown error', async () => {
	await fakeHome();
	const { apiKey } = await freshRc();
	assert.equal(await apiKey({ optional: true }), null);
});

test('with no env var and no key file, a required lookup throws naming the file', async () => {
	await fakeHome();
	const { apiKey, KEY_FILE } = await freshRc();
	try {
		await apiKey();
		assert.fail('expected apiKey() to reject');
	} catch (err) {
		assert.match(err.message, /no RevenueCat v2 API key/);
		assert.match(err.hint, new RegExp(KEY_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}
});

test('the ambient key file at ~/.omp/revenuecat.key is read when no env var is set', async () => {
	const home = await fakeHome();
	await mkdir(join(home, '.omp'), { recursive: true });
	await writeFile(join(home, '.omp', 'revenuecat.key'), '  file-key  \n');
	const { apiKey } = await freshRc();
	assert.equal(await apiKey(), 'file-key');
});

/** Route `/v2/projects` by the bearer token. */
function fetchByToken(seesMap) {
	return async (url, init) => {
		const path = new URL(String(url)).pathname;
		if (!path.endsWith('/v2/projects')) return json({ items: [] });
		const token = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
		return json({ items: seesMap[token] ?? [] });
	};
}

test('a project configured by name, not id, still resolves', async () => {
	await fakeHome();
	const { resolveProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'amb-key': [{ id: 'projX', name: 'Demo' }] });
	process.env.REVENUECAT_V2_KEY = 'amb-key';
	const project = await resolveProject({ revenuecat: { projectId: 'Demo' } });
	assert.equal(project.id, 'projX');
	delete process.env.REVENUECAT_V2_KEY;
});

test('a project that answers the key check but is gone from the listing resolves to null, not a stale row', async () => {
	// The two calls hit the same endpoint at different moments; an account
	// losing the project between them must not hand back a project object with
	// a project that no longer exists.
	await fakeHome();
	const { resolveProject } = await freshRc();
	let calls = 0;
	globalThis.fetch = async (url) => {
		const path = new URL(String(url)).pathname;
		if (!path.endsWith('/v2/projects')) return json({ items: [] });
		calls += 1;
		return json({ items: calls === 1 ? [{ id: 'projX' }] : [{ id: 'projOther' }] });
	};
	process.env.REVENUECAT_V2_KEY = 'amb-key';
	const project = await resolveProject({ revenuecat: { projectId: 'projX' } });
	assert.equal(project, null);
	delete process.env.REVENUECAT_V2_KEY;
});

test('a page that carries no items ends the walk instead of throwing', async () => {
	// RevenueCat answers an empty collection without an `items` key at all, and
	// a paginated walk that assumed the array would crash on the last page.
	await fakeHome();
	const { listProjects } = await freshRc();
	globalThis.fetch = async () => json({ next_page: null });
	process.env.REVENUECAT_V2_KEY = 'amb-key';
	assert.deepEqual(await listProjects(), []);
	delete process.env.REVENUECAT_V2_KEY;
});

// ─── auditProject ────────────────────────────────────────────────────────────
//
// `process.env.REVENUECAT_V2_KEY` cannot be set at module top level here: a
// plain assignment runs at import time, before any test body, and would leak
// into the apiKey/resolveProject tests above regardless of where in the file
// it is written. Each test below sets it, imports a fresh module, and cleans
// up after itself.

const PROJECT = { id: 'projX', name: 'Demo' };
/** A fresh module with an ambient key already set, for the duration of the caller's test. */
async function freshRcKeyed() {
	process.env.REVENUECAT_V2_KEY = 'test-key';
	return freshRc();
}

/** @param {{apps?: object[], entitlements?: object[], offerings?: object[], products?: object[], packages?: object[]}} [opts] */
function route({ apps = [], entitlements = [], offerings = [], products = [], packages = [] } = {}) {
	return async (url) => {
		const path = new URL(String(url)).pathname;
		if (/\/offerings\/[^/]+\/packages$/.test(path)) return json({ items: packages });
		if (path.endsWith('/apps')) return json({ items: apps });
		if (path.endsWith('/entitlements')) return json({ items: entitlements });
		if (path.endsWith('/offerings')) return json({ items: offerings });
		if (path.endsWith('/products')) return json({ items: products });
		return json({ items: [] });
	};
}
const rowOf = (rows, name) => rows.find((r) => r.name === name);

test('an app typed "ios", not "app_store", is still recognised as the store app', async () => {
	const fetch = route({
		apps: [{ id: 'a1', type: 'ios', app_store: { bundle_id: 'com.demo.app' } }],
		entitlements: [{ id: 'e1', lookup_key: 'pro' }],
		offerings: [{ id: 'o1', lookup_key: 'default', is_current: true }],
		packages: [{ id: 'pk1' }],
		products: [{ id: 'p1', app_id: 'a1' }],
	});
	const { auditProject } = await freshRcKeyed();
	const rows = await withFetch(fetch, () => auditProject({ bundleId: 'com.demo.app', revenuecat: { entitlement: 'pro' } }, PROJECT));
	assert.equal(rowOf(rows, 'app_store app').level, 'ok');
});

test('a bundle id RevenueCat disagrees with is a hard failure naming both sides', async () => {
	const fetch = route({
		apps: [{ id: 'a1', type: 'app_store', app_store: { bundle_id: 'com.other.app' } }],
		offerings: [{ id: 'o1', lookup_key: 'default', is_current: true }],
		packages: [{ id: 'pk1' }],
		products: [{ id: 'p1', app_id: 'a1' }],
	});
	const { auditProject } = await freshRcKeyed();
	const rows = await withFetch(fetch, () => auditProject({ bundleId: 'com.demo.app', revenuecat: {} }, PROJECT));
	const row = rowOf(rows, 'bundle id');
	assert.equal(row.level, 'fail');
	assert.match(row.detail, /com.other.app/);
	assert.match(row.detail, /com.demo.app/);
});

test('an unset entitlement is a warning, not a failure — nothing to check yet', async () => {
	const fetch = route({
		apps: [{ id: 'a1', type: 'app_store', app_store: { bundle_id: 'com.demo.app' } }],
		offerings: [{ id: 'o1', lookup_key: 'default', is_current: true }],
		packages: [{ id: 'pk1' }],
		products: [{ id: 'p1', app_id: 'a1' }],
	});
	const { auditProject } = await freshRcKeyed();
	const rows = await withFetch(fetch, () => auditProject({ bundleId: 'com.demo.app', revenuecat: {} }, PROJECT));
	assert.equal(rowOf(rows, 'entitlement').level, 'warn');
});

test('an entitlement configured by RevenueCat id, not lookup key, still resolves', async () => {
	const fetch = route({
		apps: [{ id: 'a1', type: 'app_store', app_store: { bundle_id: 'com.demo.app' } }],
		entitlements: [{ id: 'ent_pro', lookup_key: 'unrelated_key' }],
		offerings: [{ id: 'o1', lookup_key: 'default', is_current: true }],
		packages: [{ id: 'pk1' }],
		products: [{ id: 'p1', app_id: 'a1' }],
	});
	const { auditProject } = await freshRcKeyed();
	const rows = await withFetch(fetch, () => auditProject({ bundleId: 'com.demo.app', revenuecat: { entitlement: 'ent_pro' } }, PROJECT));
	assert.equal(rowOf(rows, 'entitlement').level, 'ok');
});

test('products nobody attached to an app are a warning that counts them', async () => {
	const fetch = route({
		apps: [{ id: 'a1', type: 'app_store', app_store: { bundle_id: 'com.demo.app' } }],
		offerings: [{ id: 'o1', lookup_key: 'default', is_current: true }],
		packages: [{ id: 'pk1' }],
		products: [{ id: 'p1', app_id: 'a1' }, { id: 'p2' }],
	});
	const { auditProject } = await freshRcKeyed();
	const rows = await withFetch(fetch, () => auditProject({ bundleId: 'com.demo.app', revenuecat: {} }, PROJECT));
	const row = rowOf(rows, 'products');
	assert.equal(row.level, 'warn');
	assert.match(row.detail, /1 not attached to an app/);
});

test('overviewMetrics tolerates a payload with no metrics array at all', async () => {
	const { overviewMetrics } = await freshRcKeyed();
	const fetch = async () => json({});
	const out = await withFetch(fetch, () => overviewMetrics('projX'));
	assert.deepEqual(out.metrics, []);
	assert.equal(out.period, null);
	assert.equal(out.revenue, null);
	assert.equal(out.mrr, null);
});
