// The corners of config loading: what a user's JSON is allowed to say when it
// disagrees with the defaults' shape, and where the version comes from when
// ship.config.json does not name one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalise, readExpoConfig, resolveVersion } from '../src/config.mjs';

const MINIMAL = { name: 'Demo', bundleId: 'com.demo.app' };
const dir = () => mkdtemp(join(tmpdir(), 'ship-config-'));

/** Write a repo whose only content is the files given. */
async function repoWith(files) {
	const d = await dir();
	for (const [rel, body] of Object.entries(files))
		await writeFile(join(d, rel), typeof body === 'string' ? body : JSON.stringify(body));
	return d;
}

test('a null section in the user JSON blanks it; only a missing file keeps the defaults', () => {
	// The null check is on the merge's argument, not on each value: a top-level
	// `asc: null` really does erase the section, while a config object that is
	// itself null leaves the defaults standing (and then fails for want of a name).
	const cfg = normalise({ ...MINIMAL, asc: null }, '/repo/ship.config.json');
	assert.equal(cfg.asc, null);
	assert.throws(() => normalise(/** @type {never} */ (null), '/repo/ship.config.json'), /"name" is required/);
});

test('a user array replaces the default array outright instead of merging into it', () => {
	const cfg = normalise({ ...MINIMAL, store: { locales: ['fr-FR'] } }, '/repo/ship.config.json');
	assert.deepEqual(cfg.store.locales, ['fr-FR']);
	assert.equal(cfg.store.dir, 'store', 'the sibling default still fills in');
});

test('a scalar where the defaults hold an object wins, and is not merged', () => {
	const cfg = normalise({ ...MINIMAL, appDir: 'apps/mobile' }, '/repo/ship.config.json');
	assert.equal(cfg.appDir, 'apps/mobile');
});

test('name and bundleId are each required by name', () => {
	assert.throws(() => normalise({ bundleId: 'com.demo.app' }, '/repo/ship.config.json'), /"name" is required/);
	assert.throws(() => normalise({ name: 'Demo' }, '/repo/ship.config.json'), /"bundleId" is required/);
});

test('loadConfig survives a null opts and still finds the file', async () => {
	const d = await repoWith({ 'ship.config.json': MINIMAL });
	const cfg = await loadConfig(d, /** @type {never} */ (null));
	assert.equal(cfg.name, 'Demo');
});

test('a malformed ship.config.json names the file and quotes the parser', async () => {
	const d = await repoWith({ 'ship.config.json': '{ "name": ' });
	await assert.rejects(() => loadConfig(d), /ship\.config\.json is not valid JSON/);
});

test('readExpoConfig returns null for an app.json that is not an object', async () => {
	const d = await repoWith({ 'ship.config.json': MINIMAL, 'app.json': '[1, 2, 3]' });
	const cfg = await loadConfig(d);
	assert.equal(await readExpoConfig(cfg), null);
});

test('an app.json with no expo wrapper reads as no expo config at all', async () => {
	const d = await repoWith({ 'ship.config.json': MINIMAL, 'app.json': { version: '3.1.0' } });
	const cfg = await loadConfig(d);
	assert.equal(await readExpoConfig(cfg), null, 'the version lives under "expo", or it does not count');
});

test('the version comes from the override, then the config, then app.json', async () => {
	const d = await repoWith({ 'ship.config.json': { ...MINIMAL, version: '2.0.0' }, 'app.json': { expo: { version: '9.9.9' } } });
	const cfg = await loadConfig(d);
	assert.equal(await resolveVersion(cfg, '4.5.6'), '4.5.6');
	assert.equal(await resolveVersion(cfg, undefined), '2.0.0');

	const noVersion = await repoWith({ 'ship.config.json': MINIMAL, 'app.json': { expo: { version: '9.9.9' } } });
	assert.equal(await resolveVersion(await loadConfig(noVersion), undefined), '9.9.9');
});

test('a repo that names its version nowhere is told the three places it could', async () => {
	const d = await repoWith({ 'ship.config.json': MINIMAL });
	const cfg = await loadConfig(d);
	await assert.rejects(() => resolveVersion(cfg, undefined), /cannot determine app version/);
});

test('a ship.config.json that is not an object at all replaces the defaults wholesale', async () => {
	// The merge only walks into two objects; anything else the user wrote wins
	// outright, and is then rejected for the fields it does not have.
	const d = await repoWith({ 'ship.config.json': '5' });
	await assert.rejects(() => loadConfig(d), /"name" is required/);
});
