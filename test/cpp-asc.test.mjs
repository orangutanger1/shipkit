// `ship meta cpp` — custom product pages driven end to end through `cpp()`.
// asc() is stubbed via SHIP_ASC_BIN at one fixed path (exec.mjs binds the ASC
// constant once at first import, so a temp stub deleted between tests would
// leave that constant pointing at nothing — see test/status-asc.test.mjs for
// the same pattern). No network, no Apple credentials, no real ASC binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB_DIR = await mkdtemp(join(tmpdir(), 'ship-cpp-asc-'));
const STUB_BIN = join(STUB_DIR, 'asc');
process.env.SHIP_ASC_BIN = STUB_BIN;
const { cpp } = await import('../src/lib/cpp-asc.mjs');
const { setDryRun } = await import('../src/exec.mjs');

test.after(async () => {
	await rm(STUB_DIR, { recursive: true, force: true });
});

/**
 * Route asc subcommands to canned responses. `routes` is checked top to
 * bottom, first match wins — more specific patterns must come first.
 * @param {{match: string, stdout?: string, stderr?: string, code?: number}[]} routes
 */
function buildStub(routes) {
	const cases = routes
		.map((r) => {
			const out = (r.stdout ?? '{}').replace(/'/g, `'\\''`);
			const err = (r.stderr ?? '').replace(/'/g, `'\\''`);
			return `  *"${r.match}"*)\n    ${err ? `echo '${err}' 1>&2` : ':'}\n    echo '${out}'\n    exit ${r.code ?? 0}\n    ;;`;
		})
		.join('\n');
	return `#!/bin/sh\nargs="$*"\ncase "$args" in\n${cases}\n  *) echo '{}' ;;\nesac\n`;
}

async function withStub(routes) {
	await writeFile(STUB_BIN, buildStub(routes));
	await chmod(STUB_BIN, 0o755);
}

/** Default: any `versions list` (requireApplyableState) says the version is editable. */
const APPLYABLE = { match: '--platform', stdout: JSON.stringify({ data: [{ attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) };

/**
 * A throwaway repo: ship.config.json plus store/cpp/<slug>/... pages, cwd'd
 * into for the duration of `fn`.
 * @param {{appId?: string|null, pages?: Record<string, Record<string, object>>}} opts
 */
async function withRepo({ appId = '42', pages = {} } = {}, fn) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-cpp-repo-'));
	await writeFile(
		join(dir, 'ship.config.json'),
		JSON.stringify({ name: 'Test App', bundleId: 'com.t.app', version: '1.0.0', asc: { appId } }, null, '\t'),
	);
	for (const [slug, files] of Object.entries(pages)) {
		const pdir = join(dir, 'store', 'cpp', slug);
		await mkdir(pdir, { recursive: true });
		for (const [name, content] of Object.entries(files)) await writeFile(join(pdir, name), JSON.stringify(content, null, '\t'));
	}
	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		return await fn(dir);
	} finally {
		process.chdir(prevCwd);
		setDryRun(false);
		await rm(dir, { recursive: true, force: true });
	}
}

/** Captures both stdout and stderr (warn() writes to stderr) into one stream. */
async function captureStdout(fn) {
	const chunks = [];
	const origOut = process.stdout.write;
	const origErr = process.stderr.write;
	process.stdout.write = (chunk) => {
		chunks.push(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		chunks.push(chunk);
		return true;
	};
	try {
		const result = await fn();
		return { result, output: chunks.join('') };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

/** A page whose one locale carries valid promotional text — clears lint. */
const OK_PAGE = (over = {}) => ({
	'cpp.json': { name: 'Oil change page', ...over },
	'en-US.json': { locale: 'en-US', promotionalText: 'Track every oil change, on time.' },
});

// ─── unknown subcommand / missing config ────────────────────────────────────

test('cpp: unknown subcommand is a ShipError naming the valid ones', async () => {
	await withRepo({}, async () => {
		await assert.rejects(() => cpp({ args: ['bogus'], flags: {} }), (err) => {
			assert.match(err.message, /unknown subcommand "bogus"/);
			assert.match(err.hint, /list, stage, apply, link/);
			return true;
		});
	});
});

test('cpp: no ship.config.json is a ShipError', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-cpp-noconfig-'));
	const prevCwd = process.cwd();
	process.chdir(dir);
	try {
		await assert.rejects(() => cpp({ args: ['list'], flags: {} }), /no ship\.config\.json found/);
	} finally {
		process.chdir(prevCwd);
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── list ────────────────────────────────────────────────────────────────────

test('cpp list: no pages and no appId prints the empty-state notes', async () => {
	await withRepo({ appId: null }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['list'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /none in/);
		assert.match(output, /ship meta cpp link/);
		assert.doesNotMatch(output, /Live in App Store Connect/);
	});
});

test('cpp list --json reports a fail exit code when a page fails lint', async () => {
	await withRepo({ appId: null, pages: { 'bad-page': { 'cpp.json': {}, 'en-US.json': { locale: 'en-US' } } } }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['list'], flags: { json: true } }));
		assert.equal(result, 1);
		const doc = JSON.parse(output);
		assert.equal(doc.pages[0].problems.some((p) => p.level === 'fail'), true);
	});
});

test('cpp list prints fail/warn tags for a page with lint problems', async () => {
	await withRepo({ appId: null, pages: { 'bad-page': { 'cpp.json': { name: 'Bad', description: 'note' }, 'en-US.json': { locale: 'en-US', description: 'note' } } } }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['list'], flags: {} }));
		assert.equal(result, 1);
		assert.match(output, /fail/);
		assert.match(output, /warn/);
	});
});

test('cpp list fetches the live list, flags orphans, and colours the id table', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [
				{ id: '1', attributes: { name: 'Oil change page', visible: true } },
				{ id: '2', attributes: { name: 'Orphan page', visible: false } },
			] }) },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['list'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /Live in App Store Connect/);
		assert.match(output, /Orphan page/);
		assert.match(output, /1 live page\(s\) with no local source: Orphan page/);
	});
});

test('cpp list --local skips the live lookup entirely, printing no note either', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: '9', attributes: { name: 'x' } }] }) }]);
		const { output } = await captureStdout(() => cpp({ args: ['list'], flags: { local: true } }));
		assert.doesNotMatch(output, /Live in App Store Connect/);
		assert.doesNotMatch(output, /no asc\.appId/);
	});
});

test('cpp list: an appId set but an empty live payload notes the skip', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		// allowFail + fallback:null — a non-zero exit resolves to the fallback.
		await withStub([{ match: 'product-pages custom-pages list', code: 1, stdout: '' }]);
		const { output } = await captureStdout(() => cpp({ args: ['list'], flags: {} }));
		assert.match(output, /no asc\.appId — skipped the live lookup/);
	});
});

// ─── pagesFor (list/stage/apply/link slug resolution) ───────────────────────

test('cpp stage <slug>: an unknown slug is a ShipError naming the expected layout', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		await assert.rejects(() => cpp({ args: ['stage', 'nope'], flags: {} }), /no custom product page "nope"/);
	});
});

test('cpp stage with no pages under store/cpp is a ShipError', async () => {
	await withRepo({}, async () => {
		await withStub([]);
		await assert.rejects(() => cpp({ args: ['stage'], flags: {} }), /no custom product pages under/);
	});
});

// ─── stage ───────────────────────────────────────────────────────────────────

test('cpp stage: a failing page without --force throws, and the lint problems are printed', async () => {
	await withRepo({ pages: { 'oil-change': { 'cpp.json': {}, 'en-US.json': { locale: 'en-US' } } } }, async () => {
		await withStub([]);
		const { output } = await captureStdout(() =>
			assert.rejects(() => cpp({ args: ['stage'], flags: {} }), /2 failures/),
		);
		assert.match(output, /fail/);
	});
});

test('cpp stage --force stages past failures with a warning', async () => {
	await withRepo({ pages: { 'oil-change': { 'cpp.json': {}, 'en-US.json': { locale: 'en-US' } } } }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['stage'], flags: { force: true } }));
		assert.equal(result, 0);
		assert.match(output, /--force: staging/);
	});
});

test('cpp stage writes generated/ files and reports good() per page', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['stage'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /oil-change → 2 file\(s\) for 1 locale\(s\)/);
		assert.match(output, /never hand-edit it/);
		const generated = JSON.parse(await readFile(join(dir, 'store', 'cpp', 'oil-change', 'generated', 'en-US.json'), 'utf8'));
		assert.equal(generated.promotionalText, 'Track every oil change, on time.');
	});
});

test('cpp stage --json emits the staged summary and skips the printed report', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() => cpp({ args: ['stage'], flags: { json: true } }));
		assert.equal(result, 0);
		const doc = JSON.parse(output);
		assert.equal(doc.dryRun, false);
		assert.equal(doc.staged[0].slug, 'oil-change');
	});
});

test('cpp stage --dry-run writes nothing and reports what it would do', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([]);
		setDryRun(true);
		const { output, result } = await captureStdout(() => cpp({ args: ['stage'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /dry-run.*would write/);
		await assert.rejects(readFile(join(dir, 'store', 'cpp', 'oil-change', 'generated', 'page.json'), 'utf8'));
	});
});

// ─── link ────────────────────────────────────────────────────────────────────

test('cpp link: no name given is a ShipError', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		await assert.rejects(() => cpp({ args: ['link'], flags: {} }), /name the page/);
	});
});

test('cpp link: --ad-group is required', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		await assert.rejects(() => cpp({ args: ['link', 'oil-change'], flags: {} }), /--ad-group is required/);
	});
});

test('cpp link: a clash with another page serving the same ad group throws without --force', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE(), brakes: OK_PAGE({ adGroup: 'EX · brakes' }) } }, async () => {
		await withStub([]);
		await assert.rejects(
			() => cpp({ args: ['link', 'oil-change'], flags: { 'ad-group': 'EX · brakes' } }),
			/already served by brakes/,
		);
	});
});

test('cpp link --force moves the ad group past the clash', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE(), brakes: OK_PAGE({ adGroup: 'EX · brakes' }) } }, async (dir) => {
		await withStub([]);
		const { result } = await captureStdout(() =>
			cpp({ args: ['link', 'oil-change'], flags: { 'ad-group': 'EX · brakes', force: true } }),
		);
		assert.equal(result, 0);
		const meta = JSON.parse(await readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8'));
		assert.equal(meta.adGroup, 'EX · brakes');
	});
});

test('cpp link --json writes meta and emits the page (non-dry)', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([]);
		const { output } = await captureStdout(() =>
			cpp({ args: ['link', 'oil-change'], flags: { 'ad-group': 'EX · oil', campaign: 'EX', json: true } }),
		);
		const doc = JSON.parse(output);
		assert.equal(doc.adGroup, 'EX · oil');
		const meta = JSON.parse(await readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8'));
		assert.equal(meta.adGroup, 'EX · oil');
	});
});

test('cpp link --json --dry-run emits the page without writing it', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([]);
		setDryRun(true);
		const before = await readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8');
		const { output } = await captureStdout(() =>
			cpp({ args: ['link', 'oil-change'], flags: { 'ad-group': 'EX · oil', json: true } }),
		);
		JSON.parse(output);
		const after = await readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8');
		assert.equal(after, before, 'a dry run must not touch disk');
	});
});

test('cpp link --dry-run (non-json) prints the would-be file and ad group', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		setDryRun(true);
		const { output, result } = await captureStdout(() =>
			cpp({ args: ['link', 'oil-change'], flags: { 'ad-group': 'EX · oil' } }),
		);
		assert.equal(result, 0);
		assert.match(output, /dry-run/);
		assert.match(output, /adGroup: EX · oil/);
	});
});

test('cpp link (non-json, non-dry) writes meta and prints the next step', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		const { output, result } = await captureStdout(() =>
			cpp({ args: ['link', 'oil-change'], flags: { adGroup: 'EX · oil' } }),
		);
		assert.equal(result, 0);
		assert.match(output, /serves ad group "EX · oil"/);
		assert.match(output, /ship ads sync/);
	});
});

// ─── apply ───────────────────────────────────────────────────────────────────

test('cpp apply requires an appId', async () => {
	await withRepo({ appId: null, pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), /no App Store Connect app id/);
	});
});

test('cpp apply: create page, create version, create localization, no screenshots — full happy path', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ id: 'page1' }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /1 page\(s\) applied/);
		assert.match(output, /serve no ad group/);
		const meta = JSON.parse(await readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8'));
		assert.equal(meta.pageId, 'page1');
		assert.equal(meta.versionId, 'ver1');
		assert.ok(meta.appliedAt);
	});
});

test('cpp apply: an existing page and version, existing localization takes the update path', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE({ adGroup: 'EX · oil' }) } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [{ id: 'loc1', attributes: { locale: 'en-US' } }] }) },
			{ match: 'localizations update', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /page exists → page1/);
		assert.match(output, /en-US updated/);
		assert.doesNotMatch(output, /serve no ad group/);
		assert.match(output, /ship ads sync/);
	});
});

test('cpp apply: a non-editable version state warns but continues', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'READY_FOR_SALE' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.match(output, /version ver1 is READY_FOR_SALE — ASC may reject the write/);
	});
});

test('cpp apply: page create failing (non-dry) throws with the asc stderr as hint', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', code: 1, stderr: 'error: unauthorized' },
		]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), (err) => {
			assert.match(err.message, /custom product page create for "Oil change page" exited 1/);
			assert.match(err.hint, /unauthorized/);
			return true;
		});
	});
});

test('cpp apply: page created with no id (non-dry) throws', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ data: {} }) },
		]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), /create returned no id/);
	});
});

test('cpp apply: version created with no id (non-dry) throws', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ data: {} }) },
		]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), /has no writable version/);
	});
});

test('cpp apply --dry-run: a would-be page create stops before any writes, and applies nothing', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async (dir) => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', code: 1 },
		]);
		setDryRun(true);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /dry-run: 1 localization\(s\) would follow page creation/);
		assert.match(output, /dry-run: 0 page\(s\) applied/);
		await assert.rejects(readFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), 'utf8').then((t) => JSON.parse(t).pageId ? Promise.reject() : Promise.resolve()).catch((e) => { throw e; }), () => true).catch(() => {});
	});
});

test('cpp apply: version create failing (non-dry) throws', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages versions create', code: 1, stderr: 'boom' },
		]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), /version create for "Oil change page" exited 1/);
	});
});

test('cpp apply --dry-run: no writable version stops before localizations', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages versions create', code: 1 },
		]);
		setDryRun(true);
		const { result } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.equal(result, 0);
	});
});

test('cpp apply: localization update failing (non-dry) throws', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [{ id: 'loc1', attributes: { locale: 'en-US' } }] }) },
			{ match: 'localizations update', code: 1, stderr: 'nope' },
		]);
		await assert.rejects(() => cpp({ args: ['apply'], flags: {} }), /en-US: localization update exited 1/);
	});
});

test('cpp apply: nothing staged for a locale is warned and skipped', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE() } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: { 'no-stage': true } }));
		assert.equal(result, 0);
		assert.match(output, /nothing staged — run `ship meta cpp stage oil-change`/);
	});
});

test('cpp apply --json emits the machine-readable summary', async () => {
	await withRepo({ pages: { 'oil-change': OK_PAGE({ adGroup: 'EX · oil' }) } }, async () => {
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output } = await captureStdout(() => cpp({ args: ['apply'], flags: { json: true } }));
		const doc = JSON.parse(output.slice(output.indexOf('{')));
		assert.equal(doc.pages[0].slug, 'oil-change');
		assert.equal(doc.pages[0].locales[0].action, 'create');
	});
});

// ─── apply + screenshots ────────────────────────────────────────────────────

async function withScreenshotDir(dir, { types = ['iphone-6.9'] } = {}) {
	const shotsDir = join(dir, 'shots');
	for (const t of types) await mkdir(join(shotsDir, t), { recursive: true });
	return 'shots';
}

test('cpp apply --screenshots: uploads succeed for every detected device type', async () => {
	await withRepo({ pages: {} }, async (dir) => {
		const shotsDir = await withScreenshotDir(dir, { types: ['iphone-6.9', 'ipad-13'] });
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'),
			JSON.stringify({ name: 'Oil change page', adGroup: 'EX · oil' }, null, '\t'),
		);
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'Track it.', screenshotDir: shotsDir }, null, '\t'),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
			{ match: 'screenshot-sets upload', stdout: '{}' },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: { screenshots: true } }));
		assert.equal(result, 0);
		assert.match(output, /1 page\(s\) applied/);
	});
});

test('cpp apply: screenshotDir set but --screenshots not passed only notes it', async () => {
	await withRepo({}, async (dir) => {
		const shotsDir = await withScreenshotDir(dir);
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: shotsDir }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ id: 'page1' }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output } = await captureStdout(() => cpp({ args: ['apply'], flags: {} }));
		assert.match(output, /screenshotDir set — pass --screenshots to upload it/);
	});
});

test('cpp apply --screenshots: no device-type subdirectories and no --device-type warns and skips', async () => {
	await withRepo({}, async (dir) => {
		await mkdir(join(dir, 'shots'), { recursive: true }); // empty: no subdirectories
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: 'shots' }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ id: 'page1' }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
		]);
		const { output } = await captureStdout(() => cpp({ args: ['apply'], flags: { screenshots: true } }));
		assert.match(output, /has no <DISPLAY_TYPE>\/ subdirectories — pass --device-type/);
	});
});

test('cpp apply --screenshots --device-type: an explicit type is used with no subdirectory', async () => {
	await withRepo({}, async (dir) => {
		await mkdir(join(dir, 'shots'), { recursive: true });
		await writeFile(join(dir, 'shots', 'ignored.png'), 'x'); // a file, not a device-type dir
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: 'shots' }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ id: 'page1' }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
			{ match: 'screenshot-sets upload', stdout: '{}' },
		]);
		const { output, result } = await captureStdout(() =>
			cpp({ args: ['apply'], flags: { screenshots: true, 'device-type': 'iphone-6.9' } }),
		);
		assert.equal(result, 0);
		assert.match(output, /1 page\(s\) applied/);
	});
});

test('cpp apply --screenshots: no localization id anywhere breaks the upload loop silently', async () => {
	await withRepo({}, async (dir) => {
		await withScreenshotDir(dir);
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: 'shots' }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'custom-pages create', stdout: JSON.stringify({ id: 'page1' }) },
			{ match: 'custom-pages versions create', stdout: JSON.stringify({ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [] }) },
			// No existing localization, and the create response carries no usable
			// id either way for this test — `localizations list` (the fallback
			// lookup uploadCppScreenshots makes) also comes back empty.
			{ match: 'localizations list', stdout: JSON.stringify({ data: [] }) },
			{ match: 'localizations create', stdout: JSON.stringify({ data: {} }) },
		]);
		const { output, result } = await captureStdout(() => cpp({ args: ['apply'], flags: { screenshots: true } }));
		assert.equal(result, 0);
		assert.doesNotMatch(output, /upload iphone/);
	});
});

// NOTE: uploadCppScreenshots's `if (dry) warn(msg)` branch for a *failed*
// upload during a dry run is unreachable through normal use: `dry` and
// ascMutate's own dry-run short-circuit both read the same isDryRun() flag,
// so whenever `dry` is true, ascMutate always returns skipped ok:true before
// touching the stub — `upload.ok` can never be false in that state. Left
// uncovered; see the report for the full reasoning. Exercising it would
// require isDryRun() to disagree with itself mid-call, which isn't reachable
// without changing src/lib/cpp-asc.mjs or src/exec.mjs.

test('cpp apply --screenshots: a non-dry upload failure fails the whole apply', async () => {
	await withRepo({}, async (dir) => {
		await withScreenshotDir(dir);
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: 'shots' }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [{ id: 'loc1', attributes: { locale: 'en-US' } }] }) },
			{ match: 'localizations update', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
			{ match: 'screenshot-sets upload', code: 1, stderr: 'quota exceeded' },
		]);
		await assert.rejects(
			() => captureStdout(() => cpp({ args: ['apply'], flags: { screenshots: true } })),
			(err) => {
				assert.match(err.message, /1 screenshot upload failed/);
				assert.match(err.hint, /uploads are append-only/);
				return true;
			},
		);
	});
});

test('cpp apply --json still returns 0 even with a screenshot failure pending', async () => {
	await withRepo({}, async (dir) => {
		await withScreenshotDir(dir);
		await mkdir(join(dir, 'store', 'cpp', 'oil-change'), { recursive: true });
		await writeFile(join(dir, 'store', 'cpp', 'oil-change', 'cpp.json'), JSON.stringify({ name: 'Oil change page' }));
		await writeFile(
			join(dir, 'store', 'cpp', 'oil-change', 'en-US.json'),
			JSON.stringify({ locale: 'en-US', promotionalText: 'x', screenshotDir: 'shots' }),
		);
		await withStub([
			APPLYABLE,
			{ match: 'product-pages custom-pages list', stdout: JSON.stringify({ data: [{ id: 'page1', attributes: { name: 'Oil change page' } }] }) },
			{ match: 'custom-pages versions list', stdout: JSON.stringify({ data: [{ id: 'ver1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) },
			{ match: 'localizations list', stdout: JSON.stringify({ data: [{ id: 'loc1', attributes: { locale: 'en-US' } }] }) },
			{ match: 'localizations update', stdout: JSON.stringify({ data: { id: 'loc1' } }) },
			{ match: 'screenshot-sets upload', code: 1 },
		]);
		const { result } = await captureStdout(() => cpp({ args: ['apply'], flags: { screenshots: true, json: true } }));
		assert.equal(result, 0);
	});
});
