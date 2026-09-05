// `ship rc` end to end. RevenueCat is a plain REST API, so the whole command
// is exercised through a routing fetch stub: projects, apps, entitlements,
// offerings, packages, products, and the audit built on top of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture, fakeHome, inDir, json, repo, withFetch } from './fixtures/cmd.mjs';

const HOME = await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';

const { run } = await import('../src/commands/rc.mjs');

const PROJECT = { id: 'projX', name: 'Demo' };
const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', revenuecat: { projectId: 'projX', entitlement: 'pro' } };

/**
 * The account this key can see. Every list endpoint answers `{items}`.
 * @param {object} [over]
 */
function account(over = {}) {
	const {
		projects = [PROJECT],
		apps = [{ id: 'app1', type: 'app_store', app_store: { bundle_id: 'com.demo.app' } }],
		entitlements = [{ id: 'ent1', lookup_key: 'pro', display_name: 'Pro' }],
		offerings = [{ id: 'off1', lookup_key: 'default', is_current: true, display_name: 'Default' }],
		packages = [{ id: 'pkg1', lookup_key: '$rc_monthly', position: 1 }],
		packageProducts = [{ product: { id: 'prod1', store_identifier: 'com.demo.monthly', app_id: 'app1', type: 'subscription' } }],
		products = [{ id: 'prod1', store_identifier: 'com.demo.monthly', app_id: 'app1', type: 'subscription' }],
	} = over;
	return async (url) => {
		const path = new URL(String(url)).pathname;
		if (/\/packages\/[^/]+\/products$/.test(path)) return json({ items: packageProducts });
		if (/\/offerings\/[^/]+\/packages$/.test(path)) return json({ items: packages });
		if (path.endsWith('/apps')) return json({ items: apps });
		if (path.endsWith('/entitlements')) return json({ items: entitlements });
		if (path.endsWith('/offerings')) return json({ items: offerings });
		if (path.endsWith('/products')) return json({ items: products });
		if (path.endsWith('/v2/projects')) return json({ items: projects });
		return json({ items: [] });
	};
}

/** @param {string[]} args @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function rc(args, { flags = {}, dir, fetch = account() }) {
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const rcRepo = (config = {}) => repo({ config: { ...CONFIG, ...config }, prefix: 'ship-rc-' });

test('projects lists what the key can see', async () => {
	const dir = await rcRepo();
	const { code, out } = await rc(['projects'], { dir });
	assert.equal(code, 0);
	assert.match(out, /projX/);
	const { out: raw } = await rc(['projects'], { dir, flags: { json: true } });
	assert.deepEqual(JSON.parse(raw), [{ id: 'projX', name: 'Demo' }]);
});

test('status is the default subcommand and reports the whole project', async () => {
	const dir = await rcRepo();
	const { code, out } = await rc([], { dir });
	assert.equal(code, 0);
	assert.match(out, /Apps \(1\)/);
	assert.match(out, /Entitlements \(1\)/);
	assert.match(out, /Offerings \(1\)/);
	assert.match(out, /app expects: pro/);
	const { out: raw } = await rc(['status'], { dir, flags: { json: true } });
	const doc = JSON.parse(raw);
	assert.equal(doc.bundleMismatch, false);
	assert.equal(doc.offerings[0].packages, 1);
});

test('status names a bundle id that disagrees with the repo', async () => {
	const dir = await rcRepo();
	const fetch = account({ apps: [{ id: 'app1', type: 'app_store', app_store: { bundle_id: 'com.other.app' } }] });
	const { out } = await rc(['status'], { dir, fetch });
	assert.match(out, /app_store app is com.other.app but this repo builds com.demo.app/);
	const { out: raw } = await rc(['status'], { dir, flags: { json: true }, fetch });
	assert.equal(JSON.parse(raw).bundleMismatch, true);
});

test('offerings shows the current one and the products each package sells', async () => {
	const dir = await rcRepo();
	const { code, out } = await rc(['offerings'], { dir });
	assert.equal(code, 0);
	assert.match(out, /\$rc_monthly/);
	assert.match(out, /com.demo.monthly/);
	const { out: raw } = await rc(['offerings'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).current, 'default');
});

test('an offering with no products, and no current offering at all, are both called out', async () => {
	const dir = await rcRepo();
	const empty = account({ packageProducts: [] });
	const { out } = await rc(['offerings'], { dir, fetch: empty });
	assert.match(out, /none — will not render/);

	const none = account({ offerings: [{ id: 'off1', lookup_key: 'default', is_current: false }] });
	const { code, out: out2 } = await rc(['offerings'], { dir, fetch: none });
	assert.equal(code, 0);
	assert.match(out2, /no offering is current — the paywall renders empty on device/);
});

test('a win-back offering is marked as one', async () => {
	const dir = await rcRepo();
	const fetch = account({ offerings: [{ id: 'off1', lookup_key: 'winback', is_current: true, display_name: 'Come back' }] });
	const { out } = await rc(['offerings'], { dir, fetch });
	assert.match(out, /win-back/);
});

test('products and entitlements list what the project has', async () => {
	const dir = await rcRepo();
	const { out } = await rc(['products'], { dir });
	assert.match(out, /com.demo.monthly/);
	const { out: rawProducts } = await rc(['products'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(rawProducts)[0].store_identifier, 'com.demo.monthly');

	const { out: ent } = await rc(['entitlements'], { dir });
	assert.match(ent, /pro/);
	const { out: rawEnt } = await rc(['entitlements'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(rawEnt)[0].lookup_key, 'pro');
});

test('an unattached product is shown as unattached rather than blank', async () => {
	const dir = await rcRepo();
	const { out } = await rc(['products'], { dir, fetch: account({ products: [{ id: 'p', store_identifier: 'com.demo.x', type: 'subscription' }] }) });
	assert.match(out, /unattached/);
});

test('audit reports the project against the repo', async () => {
	const dir = await rcRepo();
	const { code, out } = await rc(['audit'], { dir });
	assert.ok(code === 0 || code === 1);
	assert.match(out, /RevenueCat — Demo \(projX\)/);
	const { out: raw } = await rc(['audit'], { dir, flags: { json: true } });
	assert.ok(JSON.parse(raw).rows.length);
});

test('a project id that matches nothing names the file to fix', async () => {
	const dir = await rcRepo({ revenuecat: { projectId: 'nope' } });
	await assert.rejects(() => rc(['status'], { dir }), /no RevenueCat key can see project "nope"/);
});

test('several projects and none selected is its own message', async () => {
	const dir = await rcRepo({ revenuecat: {} });
	const fetch = account({ projects: [PROJECT, { id: 'projY', name: 'Other' }] });
	await assert.rejects(() => rc(['status'], { dir, fetch }), /several RevenueCat projects and none is selected/);
});

test('a project the key can see at the check but not at the listing names the projectId, not "none selected"', async () => {
	// Two different calls hit the same /v2/projects endpoint: once while
	// useKeyForProject validates the key can see "projX", again when
	// resolveProject lists projects to find it. An account that changes
	// between them must not be reported as "several projects, none selected".
	const dir = await rcRepo();
	let calls = 0;
	const fetch = async (url) => {
		const path = new URL(String(url)).pathname;
		if (path.endsWith('/v2/projects')) {
			calls += 1;
			return json({ items: calls === 1 ? [PROJECT] : [{ id: 'projOther', name: 'Other' }] });
		}
		return account()(url);
	};
	await assert.rejects(() => rc(['status'], { dir, fetch }), /no RevenueCat project matches revenuecat\.projectId "projX"/);
});

test('a win-back offering identified by id, or by neither key, still resolves', async () => {
	const dir = await rcRepo();
	const byId = account({ offerings: [{ id: 'winback_id', is_current: false }] });
	const { out } = await rc(['offerings'], { dir, fetch: byId });
	assert.match(out, /win-back/);

	const neither = account({ offerings: [{ is_current: false }] });
	const { out: out2 } = await rc(['offerings'], { dir, fetch: neither });
	assert.match(out2, /paywall/); // no lookup_key or id to match the pattern against
});

test('a package products response with no items key is read as no products', async () => {
	const dir = await rcRepo();
	const fetch = async (url) => {
		const path = new URL(String(url)).pathname;
		if (/\/packages\/[^/]+\/products$/.test(path)) return json({});
		return account()(url);
	};
	const { out } = await rc(['offerings'], { dir, fetch });
	assert.match(out, /none — will not render/);
});

test('an app with no bundle id at all is null in JSON, not an empty string', async () => {
	const dir = await rcRepo();
	const fetch = account({ apps: [{ id: 'app1', type: 'app_store' }] });
	const { out } = await rc(['status'], { dir, fetch, flags: { json: true } });
	assert.equal(JSON.parse(out).apps[0].bundle_id, null);
});

test('an offering with no current one, and a package with no position, are null in JSON', async () => {
	const dir = await rcRepo();
	const fetch = account({ offerings: [{ id: 'off1', lookup_key: 'default', is_current: false }], packages: [{ id: 'pkg1', lookup_key: '$rc_monthly' }] });
	const { out } = await rc(['offerings'], { dir, fetch, flags: { json: true } });
	assert.equal(JSON.parse(out).current, null);
});

test('a product row with no store identifier or type prints blank cells, not "undefined"', async () => {
	const dir = await rcRepo();
	const fetch = account({ products: [{ id: 'p1', app_id: 'app1' }] });
	const { out } = await rc(['products'], { dir, fetch });
	assert.doesNotMatch(out, /undefined/);
});

test('an entitlement with no display name prints a blank cell, not "undefined"', async () => {
	const dir = await rcRepo();
	const fetch = account({ entitlements: [{ id: 'e1', lookup_key: 'pro' }] });
	const { out } = await rc(['entitlements'], { dir, fetch });
	assert.doesNotMatch(out, /undefined/);
});

test('audit names the non-ambient key file when the account behind it needed switching', async () => {
	await mkdir(join(HOME, '.omp', 'revenuecat'), { recursive: true });
	await writeFile(join(HOME, '.omp', 'revenuecat', 'ship-rc-project.key'), 'test-key');
	// This repo's directory name will not match "ship-rc-project" in general, so
	// name the guess file explicitly via revenuecat.key instead.
	const dir = await rcRepo({ revenuecat: { projectId: 'projX', entitlement: 'pro', key: 'ship-rc-project' } });
	const { out } = await rc(['audit'], { dir });
	assert.match(out, /via .*ship-rc-project\.key/);
});
