// `ship new` end to end: scaffolding a fresh app from the template tree, with
// and without a scout brief. Everything is written into a temp directory and
// then wired by `ship init`, so a fake `asc` answers the one ASC lookup init
// makes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, setBin, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/new.mjs');
const { setDryRun } = await import('../src/exec.mjs');

/** A scout brief, as `ship scout brief` writes one. */
const BRIEF = {
	term: 'car maintenance log', slug: 'car-maintenance-log',
	market: { country: 'US', lang: 'en_us' },
	demand: 40, competition: 20, opportunity: 35,
	listing: { name: 'Wrenchy', subtitle: 'Car maintenance log', keywords: 'car,service,log', description: 'Track your car.' },
	related: ['car service log', 'oil change reminder'],
	verdict: { go: true, reasons: [] },
};

/** @param {string[]} args @param {{flags?: object, cwd: string}} opts */
async function newApp(args, { flags = {}, cwd }) {
	setBin('asc', []);
	const { result, out } = await capture(() => inDir(cwd, () => run({ args, flags })));
	return { code: result, out };
}

const workdir = () => mkdtemp(join(tmpdir(), 'ship-new-'));
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

test('a slug is all it takes, and the scaffold is wired by init', async () => {
	const cwd = await workdir();
	const { code, out } = await newApp(['wrenchy'], { cwd });
	assert.equal(code, 0);
	const dir = join(cwd, 'wrenchy');
	const app = await readJson(dir, 'app.json');
	assert.equal(app.expo.slug, 'wrenchy');
	assert.equal(app.expo.scheme, 'wrenchy');
	assert.equal(app.expo.ios.bundleIdentifier, 'com.wrenchy.app');
	assert.ok(existsSync(join(dir, 'ship.config.json')), 'init ran over the scaffold');
	assert.match(out, /bundle id was derived as com.wrenchy.app/);
	assert.match(out, /eas init/);
});

test('--name and --bundle-id override what the slug would have derived', async () => {
	const cwd = await workdir();
	const { out } = await newApp(['wrenchy'], { cwd, flags: { name: 'Wrenchy Pro', 'bundle-id': 'com.acme.wrenchy' } });
	const app = await readJson(join(cwd, 'wrenchy'), 'app.json');
	assert.equal(app.expo.name, 'Wrenchy Pro');
	assert.equal(app.expo.ios.bundleIdentifier, 'com.acme.wrenchy');
	assert.doesNotMatch(out, /bundle id was derived/);
});

test('a bad slug, name or bundle id is refused before anything is written', async () => {
	const cwd = await workdir();
	await assert.rejects(() => newApp([], { cwd }), /a slug is required/);
	await assert.rejects(() => newApp(['Wrenchy!'], { cwd }), /invalid slug "Wrenchy!"/);
	await assert.rejects(() => newApp(['wrenchy'], { cwd, flags: { name: 'Say "hi"' } }), /invalid display name/);
	await assert.rejects(() => newApp(['wrenchy'], { cwd, flags: { 'bundle-id': 'nope' } }), /invalid bundle id "nope"/);
});

test('a non-empty target directory needs --force', async () => {
	const cwd = await workdir();
	await writeFiles(cwd, { 'wrenchy/README.md': 'mine' });
	await assert.rejects(() => newApp(['wrenchy'], { cwd }), /is not empty \(1 entries\)/);
	const { code } = await newApp(['wrenchy'], { cwd, flags: { force: true } });
	assert.equal(code, 0);
});

test('--dir puts the app somewhere else', async () => {
	const cwd = await workdir();
	const target = join(cwd, 'apps', 'wrenchy');
	const { code } = await newApp(['wrenchy'], { cwd, flags: { dir: target } });
	assert.equal(code, 0);
	assert.ok(existsSync(join(target, 'app.json')));
});

test('--dry-run writes nothing', async () => {
	const cwd = await workdir();
	setDryRun(true);
	try {
		const { code, out } = await newApp(['wrenchy'], { cwd });
		assert.equal(code, 0);
		assert.match(out, /Files that would be written/);
		assert.match(out, /would run ship init/);
		assert.ok(!existsSync(join(cwd, 'wrenchy', 'app.json')));
	} finally {
		setDryRun(false);
	}
});

test('--from a brief names the app, stages its listing and seeds the ASO config', async () => {
	const cwd = await workdir();
	await writeFiles(cwd, { 'brief.json': BRIEF });
	const { code, out } = await newApp([], { cwd, flags: { from: join(cwd, 'brief.json') } });
	assert.equal(code, 0);
	const dir = join(cwd, 'car-maintenance-log');
	assert.equal((await readJson(dir, 'app.json')).expo.name, 'Wrenchy');
	const staged = await readJson(dir, 'store/staged/en-US.json');
	assert.equal(staged.name, 'Wrenchy');
	assert.equal(staged.subtitle, 'Car maintenance log');
	const cfg = await readJson(dir, 'ship.config.json');
	assert.ok(cfg.aso.seeds.length, 'the brief seeds the keyword sweep');
	assert.match(out, /brief/);
	assert.match(out, /term       car maintenance log/);
});

test('a NO-GO brief scaffolds anyway, saying which gate it failed', async () => {
	const cwd = await workdir();
	await writeFiles(cwd, { 'brief.json': { ...BRIEF, verdict: { go: false, reasons: [{ gate: 'moat', message: 'too many reviews' }] } } });
	const { code, out } = await newApp([], { cwd, flags: { from: join(cwd, 'brief.json') } });
	assert.equal(code, 0);
	assert.match(out, /NO-GO on moat — scaffolding anyway/);
});
