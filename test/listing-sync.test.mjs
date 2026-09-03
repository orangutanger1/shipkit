// The listing lifecycle: lint, pull, apply, migrate, keywords. asc is stubbed
// via SHIP_ASC_BIN at one fixed path for the whole process (exec.mjs binds ASC
// once, at first import) with per-test script content swapped in, exactly like
// status-asc.test.mjs. Everything else is real filesystem under a temp repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB_DIR = await mkdtemp(join(tmpdir(), 'ship-listing-sync-'));
const STUB_BIN = join(STUB_DIR, 'asc');
process.env.SHIP_ASC_BIN = STUB_BIN;

const listingSync = await import('../src/lib/listing-sync.mjs');
const { loadConfig } = await import('../src/config.mjs');

/** Route asc subcommands (matched by substring) to canned JSON or a script body outright. */
async function stubAsc(routes) {
	if (typeof routes === 'string') {
		await writeFile(STUB_BIN, routes);
	} else {
		const cases = Object.entries(routes)
			.map(([key, json]) => `  *"${key}"*) echo '${json.replace(/'/g, `'\\''`)}' ;;`)
			.join('\n');
		await writeFile(STUB_BIN, `#!/bin/sh\nargs="$*"\ncase "$args" in\n${cases}\n  *) echo '{}' ;;\nesac\n`);
	}
	await chmod(STUB_BIN, 0o755);
}

test.after(async () => {
	await rm(STUB_DIR, { recursive: true, force: true });
});

// `warn()` writes to stderr, `good`/`note`/`info`/`table` write to stdout — a
// command's output is the interleaving of both, so both are captured here.
function captureStdout(fn) {
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
		const result = fn();
		return { result, output: chunks.join('') };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

async function captureStdoutAsync(fn) {
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

const COMPLETE = {
	name: 'Glovebox',
	subtitle: 'Car service log',
	keywords: 'oil,tyre,brakes,mileage',
	description: 'x'.repeat(200),
};

/**
 * Build a temp repo with ship.config.json + store/staged/<locale>.json files,
 * chdir into it for the duration of `fn`, then restore and clean up.
 */
async function withRepo({ config = {}, staged = { 'en-US': COMPLETE } } = {}, fn) {
	const root = await mkdtemp(join(tmpdir(), 'ship-listing-repo-'));
	await writeFile(
		join(root, 'ship.config.json'),
		JSON.stringify({ name: 'Glovebox', bundleId: 'com.test.glovebox', version: '1.0.0', asc: { appId: '42' }, ...config }, null, '\t'),
	);
	if (staged) {
		const dir = join(root, 'store', 'staged');
		await mkdir(dir, { recursive: true });
		for (const [locale, data] of Object.entries(staged)) {
			await writeFile(join(dir, `${locale}.json`), JSON.stringify({ locale, ...data }));
		}
	}
	const prevCwd = process.cwd();
	process.chdir(root);
	try {
		return await fn(root);
	} finally {
		process.chdir(prevCwd);
		await rm(root, { recursive: true, force: true });
	}
}

/* --------------------------------------------------------------- stderrTail -- */

test('stderrTail keeps the last N lines and falls back when stderr is empty', () => {
	assert.equal(listingSync.stderrTail(''), 'check asc auth: asc auth status');
	const many = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
	assert.equal(listingSync.stderrTail(many, { lines: 2 }), 'line8\nline9');
});

/* -------------------------------------------------------------------- lint -- */

test('lint --json reports zero failures for a complete listing', async () => {
	await withRepo({}, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.lint({ flags: { json: true } }));
		assert.equal(result, 0);
		const parsed = JSON.parse(output);
		assert.equal(parsed.failures, 0);
	});
});

test('lint --json reports failures for an incomplete listing and exits 1', async () => {
	await withRepo({ staged: { 'en-US': { name: '', subtitle: '', keywords: '', description: '' } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.lint({ flags: { json: true } }));
		assert.equal(result, 1);
		const parsed = JSON.parse(output);
		assert.ok(parsed.failures > 0);
	});
});

test('lint prints a table with problems and exits 1 on failure', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, name: '' } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.lint({ flags: {} }));
		assert.equal(result, 1);
		assert.match(output, /fail/);
		assert.match(output, /en-US/);
	});
});

test('lint prints ok with no warnings for a clean listing', async () => {
	await withRepo({}, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.lint({ flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /no failures/);
	});
});

test('lint reports warnings alongside a clean pass', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, keywords: 'oil,glovebox' } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.lint({ flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /warning/);
	});
});

test('lint throws when there are no staged listings', async () => {
	await withRepo({ staged: null }, async () => {
		await assert.rejects(() => listingSync.lint({ flags: {} }), /no staged listings/);
	});
});

/* ---------------------------------------------------------------- gateOnLint -- */

test('gateOnLint throws on a lint failure without --force', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, name: '' } } }, async () => {
		const cfg = await loadConfig();
		await assert.rejects(() => listingSync.gateOnLint(cfg, {}), /lint failure/);
	});
});

test('gateOnLint continues past a lint failure with --force', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, name: '' } } }, async () => {
		const cfg = await loadConfig();
		const { result: rows, output } = await captureStdoutAsync(() => listingSync.gateOnLint(cfg, { force: true }));
		assert.equal(rows.length, 1);
		assert.match(output, /--force: continuing past/);
	});
});

test('gateOnLint reports clean with warnings when there are no failures', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, keywords: 'oil,glovebox' } } }, async () => {
		const cfg = await loadConfig();
		const { output } = await captureStdoutAsync(() => listingSync.gateOnLint(cfg, {}));
		assert.match(output, /lint clean.*warning/s);
	});
});

/* --------------------------------------------------------------------- pull -- */

test('pull folds app-info + version JSON into staged/, tracking created vs updated', async () => {
	await stubAsc({
		'metadata pull': JSON.stringify({ ok: true }),
	});
	await withRepo({ staged: { 'en-US': COMPLETE } }, async (root) => {
		// Seed what `asc metadata pull` would have written directly, since the
		// stub above only needs to exit 0 — pull() reads these trees itself.
		await mkdir(join(root, 'store', 'app-info'), { recursive: true });
		await mkdir(join(root, 'store', 'version', '1.0.0'), { recursive: true });
		await writeFile(join(root, 'store', 'app-info', 'en-US.json'), JSON.stringify({ name: 'Pulled Name', subtitle: 'Pulled Sub' }));
		await writeFile(join(root, 'store', 'app-info', 'fr-FR.json'), JSON.stringify({ name: 'Nom', subtitle: 'Sous-titre' }));
		await writeFile(join(root, 'store', 'version', '1.0.0', 'en-US.json'), JSON.stringify({ description: 'Desc', keywords: 'a,b' }));

		const { result, output } = await captureStdoutAsync(() => listingSync.pull({ flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /1 created, 1 updated|2 created, 0 updated|1 updated/);

		const enOut = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(enOut.name, 'Pulled Name');
		assert.equal(enOut.keywords, 'a,b');
		const frOut = JSON.parse(await readFile(join(root, 'store', 'staged', 'fr-FR.json'), 'utf8'));
		assert.equal(frOut.name, 'Nom');
	});
});

test('pull preserves authored notes across a re-pull', async () => {
	await stubAsc({ 'metadata pull': JSON.stringify({ ok: true }) });
	await withRepo({ staged: { 'en-US': { ...COMPLETE, notes: 'why these keywords' } } }, async (root) => {
		await mkdir(join(root, 'store', 'app-info'), { recursive: true });
		await writeFile(join(root, 'store', 'app-info', 'en-US.json'), JSON.stringify({ name: 'New Name' }));
		await listingSync.pull({ flags: {} });
		const out = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(out.notes, 'why these keywords');
	});
});

test('pull throws when asc metadata pull exits non-zero', async () => {
	await stubAsc('#!/bin/sh\necho "unauthorized" >&2\nexit 1\n');
	await withRepo({}, async () => {
		await assert.rejects(() => listingSync.pull({ flags: {} }), /metadata pull exited 1/);
	});
});

test('pull throws when asc pulled no localizations at all', async () => {
	await stubAsc({ 'metadata pull': JSON.stringify({ ok: true }) });
	await withRepo({}, async () => {
		await assert.rejects(() => listingSync.pull({ flags: {} }), /pulled no localizations/);
	});
});

test('pull dry-run reports nothing pulled without writing or throwing', async () => {
	await stubAsc({ 'metadata pull': JSON.stringify({ ok: true }) });
	const { setDryRun } = await import('../src/exec.mjs');
	await withRepo({}, async () => {
		setDryRun(true);
		try {
			const { result, output } = await captureStdoutAsync(() => listingSync.pull({ flags: {} }));
			assert.equal(result, 0);
			assert.match(output, /dry-run.*nothing pulled/);
		} finally {
			setDryRun(false);
		}
	});
});

test('pull dry-run reports what it would fold without writing', async () => {
	await stubAsc({ 'metadata pull': JSON.stringify({ ok: true }) });
	const { setDryRun } = await import('../src/exec.mjs');
	await withRepo({}, async (root) => {
		await mkdir(join(root, 'store', 'app-info'), { recursive: true });
		await writeFile(join(root, 'store', 'app-info', 'en-US.json'), JSON.stringify({ name: 'X' }));
		setDryRun(true);
		try {
			const { output } = await captureStdoutAsync(() => listingSync.pull({ flags: {} }));
			assert.match(output, /dry-run.*would fold/);
		} finally {
			setDryRun(false);
		}
	});
});

/* ------------------------------------------------------------- stateOf -- */

test('stateOf reads appStoreState, state, or attributes.appStoreState, in that order', () => {
	assert.equal(listingSync.stateOf({ appStoreState: 'READY_FOR_SALE' }), 'READY_FOR_SALE');
	assert.equal(listingSync.stateOf({ state: 'X' }), 'X');
	assert.equal(listingSync.stateOf({ attributes: { appStoreState: 'Y' } }), 'Y');
	assert.equal(listingSync.stateOf(null), null);
	assert.equal(listingSync.stateOf([1, 2]), null);
	assert.equal(listingSync.stateOf({}), null);
});

/* ----------------------------------------------------- requireApplyableState -- */

test('requireApplyableState throws when no version exists and there is no --force', async () => {
	await stubAsc({ 'versions list': JSON.stringify({ data: [] }) });
	await withRepo({}, async () => {
		const cfg = await loadConfig();
		await assert.rejects(() => listingSync.requireApplyableState(cfg, '42', '1.0.0', {}), /no IOS version/);
	});
});

test('requireApplyableState warns and returns null with --force when state is unreadable', async () => {
	await stubAsc({ 'versions list': JSON.stringify({ data: [] }) });
	await withRepo({}, async () => {
		const cfg = await loadConfig();
		const { result, output } = await captureStdoutAsync(() => listingSync.requireApplyableState(cfg, '42', '1.0.0', { force: true }));
		assert.equal(result, null);
		assert.match(output, /--force: could not read/);
	});
});

test('requireApplyableState accepts an applyable state', async () => {
	await stubAsc({ 'versions list': JSON.stringify({ data: [{ attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }) });
	await withRepo({}, async () => {
		const cfg = await loadConfig();
		const { result } = await captureStdoutAsync(() => listingSync.requireApplyableState(cfg, '42', '1.0.0', {}));
		assert.equal(result, 'PREPARE_FOR_SUBMISSION');
	});
});

test('requireApplyableState throws on a non-applyable state without --force', async () => {
	await stubAsc({ 'versions list': JSON.stringify({ data: [{ attributes: { appStoreState: 'IN_REVIEW' } }] }) });
	await withRepo({}, async () => {
		const cfg = await loadConfig();
		await assert.rejects(() => listingSync.requireApplyableState(cfg, '42', '1.0.0', {}), /IN_REVIEW.*locked/);
	});
});

test('requireApplyableState warns and continues past a non-applyable state with --force', async () => {
	await stubAsc({ 'versions list': JSON.stringify({ data: [{ attributes: { appStoreState: 'IN_REVIEW' } }] }) });
	await withRepo({}, async () => {
		const cfg = await loadConfig();
		const { result, output } = await captureStdoutAsync(() => listingSync.requireApplyableState(cfg, '42', '1.0.0', { force: true }));
		assert.equal(result, 'IN_REVIEW');
		assert.match(output, /--force: applying anyway/);
	});
});

/* -------------------------------------------------------------------- apply -- */

test('apply dry-run stages, checks state, plans, and stops before writing', async () => {
	await stubAsc({
		'versions list': JSON.stringify({ data: [{ attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }),
		'metadata apply': JSON.stringify({ added: 2, updated: 1 }),
	});
	const { setDryRun } = await import('../src/exec.mjs');
	await withRepo({}, async () => {
		setDryRun(true);
		try {
			const { result, output } = await captureStdoutAsync(() => listingSync.apply({ flags: {} }));
			assert.equal(result, 0);
			assert.match(output, /stopping before the real apply/);
			assert.match(output, /add.*update.*delete/s);
		} finally {
			setDryRun(false);
		}
	});
});

test('apply --no-stage skips expanding staged/ into store trees', async () => {
	await stubAsc({
		'versions list': JSON.stringify({ data: [{ attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] }),
		'metadata apply': JSON.stringify({}),
	});
	const { setDryRun } = await import('../src/exec.mjs');
	await withRepo({}, async () => {
		setDryRun(true);
		try {
			const { output } = await captureStdoutAsync(() => listingSync.apply({ flags: { 'no-stage': true } }));
			assert.match(output, /--no-stage: pushing/);
			assert.match(output, /reported no changes/);
		} finally {
			setDryRun(false);
		}
	});
});

test('apply runs two mutate passes and writes a report on success, warning on pass 1 failure', async () => {
	await stubAsc(
		`#!/bin/sh
args="$*"
case "$args" in
  *"versions list"*) echo '{"data":[{"attributes":{"appStoreState":"PREPARE_FOR_SUBMISSION"}}]}' ;;
  *"metadata apply"*"--dry-run"*) echo '{"added":1}' ;;
  *"metadata apply"*)
    if [ -f "${STUB_DIR}/pass1done" ]; then
      echo '{"result":"ok"}'
    else
      touch "${STUB_DIR}/pass1done"
      echo "locale already exists" >&2
      exit 1
    fi
    ;;
  *) echo '{}' ;;
esac
`,
	);
	await withRepo({}, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.apply({ flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /apply pass 1 exited 1/);
		assert.match(output, /metadata applied to/);
	});
	await rm(join(STUB_DIR, 'pass1done'), { force: true });
});

test('apply throws when pass 2 exits non-zero', async () => {
	await stubAsc(
		`#!/bin/sh
args="$*"
case "$args" in
  *"versions list"*) echo '{"data":[{"attributes":{"appStoreState":"PREPARE_FOR_SUBMISSION"}}]}' ;;
  *"metadata apply"*"--dry-run"*) echo '{}' ;;
  *"metadata apply"*) echo "boom" >&2; exit 2 ;;
  *) echo '{}' ;;
esac
`,
	);
	await withRepo({}, async () => {
		await assert.rejects(() => listingSync.apply({ flags: {} }), /metadata apply pass 2 exited 2/);
	});
});

test('apply throws and lists failures found in the apply payload', async () => {
	await stubAsc(
		`#!/bin/sh
args="$*"
case "$args" in
  *"versions list"*) echo '{"data":[{"attributes":{"appStoreState":"PREPARE_FOR_SUBMISSION"}}]}' ;;
  *"metadata apply"*"--dry-run"*) echo '{}' ;;
  *"metadata apply"*) echo '{"localizations":{"errors":["en-US: bad description"]}}' ;;
  *) echo '{}' ;;
esac
`,
	);
	await withRepo({}, async () => {
		await assert.rejects(() => listingSync.apply({ flags: {} }), /1 localization failed to apply/);
	});
});

test('apply collects failures nested as an array of error objects and a lone error object', async () => {
	await stubAsc(
		`#!/bin/sh
args="$*"
case "$args" in
  *"versions list"*) echo '{"data":[{"attributes":{"appStoreState":"PREPARE_FOR_SUBMISSION"}}]}' ;;
  *"metadata apply"*"--dry-run"*) echo '{}' ;;
  *"metadata apply"*) echo '{"errors":[{"detail":"en-US: bad description"},{"message":"fr-FR: bad name"},"plain string"],"otherFailure":{"detail":"top level"}}' ;;
  *) echo '{}' ;;
esac
`,
	);
	await withRepo({}, async () => {
		await assert.rejects(() => listingSync.apply({ flags: {} }), (err) => {
			assert.match(err.message, /4 localizations failed to apply/);
			return true;
		});
	});
});

test('apply throws when there is no App Store Connect app id', async () => {
	await withRepo({ config: { asc: { appId: null } } }, async () => {
		await assert.rejects(() => listingSync.apply({ flags: {} }), /no App Store Connect app id/);
	});
});

/* ------------------------------------------------------------------ migrate -- */

async function withStringsDirs(root, { from = {}, appInfo = {} } = {}) {
	if (Object.keys(from).length) {
		await mkdir(join(root, 'localizations'), { recursive: true });
		for (const [locale, body] of Object.entries(from)) await writeFile(join(root, 'localizations', `${locale}.strings`), body);
	}
	if (Object.keys(appInfo).length) {
		await mkdir(join(root, 'app-info-localizations'), { recursive: true });
		for (const [locale, body] of Object.entries(appInfo)) await writeFile(join(root, 'app-info-localizations', `${locale}.strings`), body);
	}
}

test('migrate converts both .strings trees into one staged file per locale', async () => {
	await withRepo({ staged: null }, async (root) => {
		await withStringsDirs(root, {
			from: { 'en-US': '"description" = "Desc";\n"keywords" = "a,b";\n"unknown_key" = "x";\n' },
			appInfo: { 'en-US': '"name" = "Glovebox";\n"subtitle" = "Sub";\n' },
		});
		const { result, output } = await captureStdoutAsync(() => listingSync.migrate({ flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /converted 1 locale/);
		const staged = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(staged.description, 'Desc');
		assert.equal(staged.keywords, 'a,b');
		assert.equal(staged.name, 'Glovebox');
		assert.equal(staged.subtitle, 'Sub');
		// An unrecognised .strings key is reported, not silently carried across.
		assert.equal('unknown_key' in staged, false);
	});
});

test('migrate dry-run says what it would write and writes nothing', async () => {
	await withRepo({ staged: null }, async (root) => {
		await withStringsDirs(root, { appInfo: { 'en-US': '"name" = "N";\n' } });
		const { setDryRun } = await import('../src/exec.mjs');
		setDryRun(true);
		try {
			const { output } = await captureStdoutAsync(() => listingSync.migrate({ flags: {} }));
			assert.match(output, /dry-run.*would convert 1 locale/);
		} finally {
			setDryRun(false);
		}
		assert.equal(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8').catch(() => null), null);
	});
});

test('migrate takes --from over the default directory', async () => {
	await withRepo({ staged: null }, async (root) => {
		await mkdir(join(root, 'custom-from'), { recursive: true });
		await writeFile(join(root, 'custom-from', 'en-US.strings'), '"description" = "D";\n');
		const { output } = await captureStdoutAsync(() => listingSync.migrate({ flags: { from: join(root, 'custom-from') } }));
		assert.match(output, /converted 1 locale/);
		const staged = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(staged.description, 'D');
	});
});

test('migrate names the flags to pass when there is nothing to convert', async () => {
	await withRepo({ staged: null }, async () => {
		await assert.rejects(() => listingSync.migrate({ flags: {} }), (err) => {
			assert.match(err.message, /nothing to convert/);
			assert.match(err.hint, /--from <dir>/);
			return true;
		});
	});
});

/* ----------------------------------------------------------------- keywords -- */

test('keywords lists terms, cost, and running total; exits 0 under the limit', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, name: 'Glovebox', subtitle: 'Car log' } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.keywords({ args: [], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /oil/);
		assert.match(output, /characters used|unused/);
	});
});

test('keywords --json emits the parsed rows and exits 1 over the limit', async () => {
	const long = Array.from({ length: 20 }, (_, i) => `word${i}longenoughtocount`).join(',');
	await withRepo({ staged: { 'en-US': { ...COMPLETE, keywords: long } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.keywords({ args: [], flags: { json: true } }));
		assert.equal(result, 1);
		const parsed = JSON.parse(output);
		assert.equal(parsed.locale, 'en-US');
		assert.ok(parsed.used > parsed.limit);
	});
});

test('keywords warns about wasted slots already indexed by name/subtitle', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, name: 'Glovebox', subtitle: 'Car log', keywords: 'glovebox,oil' } } }, async () => {
		const { output } = await captureStdoutAsync(() => listingSync.keywords({ args: [], flags: {} }));
		assert.match(output, /wasted slot/);
		assert.match(output, /already in name\/subtitle/);
	});
});

test('keywords over the limit warns with the overage', async () => {
	const long = Array.from({ length: 20 }, (_, i) => `word${i}longenoughtocount`).join(',');
	await withRepo({ staged: { 'en-US': { ...COMPLETE, keywords: long } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.keywords({ args: [], flags: {} }));
		assert.equal(result, 1);
		assert.match(output, /characters over the limit/);
	});
});

test('keywords reports "characters used" (green) when usage is high but under the limit', async () => {
	// 82/100 leaves 18% free, under the 20% "unused" warning threshold.
	await withRepo({ staged: { 'en-US': { ...COMPLETE, keywords: 'x'.repeat(41) + ',' + 'y'.repeat(40) } } }, async () => {
		const { result, output } = await captureStdoutAsync(() => listingSync.keywords({ args: [], flags: {} }));
		assert.equal(result, 0);
		assert.match(output, /82\/100 characters used/);
	});
});

test('keywords throws when the requested locale has no staged listing', async () => {
	await withRepo({ staged: { 'en-US': COMPLETE } }, async () => {
		await assert.rejects(() => listingSync.keywords({ args: ['de-DE'], flags: {} }), /no staged listing for de-DE/);
	});
});

/* --------------------------------------------------------------- setKeywords -- */

test('keywords --set rewrites the keywords field and preserves other authored fields', async () => {
	await withRepo({ staged: { 'en-US': { ...COMPLETE, notes: 'n' } } }, async (root) => {
		const { result, output } = await captureStdoutAsync(() => listingSync.keywords({ args: ['en-US'], flags: { set: 'new,terms,here' } }));
		assert.equal(result, 0);
		assert.match(output, /new,terms,here/);
		const out = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(out.keywords, 'new,terms,here');
		assert.equal(out.notes, 'n');
	});
});

test('keywords --set dry-run prints the diff without writing', async () => {
	await withRepo({ staged: { 'en-US': COMPLETE } }, async (root) => {
		const { setDryRun } = await import('../src/exec.mjs');
		setDryRun(true);
		try {
			const { output } = await captureStdoutAsync(() => listingSync.keywords({ args: ['en-US'], flags: { set: 'new,terms' } }));
			assert.match(output, /dry-run/);
			assert.match(output, /- oil,tyre,brakes,mileage/);
			assert.match(output, /\+ new,terms/);
		} finally {
			setDryRun(false);
		}
		const out = JSON.parse(await readFile(join(root, 'store', 'staged', 'en-US.json'), 'utf8'));
		assert.equal(out.keywords, COMPLETE.keywords);
	});
});

test('keywords --set over the limit throws with the drop hint', async () => {
	await withRepo({ staged: { 'en-US': COMPLETE } }, async () => {
		const long = Array.from({ length: 20 }, (_, i) => `word${i}longenoughtocount`).join(',');
		await assert.rejects(() => listingSync.keywords({ args: ['en-US'], flags: { set: long } }), /over the limit/);
	});
});
