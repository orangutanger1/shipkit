// Key resolution across the multi-account machine this actually runs on:
// `~/.omp/revenuecat/{barn,car,tour}.key` behind one ambient
// `~/.omp/revenuecat.key`. `useKeyForProject` tries the documented per-repo
// path, then the ambient key, then every key in the directory — each
// candidate validated against the configured project before use — so a wrong
// key fails naming the file, not with a bare 401 fifty lines later.
//
// `apiKey()` caches for the life of the module, and `useKeyForProject`
// deliberately mutates that same cache, so every scenario here imports a
// fresh module instance (a cache-busting query string) over a fresh fake
// $HOME — otherwise one test's resolved key would leak into the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHome, json } from './fixtures/cmd.mjs';

let n = 0;
/** A fresh revenuecat.mjs, so its module-lifetime key cache starts empty. */
const freshRc = () => import(`../src/lib/revenuecat.mjs?c=${n++}`);

/** Route `/v2/projects` by the bearer token, so each candidate key answers differently. */
function fetchByToken(seesMap) {
	return async (url, init) => {
		const path = new URL(String(url)).pathname;
		if (!path.endsWith('/v2/projects')) return json({ items: [] });
		const token = String(init?.headers?.Authorization ?? '').replace('Bearer ', '');
		const seen = seesMap[token];
		if (seen === undefined) return json({}); // no items array at all
		return json({ items: seen ? [{ id: 'projX', name: 'Demo' }] : [{ id: 'projOther' }] });
	};
}

test('a slash-qualified revenuecat.key is read as an exact path, not joined under the key directory', async () => {
	const home = await fakeHome();
	const nested = join(home, 'elsewhere', 'my.key');
	await mkdir(join(home, 'elsewhere'), { recursive: true });
	await writeFile(nested, 'key-nested');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-nested': true });
	const cfg = { revenuecat: { projectId: 'projX', key: nested } };
	const res = await useKeyForProject(cfg);
	assert.equal(res.source, nested);
	assert.equal(res.switched, true);
});

test('a bare revenuecat.key name resolves under ~/.omp/revenuecat/<name>.key', async () => {
	const home = await fakeHome();
	const dir = join(home, '.omp', 'revenuecat');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'myapp.key'), 'key-myapp');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-myapp': true });
	const cfg = { revenuecat: { projectId: 'projX', key: 'myapp' } };
	const res = await useKeyForProject(cfg);
	assert.equal(res.source, join(dir, 'myapp.key'));
	assert.equal(res.switched, true);
});

test('a named revenuecat.key with nothing readable at its path names the expected file', async () => {
	await fakeHome();
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({});
	const cfg = { revenuecat: { projectId: 'projX', key: 'ghost' } };
	await assert.rejects(() => useKeyForProject(cfg), /revenuecat\.key "ghost" points at no readable key/);
});

test('a named revenuecat.key that cannot see the configured project is a hard failure, not a fallback', async () => {
	const home = await fakeHome();
	const dir = join(home, '.omp', 'revenuecat');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'wrong.key'), 'key-wrong');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-wrong': false });
	const cfg = { revenuecat: { projectId: 'projX', key: 'wrong' } };
	await assert.rejects(() => useKeyForProject(cfg), /the key at .*wrong\.key cannot see project "projX"/);
});

test('the per-repo guess file is used when it can see the project, with no cfg.root falling back to "project"', async () => {
	const home = await fakeHome();
	const dir = join(home, '.omp', 'revenuecat');
	await mkdir(dir, { recursive: true });
	// cfg.root is absent, so expectedKeyFile's basename(cfg?.root ?? '') is '' and falls back to "project".
	await writeFile(join(dir, 'project.key'), 'key-guess');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-guess': true });
	const cfg = { revenuecat: { projectId: 'projX' } };
	const res = await useKeyForProject(cfg);
	assert.equal(res.source, join(dir, 'project.key'));
	assert.equal(res.switched, true);
});

test('every key in the directory is tried when neither the guess nor the ambient key can see the project', async () => {
	const home = await fakeHome();
	const dir = join(home, '.omp', 'revenuecat');
	await mkdir(dir, { recursive: true });
	// "repo" is the guess (cfg.root's basename); it cannot see the project, so
	// the directory listing is the only way left to find a key that can.
	await writeFile(join(dir, 'repo.key'), 'key-repo');
	await writeFile(join(dir, 'a.key'), 'key-a');
	await writeFile(join(dir, 'b.key'), 'key-b');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-repo': false, 'key-a': false, 'key-b': true });
	const cfg = { root: '/somewhere/repo', revenuecat: { projectId: 'projX' } };
	const res = await useKeyForProject(cfg);
	assert.equal(res.source, join(dir, 'b.key'));
	assert.equal(res.switched, true);
});

test('no key anywhere in the directory names every file that was tried', async () => {
	const home = await fakeHome();
	const dir = join(home, '.omp', 'revenuecat');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'repo.key'), 'key-repo');
	// This key answers with no items array at all — a malformed payload rather
	// than an empty account — which keySees must read as "cannot see it" too.
	await writeFile(join(dir, 'odd.key'), 'key-odd');
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({ 'key-repo': false });
	const cfg = { root: '/somewhere/repo', revenuecat: { projectId: 'projX' } };
	try {
		await useKeyForProject(cfg);
		assert.fail('expected useKeyForProject to reject');
	} catch (err) {
		assert.match(err.message, /no RevenueCat key can see project "projX"/);
		assert.match(err.hint, /tried the ambient key and odd\.key, repo\.key/);
	}
});

test('no candidate anywhere, and no key directory either, still names where a key should go', async () => {
	// fakeHome() gives a $HOME with no ~/.omp/revenuecat directory at all, so
	// the final readdir throws and the hint has no file list to offer.
	await fakeHome();
	const { useKeyForProject } = await freshRc();
	globalThis.fetch = fetchByToken({});
	const cfg = { revenuecat: { projectId: 'projX' } };
	try {
		await useKeyForProject(cfg);
		assert.fail('expected useKeyForProject to reject');
	} catch (err) {
		assert.match(err.message, /no RevenueCat key can see project "projX"/);
		assert.match(err.hint, /set REVENUECAT_V2_KEY, or drop the project's key there/);
	}
});
