// `ship qa` end to end over a temp repo. The browser is the only injected part:
// the fake capture hands back the same observations lib/qa-checks.mjs would get
// from a real page, so this exercises the whole command offline.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/commands/qa.mjs';
import { checkQa } from '../src/lib/preflight-live.mjs';
import { Report } from '../src/log.mjs';
import { cellId } from '../src/lib/qa-matrix.mjs';
import { ARTIFACTS, clone } from './fixtures/artifacts.mjs';
import { linkNativeDeps } from './fixtures/cmd.mjs';

const quiet = async (fn) => {
	const saved = { out: process.stdout.write, err: process.stderr.write };
	process.stdout.write = () => true;
	process.stderr.write = () => true;
	try {
		return await fn();
	} finally {
		process.stdout.write = saved.out;
		process.stderr.write = saved.err;
	}
};

async function repo({ config = {}, files = {} } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-qa-'));
	const merged = { name: 'Demo', bundleId: 'com.demo.app', version: '1.0.0', design: { qa: { url: 'http://localhost:8081' } }, ...config };
	await writeFile(join(dir, 'ship.config.json'), JSON.stringify(merged));
	const all = { 'design/ux.json': ARTIFACTS['ux-spec'], ...files };
	for (const [rel, body] of Object.entries(all)) {
		if (body === null) continue;
		await mkdir(join(dir, rel, '..'), { recursive: true });
		await writeFile(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
	}
	return dir;
}

async function inRepo(dir, args, flags = {}, capture) {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await quiet(() => run({ args, flags, capture }));
	} finally {
		process.chdir(cwd);
	}
}

/** The same, keeping stdout so a test can read what was printed. */
async function inRepoLoud(dir, args, flags = {}) {
	const cwd = process.cwd();
	const write = process.stdout.write;
	let out = '';
	const err = process.stderr.write;
	process.stdout.write = (chunk) => { out += chunk; return true; };
	process.stderr.write = (chunk) => { out += chunk; return true; };
	process.chdir(dir);
	try {
		const result = await run({ args, flags });
		return { out, result };
	} finally {
		process.stderr.write = err;
		process.chdir(cwd);
		process.stdout.write = write;
	}
}

const readReport = (dir, version = '1.0.0') => readFile(join(dir, 'qa', version, 'report.json'), 'utf8').then(JSON.parse);

/** A clean screen: one 48pt control, legible text, themed per cell. */
const clean = (cell) => ({
	view: { w: 428, h: 926 },
	overflowX: 0,
	tappables: [{ label: 'cta', w: 380, h: 48, x: 24, y: 700 }],
	texts: [{ label: cell.state === 'default' ? 'Keep going' : `state: ${cell.state}`, size: 17, weight: 400, fg: cell.theme === 'dark' ? '#e8eef7' : '#0d1b2a', bg: cell.theme === 'dark' ? '#0b1220' : '#ffffff' }],
	clipped: [],
	blank: false,
});

/** Stand in for the browser. `shape` decides what each cell "rendered". */
const fakeCapture = (shape = clean) => async (_cfg, _base, cells, dir) =>
	cells.map((cell) => ({ cell, obs: shape(cell), file: join(dir, `${cellId(cell)}.png`), sha256: `${cellId(cell)}`.padEnd(64, '0').slice(0, 64) }));

test('a clean run writes a schema-valid report and exits 0', async () => {
	const dir = await repo();
	assert.equal(await inRepo(dir, [], {}, fakeCapture()), 0);
	const report = await readReport(dir);
	assert.equal(report.version, '1.0.0');
	assert.equal(report.tier, 1);
	assert.equal(report.summary.fail, 0);
	assert.ok(report.summary.skipped >= 3, 'the Tier 2 categories are reported, not omitted');
	assert.deepEqual(report.matrix, { themes: ['light', 'dark'], locales: ['en-US'], dynamicType: ['default', 'xl'] });
});

test('the observations are kept beside the report, so a baseline can be taken later', async () => {
	const dir = await repo();
	await inRepo(dir, [], {}, fakeCapture());
	const obs = JSON.parse(await readFile(join(dir, 'qa', '1.0.0', 'observations.json'), 'utf8'));
	assert.ok(obs.length);
	assert.ok(obs.every((o) => o.cell && o.sha256 && Array.isArray(o.texts)));
});

test('a 32pt tap target fails the run and names the control', async () => {
	const dir = await repo();
	const small = (cell) => ({ ...clean(cell), tappables: [{ label: 'close', w: 32, h: 32, x: 8, y: 400 }] });
	assert.equal(await inRepo(dir, [], {}, fakeCapture(small)), 1);
	const report = await readReport(dir);
	const hit = report.checks.find((c) => c.category === 'tap-target' && c.status === 'FAIL');
	assert.match(hit.message, /"close" is 32×32pt/);
	assert.equal(report.checks[0].status, 'FAIL', 'failures sort to the top');
});

test('a build that ignores the theme parameter fails on dark mode alone', async () => {
	const dir = await repo();
	const unthemed = (cell) => ({ ...clean({ ...cell, theme: 'light' }), texts: clean({ ...cell, theme: 'light' }).texts });
	assert.equal(await inRepo(dir, [], {}, fakeCapture(unthemed)), 1);
	const report = await readReport(dir);
	assert.match(report.checks.find((c) => c.category === 'dark-mode').message, /theme parameter is not wired/);
});

test('a Tier 2 artifact raises the tier and answers only the rows it carries', async () => {
	const dir = await repo();
	await inRepo(dir, [], {}, fakeCapture());
	const tier2 = join(dir, 'tier2.json');
	await writeFile(tier2, JSON.stringify({ checks: [{ id: 'motion-paywall', category: 'motion', requiresTier: 2, status: 'PASS' }] }));
	assert.equal(await inRepo(dir, [], { tier2 }, fakeCapture()), 0);
	const report = await readReport(dir);
	assert.equal(report.tier, 2);
	assert.equal(report.checks.find((c) => c.id === 'motion-paywall').status, 'PASS');
	assert.equal(report.checks.find((c) => c.category === 'accessibility').status, 'SKIPPED');
});

test('with no web build to drive, the command says what to start', async () => {
	const dir = await repo({ config: { design: { qa: {} } } });
	await assert.rejects(() => inRepo(dir, [], {}, fakeCapture()), /no web build to drive/);
	assert.equal(await inRepo(dir, [], { url: 'http://localhost:9000' }, fakeCapture()), 0, '--url is enough on its own');
});

test('a draft ux.json is refused by name, before its schema is', async () => {
	const draft = clone(ARTIFACTS['ux-spec']);
	draft._todo = ['copy'];
	const dir = await repo({ files: { 'design/ux.json': draft } });
	await assert.rejects(() => inRepo(dir, [], {}, fakeCapture()), (err) => {
		assert.match(err.message, /ux\.json is still a draft/);
		assert.match(err.hint, /fill copy/);
		return true;
	});
});

test('an invalid ux.json is refused with every issue at once', async () => {
	const broken = clone(ARTIFACTS['ux-spec']);
	broken.screens[0].route = 'paywall';
	const dir = await repo({ files: { 'design/ux.json': broken } });
	await assert.rejects(() => inRepo(dir, [], {}, fakeCapture()), /does not match the ux-spec schema/);
});

test('the type ramp is only gated when design/system.json is there to gate against', async () => {
	const dir = await repo({ files: { 'design/system.json': ARTIFACTS['design-system'] } });
	const offRamp = (cell) => ({ ...clean(cell), texts: [{ ...clean(cell).texts[0], size: 15 }] });
	assert.equal(await inRepo(dir, [], {}, fakeCapture(offRamp)), 0, 'a ramp mismatch is a warning, not a block');
	const report = await readReport(dir);
	assert.match(report.checks.find((c) => c.category === 'typography').message, /15pt rendered but not in the type ramp/);
});

test('check gates the report on disk without capturing anything', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['check'], {}), /no report for 1\.0\.0/);
	await inRepo(dir, [], {}, fakeCapture());
	assert.equal(await inRepo(dir, ['check'], {}), 0);
	assert.equal(await inRepo(dir, ['check'], { json: true }), 0);
});

test('baseline accepts the current captures, and the next run compares against them', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['baseline'], {}), /nothing captured for 1\.0\.0/);
	await inRepo(dir, [], {}, fakeCapture());
	assert.equal((await readReport(dir)).checks.find((c) => c.category === 'regression').status, 'SKIPPED');

	assert.equal(await inRepo(dir, ['baseline'], {}), 0);
	await inRepo(dir, [], {}, fakeCapture());
	assert.ok((await readReport(dir)).checks.every((c) => c.category !== 'regression' || c.status === 'PASS'));

	// A screen that changed is a warning with the old hash beside the new one.
	const moved = (cell) => ({ ...clean(cell), overflowX: 0, tappables: [{ label: 'cta', w: 380, h: 48, x: 24, y: 690 }] });
	const shifted = async (cfg, base, cells, out) =>
		(await fakeCapture(moved)(cfg, base, cells, out)).map((c) => ({ ...c, sha256: 'f'.repeat(64) }));
	await inRepo(dir, [], {}, shifted);
	assert.ok((await readReport(dir)).checks.some((c) => c.category === 'regression' && c.status === 'WARN'));
});

// ── the preflight row ───────────────────────────────────────────────────────

const cfgOf = async (dir) => (await import('../src/config.mjs')).loadConfig(dir);

test('preflight skips qa in a repo that has no ux spec at all', async () => {
	const dir = await repo({ files: { 'design/ux.json': null } });
	const report = new Report('t');
	await checkQa(report, await cfgOf(dir), '1.0.0');
	assert.equal(report.rows[0].level, 'skip');
	assert.match(report.rows[0].detail, /no design\/ux\.json/);
});

test('preflight fails when a spec exists but nothing has been captured', async () => {
	const dir = await repo();
	const report = new Report('t');
	await checkQa(report, await cfgOf(dir), '1.0.0');
	assert.equal(report.rows[0].level, 'fail');
	assert.match(report.rows[0].detail, /run `ship qa`/);
});

test('preflight refuses a report written for another version', async () => {
	const dir = await repo();
	await inRepo(dir, [], {}, fakeCapture());
	const report = new Report('t');
	await checkQa(report, await cfgOf(dir), '1.0.0');
	assert.equal(report.rows[0].level, 'ok');

	const stale = await readReport(dir);
	stale.version = '0.9.0';
	await writeFile(join(dir, 'qa', '1.0.0', 'report.json'), JSON.stringify(stale));
	const second = new Report('t');
	await checkQa(second, await cfgOf(dir), '1.0.0');
	assert.equal(second.rows[0].level, 'fail');
	assert.match(second.rows[0].detail, /reports version 0\.9\.0/);
});

test('preflight carries the qa verdict through, warnings included', async () => {
	const dir = await repo();
	await inRepo(dir, [], {}, fakeCapture());
	const doc = await readReport(dir);
	for (const [status, level] of [['FAIL', 'fail'], ['WARN', 'warn']]) {
		doc.checks[0].status = status;
		doc.summary = { pass: 0, warn: status === 'WARN' ? 1 : 0, fail: status === 'FAIL' ? 1 : 0, skipped: 0 };
		await writeFile(join(dir, 'qa', '1.0.0', 'report.json'), JSON.stringify(doc));
		const report = new Report('t');
		await checkQa(report, await cfgOf(dir), '1.0.0');
		assert.equal(report.rows[0].level, level);
		assert.match(report.rows[0].detail, /macOS lane|tier 1/);
	}
});

// ── the browser half ────────────────────────────────────────────────────────
//
// Everything above injects `capture`. These drive the real captureCells against
// the stand-in puppeteer in test/fixtures/native, which shipkit resolves out of
// the app repo exactly as it would resolve the real one — so the navigation,
// the Accept-Language header, the root font-size scaling and the screenshot
// are the calls the command actually makes.

const puppeteer = createRequire(import.meta.url)('./fixtures/native/puppeteer/index.cjs');

test('the default capture drives one page per cell and screenshots each one', async () => {
	const dir = await repo();
	await linkNativeDeps(dir, ['sharp', 'puppeteer']);
	puppeteer.observed.value = clean({ theme: 'light', state: 'default' });
	puppeteer.calls.length = 0;
	// Let the stub run the one piece of page code the command ships — scaling the
	// root font size — against a document stood up here, the way test/qa.test.mjs
	// runs the probe itself.
	const root = { style: {} };
	globalThis.document = { documentElement: root };
	puppeteer.inProcess.run = true;

	const code = await inRepo(dir, [], {});
	assert.ok(code === 0 || code === 1, 'the run completes on its own captures');

	const obs = JSON.parse(await readFile(join(dir, 'qa', '1.0.0', 'observations.json'), 'utf8'));
	assert.ok(obs.length, 'every cell was observed');
	assert.ok(obs.every((o) => /^[0-9a-f]{64}$/.test(o.sha256)), 'the sha is of the bytes puppeteer returned');

	const shots = puppeteer.calls.filter(([kind]) => kind === 'screenshot');
	assert.equal(shots.length, obs.length);
	assert.ok(existsSync(shots[0][1]), 'the png is on disk beside the report');
	assert.ok(puppeteer.calls.some(([kind, h]) => kind === 'headers' && h['Accept-Language'] === 'en-US'));
	assert.ok(puppeteer.calls.some(([kind, , arg]) => kind === 'evaluate' && arg === 1), 'default Dynamic Type is scale 1');
	assert.ok(puppeteer.calls.some(([kind, , arg]) => kind === 'evaluate' && typeof arg === 'number' && arg > 1), 'xl asks for a larger root font');
	assert.ok(puppeteer.calls.some(([kind]) => kind === 'browserClose'), 'the browser is closed');
	assert.match(root.style.fontSize, /^\d+(\.\d+)?px$/, 'the scale landed on the root element, so a rem-only build still grows');
	puppeteer.inProcess.run = false;
	delete globalThis.document;
});

test('a repo without puppeteer is told what to install', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, [], {}), (err) => {
		assert.match(err.message, /puppeteer is not installed/);
		assert.match(err.hint, /npm i -D puppeteer/);
		return true;
	});
});

// ── how a report is presented ───────────────────────────────────────────────

/**
 * A schema-valid report of `n` open rows. Every third row measured nothing and
 * says nothing, which is what the table has to render as an empty cell rather
 * than "undefined".
 */
const bare = (n, status = 'WARN') => ({
	version: '1.0.0',
	generatedAt: new Date().toISOString(),
	tier: 1,
	checks: Array.from({ length: n }, (_, i) => ({
		id: `row-${i}`,
		category: 'layout',
		requiresTier: 1,
		status,
		...(i % 3 === 1 ? { measured: 32 } : {}),
		...(i % 3 === 2 ? { measured: 32, threshold: 44, message: `row ${i} is short` } : {}),
	})),
	summary: { pass: 0, warn: status === 'WARN' ? n : 0, fail: status === 'FAIL' ? n : 0, skipped: 0 },
});

const writeReport = (dir, doc) => writeFile(join(dir, 'qa', '1.0.0', 'report.json'), JSON.stringify(doc));

test('a report of more than forty open rows is truncated, and says how many it dropped', async () => {
	const dir = await repo();
	await mkdir(join(dir, 'qa', '1.0.0'), { recursive: true });
	await writeReport(dir, bare(45));
	const { out, result } = await inRepoLoud(dir, ['check'], {});
	assert.equal(result, 0, 'warnings alone do not fail the gate');
	assert.match(out, /… and 5 more/);
	assert.match(out, /row-0/);
	assert.match(out, /32 \/ 44/, 'a measured row prints its threshold beside it');
	assert.match(out, /row 2 is short/);
	assert.doesNotMatch(out, /row-44/);
});

test('--json prints the report and exits on its failures', async () => {
	const dir = await repo();
	await mkdir(join(dir, 'qa', '1.0.0'), { recursive: true });
	await writeReport(dir, bare(2, 'FAIL'));
	const { out, result } = await inRepoLoud(dir, ['check'], { json: true });
	assert.equal(result, 1);
	assert.deepEqual(JSON.parse(out.slice(out.indexOf('{'))).summary, { pass: 0, warn: 0, fail: 2, skipped: 0 });
});
