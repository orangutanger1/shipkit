// Portfolio rules. The sunset gate deletes apps, so every boundary here is a
// number someone will argue with at 2am; the registry and the pool exist so the
// table survives the app whose config someone broke six months ago.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	addEntry,
	collectRow,
	normaliseRegistry,
	pool,
	readRegistry,
	removeEntry,
	scanConfigs,
	sunsetVerdict,
	writeRegistry,
} from '../src/commands/portfolio.mjs';

const DAY = 86_400_000;
const fixture = () => mkdtemp(join(tmpdir(), 'ship-portfolio-'));

const app = async (root, name, config) => {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'ship.config.json'),
		typeof config === 'string' ? config : JSON.stringify(config ?? { name, bundleId: `com.test.${name}` }),
	);
	return dir;
};

/* --------------------------------------------------------------- sunset -- */

const dead = { revenue: 0, ageDays: 200, daysSinceRelease: 120 };
const verdict = (over) => sunsetVerdict({ ...dead, ...over }).verdict;

test('all three gates together are the only path to a sunset', () => {
	assert.equal(verdict({}), 'sunset');
});

test('age boundary: 91 days sunsets, 89 does not', () => {
	assert.equal(verdict({ ageDays: 91 }), 'sunset');
	assert.equal(verdict({ ageDays: 89 }), 'keep');
	// A brand new app with no revenue is a launch, not a corpse.
	assert.equal(verdict({ ageDays: 90 }), 'keep');
});

test('release boundary: 61 days since release sunsets, 59 does not', () => {
	assert.equal(verdict({ daysSinceRelease: 61 }), 'sunset');
	assert.equal(verdict({ daysSinceRelease: 59 }), 'keep');
	assert.equal(verdict({ daysSinceRelease: 60 }), 'keep');
});

test('revenue floor is exclusive: below sunsets, at and above do not', () => {
	assert.equal(verdict({ revenue: 9.99 }), 'sunset');
	assert.equal(verdict({ revenue: 10 }), 'keep');
	assert.equal(verdict({ revenue: 10.01 }), 'keep');
});

test('the floor is configurable and the gate reports the number it used', () => {
	const v = sunsetVerdict({ ...dead, revenue: 25 }, { floor: 50 });
	assert.equal(v.verdict, 'sunset');
	assert.equal(v.floor, 50);
	const gate = v.gates.find((g) => g.name === 'revenue');
	assert.match(gate.detail, /\$25\.00\/mo < \$50\.00 floor/);
});

test('an unknown input never sunsets by omission', () => {
	assert.equal(verdict({ revenue: null }), 'unknown');
	assert.equal(verdict({ ageDays: null }), 'unknown');
	// A gate that is known to fail outranks a missing one: this app is alive.
	assert.equal(sunsetVerdict({ revenue: null, ageDays: 10, daysSinceRelease: 5 }).verdict, 'keep');
	assert.equal(sunsetVerdict({ revenue: null, ageDays: null, daysSinceRelease: null }).sunset, false);
});

test('every gate carries the number that decided it', () => {
	const v = sunsetVerdict({ revenue: 3, ageDays: 400, daysSinceRelease: 200 });
	assert.deepEqual(
		v.gates.map((g) => [g.name, g.value, g.pass]),
		[
			['revenue', 3, true],
			['age', 400, true],
			['release', 200, true],
		],
	);
});

/* ------------------------------------------------------------- registry -- */

test('registry tolerates bare strings, missing names and duplicate paths', () => {
	const reg = normaliseRegistry({ apps: ['/tmp/a', { path: '/tmp/a', name: 'A' }, { path: '/tmp/b', name: 'B' }, {}, null] });
	assert.deepEqual(reg.apps.map((a) => a.path), ['/tmp/a', '/tmp/b']);
	assert.equal(reg.apps[0].name, 'a');
});

test('add is idempotent by resolved path and refreshes the name', () => {
	const first = addEntry({ apps: [] }, { path: '/tmp/one', name: 'One' });
	assert.equal(first.existed, false);
	const again = addEntry(first.registry, { path: '/tmp/one/', name: 'Renamed' });
	assert.equal(again.existed, true);
	assert.equal(again.registry.apps.length, 1);
	assert.equal(again.registry.apps[0].name, 'Renamed');
});

test('rm removes by path and by name', () => {
	const reg = { apps: [{ path: resolve('/tmp/one'), name: 'One' }, { path: resolve('/tmp/two'), name: 'Two' }] };
	const byPath = removeEntry(reg, '/tmp/one');
	assert.deepEqual(byPath.removed.map((a) => a.name), ['One']);
	assert.deepEqual(byPath.registry.apps.map((a) => a.name), ['Two']);
	const byName = removeEntry(reg, 'Two');
	assert.deepEqual(byName.removed.map((a) => a.name), ['Two']);
	assert.deepEqual(removeEntry(reg, 'nope').removed, []);
});

test('a missing registry file reads as empty and round-trips through disk', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, 'nested', 'registry.json');

	assert.deepEqual((await readRegistry(file)).apps, []);
	await writeRegistry(addEntry({ apps: [] }, { path: join(root, 'app'), name: 'App' }).registry, file);
	const back = await readRegistry(file);
	assert.deepEqual(back.apps, [{ path: join(root, 'app'), name: 'App' }]);
});

/* ----------------------------------------------------------------- scan -- */

test('scan finds configs, skips vendored trees and stops at an app repo', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));

	const alpha = await app(root, 'alpha');
	const beta = await app(join(root, 'work'), 'beta');
	await app(join(root, 'alpha', 'node_modules', 'pkg'), 'ghost');
	await app(join(root, 'alpha'), 'ios');
	await app(join(root, '.hidden'), 'gamma');

	assert.deepEqual(await scanConfigs(root), [alpha, beta].sort());
});

test('scan respects its depth bound', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const deep = await app(join(root, 'a', 'b', 'c'), 'deep');

	assert.deepEqual(await scanConfigs(root, { depth: 2 }), []);
	assert.deepEqual(await scanConfigs(root, { depth: 4 }), [deep]);
});

/* ----------------------------------------------------------------- pool -- */

test('the pool never exceeds its limit and preserves input order', async () => {
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 20 }, (_, i) => i);
	const out = await pool(items, 4, async (i) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 1));
		active--;
		return i * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual(out, items.map((i) => i * 2));
});

test('the pool never starts more runners than it has items', async () => {
	let peak = 0;
	let active = 0;
	await pool([1, 2], 8, async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 1));
		active--;
	});
	assert.equal(peak, 2);
});

/* ------------------------------------------------------------------ row -- */

/** Offline context: no probe here touches the network. */
const ctx = (over = {}) => ({
	floor: 10,
	now: Date.UTC(2026, 0, 1),
	ascFor: async () => ({ state: 'READY_FOR_SALE', version: '1.2.0', build: '44', lastReleaseAt: Date.UTC(2026, 0, 1) - 5 * DAY, firstReleaseAt: Date.UTC(2026, 0, 1) - 400 * DAY }),
	revenueFor: async () => ({ monthly: 120 }),
	adsFor: async () => ({ spend: 30 }),
	...over,
});

test('a healthy app becomes a keep row with days derived from ASC dates', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = await app(root, 'alpha', { name: 'Alpha', bundleId: 'com.test.alpha' });

	const row = await collectRow({ path: dir, name: 'alpha' }, ctx());
	assert.equal(row.error, null);
	assert.equal(row.name, 'Alpha');
	assert.equal(row.verdict, 'keep');
	assert.equal(row.daysSinceRelease, 5);
	assert.equal(row.ageDays, 400);
	assert.equal(row.revenue, 120);
	assert.equal(row.spend, 30);
});

test('an invalid ship.config.json is an error row, not a throw', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = await app(root, 'broken', '{ this is not json');

	const row = await collectRow({ path: dir, name: 'broken' }, ctx());
	assert.equal(row.verdict, 'error');
	assert.equal(row.sunset, false);
	assert.match(row.error, /not valid JSON/);
	assert.equal(row.revenue, null);
});

test('a missing ship.config.json is an error row naming the path', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, 'gone');
	await mkdir(dir);

	const row = await collectRow({ path: dir, name: 'gone' }, ctx());
	assert.equal(row.verdict, 'error');
	assert.match(row.error, /no ship\.config\.json/);
});

test('a config missing required fields errors instead of half-rendering', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = await app(root, 'nameless', { bundleId: 'com.test.nameless' });

	const row = await collectRow({ path: dir, name: 'nameless' }, ctx());
	assert.equal(row.verdict, 'error');
	assert.match(row.error, /"name" is required/);
});

test('a failing probe becomes an error cell and the rest of the row survives', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = await app(root, 'alpha', { name: 'Alpha', bundleId: 'com.test.alpha' });

	const row = await collectRow(
		{ path: dir, name: 'alpha' },
		ctx({
			revenueFor: async () => {
				throw new Error('fetch failed');
			},
			ascFor: async () => ({
				state: 'READY_FOR_SALE',
				version: '1.2.0',
				build: '44',
				lastReleaseAt: Date.UTC(2026, 0, 1) - 300 * DAY,
				firstReleaseAt: Date.UTC(2026, 0, 1) - 400 * DAY,
			}),
		}),
	);
	assert.equal(row.error, null, 'a dead probe must not kill the row');
	assert.equal(row.errors.revenue, 'fetch failed');
	assert.equal(row.revenue, null);
	assert.equal(row.version, '1.2.0');
	// Money is unknown, the other two gates pass: never a sunset on a guess.
	assert.equal(row.verdict, 'unknown');
});

test('an absent credential is a skip, not an error, and still yields a verdict', async (t) => {
	const root = await fixture();
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = await app(root, 'stale', { name: 'Stale', bundleId: 'com.test.stale' });

	const row = await collectRow(
		{ path: dir, name: 'stale' },
		ctx({
			revenueFor: async () => ({ monthly: 2 }),
			adsFor: async () => ({ spend: null, skipped: 'no Apple Ads credentials' }),
			ascFor: async () => ({
				state: 'READY_FOR_SALE',
				version: '1.0.0',
				build: '3',
				lastReleaseAt: Date.UTC(2026, 0, 1) - 300 * DAY,
				firstReleaseAt: Date.UTC(2026, 0, 1) - 800 * DAY,
			}),
		}),
	);
	assert.deepEqual(row.errors, {});
	assert.equal(row.skipped.ads, 'no Apple Ads credentials');
	assert.equal(row.verdict, 'sunset');
	assert.equal(row.sunset, true);
	assert.deepEqual(row.gates.map((g) => g.pass), [true, true, true]);
});
