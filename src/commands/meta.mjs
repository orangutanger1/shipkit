// App Store listing metadata.
//
// `store/staged/<locale>.json` is the only file a human edits. Everything else
// under `store/` — app-info/, version/<v>/ — is generated from it and is safe to
// delete. That split exists because `asc metadata apply --dir` wants one field
// per file-tree location while a copywriter wants one file per language, and
// hand-maintaining the canonical tree is how locales silently drift apart.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LIMITS, loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { asc, ascMutate, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import {
	APP_INFO_FIELDS,
	VERSION_FIELDS,
	keywordList,
	lintListing,
	normaliseKeywords,
	parseStrings,
	readStaged,
	stage as expand,
} from '../lib/locales.mjs';
import {
	cppDir,
	cppRoot,
	generatedDir,
	lintPage,
	readPage,
	readPages,
	screenshotDir,
	slugify,
	stagePage,
	writeMeta,
} from '../lib/cpp.mjs';

export const help = `
${c.bold('ship meta')} ${c.dim('— App Store listing metadata')}

${c.dim('usage:')} ship meta [subcommand] [flags]

  ${c.cyan('lint')}       ${c.dim('default')} offline validation of every staged listing
  ${c.cyan('stage')}      expand staged/<locale>.json into the tree asc consumes
  ${c.cyan('pull')}       download live metadata from ASC and fold it back into staged/
  ${c.cyan('apply')}      lint → stage → state gate → dry-run → push to App Store Connect
  ${c.cyan('migrate')}    convert legacy .strings localizations into staged/<locale>.json
  ${c.cyan('keywords')}   inspect or rewrite the 100-char keyword field for one locale
  ${c.cyan('cpp')}        custom product pages: list · stage · apply · link

${c.bold('Flags')}
  ${c.cyan('--version V')}     marketing version (default: ship.config.json / app.json)
  ${c.cyan('--force')}         proceed despite lint failures, a bad app store state, or an existing file
  ${c.cyan('--no-stage')}      ${c.dim('apply, cpp apply')} push the tree as-is instead of regenerating it
  ${c.cyan('--from D')}        ${c.dim('migrate')} directory of version-level .strings files
  ${c.cyan('--app-info D')}    ${c.dim('migrate')} directory of app-info .strings files
  ${c.cyan('--set "a,b,c"')}   ${c.dim('keywords')} replace the keyword field for the locale
  ${c.cyan('--ad-group N')}    ${c.dim('cpp link')} ad group this page serves ${c.dim('(ship ads sync reads it)')}
  ${c.cyan('--screenshots')}   ${c.dim('cpp apply')} also upload each locale's screenshotDir
  ${c.cyan('--local')}         ${c.dim('cpp list')} skip the live App Store Connect lookup
  ${c.cyan('--json')}          machine-readable output ${c.dim('(lint, keywords, cpp)')}
  ${c.cyan('--dry-run')}       show what would change, write nothing

${c.dim('Source of truth: store/staged/<locale>.json — app-info/ and version/ are generated.')}
${c.dim('Custom product pages: store/cpp/<slug>/<locale>.json — generated/ is generated.')}
${c.dim('Keyword research lives in `ship aso`; this command only enforces the fields.')}
`;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
};

/** A bare `--flag` parses as `true`; only a real string is a usable value. */
const str = (v) => (typeof v === 'string' && v.length ? v : undefined);

/** ASC counts characters, not UTF-16 units — an emoji is one character to review. */
const chars = (v) => [...String(v ?? '')].length;

/**
 * App Store states where `asc metadata apply` is accepted. Anything else (in
 * review, pending developer release, processing for app store) rejects the
 * write server-side, usually after it has already half-applied a few locales.
 */
const APPLYABLE = new Set([
	'READY_FOR_SALE',
	'PREPARE_FOR_SUBMISSION',
	'DEVELOPER_REJECTED',
	'REJECTED',
]);

const LINT_COLUMNS = ['name', 'subtitle', 'keywords', 'description'];

async function listings(cfg) {
	const found = await readStaged(cfg);
	if (!found.length)
		throw new ShipError(`no staged listings in ${cfg.paths.staged}`, {
			hint: 'run `ship meta pull` to seed from App Store Connect, `ship meta migrate` to convert .strings, or `ship init`',
		});
	return found.map((l) => ({ ...l, problems: lintListing(l) }));
}

function printProblems(rows) {
	for (const row of rows) {
		if (!row.problems.length) continue;
		process.stdout.write(`\n  ${c.bold(row.locale)} ${c.dim(basename(row.file))}\n`);
		for (const p of row.problems) {
			const tag = p.level === 'fail' ? c.red('fail') : c.yellow('warn');
			process.stdout.write(`    ${tag} ${c.cyan(p.field)}  ${p.message}\n`);
		}
	}
}

async function lint({ flags }) {
	const cfg = await loadConfig();
	const rows = await listings(cfg);
	const failures = rows.flatMap((r) => r.problems.filter((p) => p.level === 'fail'));
	const warnings = rows.flatMap((r) => r.problems.filter((p) => p.level === 'warn'));

	if (flags.json) {
		emit({
			staged: cfg.paths.staged,
			locales: rows.map((r) => ({
				locale: r.locale,
				file: r.file,
				lengths: Object.fromEntries(LINT_COLUMNS.map((f) => [f, chars(r.data[f])])),
				limits: Object.fromEntries(LINT_COLUMNS.map((f) => [f, LIMITS[f]])),
				problems: r.problems,
			})),
			failures: failures.length,
			warnings: warnings.length,
		});
		return failures.length ? 1 : 0;
	}

	heading(`${cfg.name} — ${rows.length} locale${rows.length === 1 ? '' : 's'}`);
	const cell = (row, field) => `${chars(row.data[field])}/${LIMITS[field]}`;
	table(rows, [
		{ header: 'locale', get: (r) => r.locale },
		...LINT_COLUMNS.map((field) => ({ header: field, get: (r) => cell(r, field) })),
		// Colour lives in the last column only: table() pads on raw string length,
		// so an ANSI escape anywhere else knocks the grid out of alignment.
		{
			header: '',
			get: (r) =>
				r.problems.some((p) => p.level === 'fail')
					? c.red('fail')
					: r.problems.length
						? c.yellow('warn')
						: c.green('ok'),
		},
	]);
	printProblems(rows);

	process.stdout.write('\n');
	if (failures.length) {
		warn(`${failures.length} failure${failures.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
		return 1;
	}
	good(`no failures${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`);
	return 0;
}

/** Shared gate: lint must be clean before anything writes or uploads. */
async function gateOnLint(cfg, flags) {
	const rows = await listings(cfg);
	const failures = rows.flatMap((r) => r.problems.filter((p) => p.level === 'fail'));
	const warnings = rows.flatMap((r) => r.problems.filter((p) => p.level === 'warn'));
	if (failures.length) {
		printProblems(rows.filter((r) => r.problems.some((p) => p.level === 'fail')));
		if (!flags.force)
			throw new ShipError(`${failures.length} lint failure${failures.length === 1 ? '' : 's'} in staged listings`, {
				hint: 'fix them, or re-run with --force to push anyway',
			});
		warn(`--force: continuing past ${failures.length} lint failure${failures.length === 1 ? '' : 's'}`);
	} else {
		good(`lint clean${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`);
	}
	return rows;
}

async function stageCmd({ flags }) {
	const cfg = await loadConfig();
	const version = await resolveVersion(cfg, str(flags.version));
	heading(`${cfg.name} ${version} — stage`);
	await gateOnLint(cfg, flags);

	const dry = isDryRun();
	const { written, locales } = await expand(cfg, version, { write: !dry });
	if (dry) {
		info(`${c.yellow('dry-run')} would write ${written.length} files for ${locales.length} locales`);
		for (const f of written) note(f.replace(`${cfg.root}/`, ''));
		return 0;
	}
	good(`wrote ${written.length} files for ${locales.length} locales`);
	note(`${cfg.paths.appInfo.replace(`${cfg.root}/`, '')}/  +  ${cfg.versionDir(version).replace(`${cfg.root}/`, '')}/`);
	return 0;
}

/** Read a generated JSON file, tolerating the ones asc never created. */
async function readMaybe(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

async function localesIn(dir) {
	if (!existsSync(dir)) return [];
	return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'));
}

/** Authored key order — keeps diffs readable when a pull rewrites a file. */
function authoredOrder(locale, data) {
	const out = { locale };
	for (const field of ['name', 'subtitle', 'keywords', 'description', 'promotionalText', 'whatsNew', 'privacyPolicyUrl', 'privacyPolicyText', 'privacyChoicesUrl', 'supportUrl', 'marketingUrl']) {
		if (data[field] != null && String(data[field]).length) out[field] = data[field];
	}
	if (data.notes !== undefined) out.notes = data.notes;
	return out;
}

async function pull({ flags }) {
	const cfg = await loadConfig();
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, str(flags.version));
	heading(`${cfg.name} ${version} — pull`);

	step(`asc metadata pull --app ${appId} --version ${version}`);
	const pulled = await ascMutate(
		['metadata', 'pull', '--app', appId, '--version', version, '--dir', cfg.paths.store, '--platform', cfg.asc.platform, '--force'],
	);
	if (!pulled.ok)
		throw new ShipError(`asc metadata pull exited ${pulled.code}`, {
			hint: (pulled.stderr || 'check asc auth: asc auth status').split('\n').slice(-6).join('\n'),
		});

	// Reverse the expansion: asc writes the canonical two-tree layout, we fold it
	// back into one authored file per locale so the next edit has a single home.
	const versionDir = cfg.versionDir(version);
	const all = [...new Set([...(await localesIn(cfg.paths.appInfo)), ...(await localesIn(versionDir))])].sort();
	if (!all.length) {
		if (isDryRun()) {
			info(`${c.yellow('dry-run')} nothing pulled, so nothing to fold back into staged/`);
			return 0;
		}
		throw new ShipError(`asc pulled no localizations into ${cfg.paths.store}`, {
			hint: `check that version ${version} exists: asc versions list --app ${appId}`,
		});
	}

	const dry = isDryRun();
	if (!dry) await mkdir(cfg.paths.staged, { recursive: true });
	let created = 0;
	let updated = 0;
	for (const locale of all) {
		const appInfo = (await readMaybe(join(cfg.paths.appInfo, `${locale}.json`))) ?? {};
		const versionData = (await readMaybe(join(versionDir, `${locale}.json`))) ?? {};
		const target = join(cfg.paths.staged, `${locale}.json`);
		const existing = await readMaybe(target);
		// `notes` is research prose (why these keywords, what was rejected) that
		// only ever lived locally. ASC has never heard of it; a pull must not eat it.
		const merged = authoredOrder(locale, {
			...appInfo,
			...versionData,
			...(existing?.notes !== undefined ? { notes: existing.notes } : {}),
		});
		if (!dry) await writeFile(target, `${JSON.stringify(merged, null, '\t')}\n`);
		if (existing) updated++;
		else created++;
	}

	const prefix = dry ? `${c.yellow('dry-run')} would fold` : 'folded';
	good(`${prefix} ${all.length} locales into staged/ — ${created} created, ${updated} updated`);
	if (updated) note('review the diff before staging: pull overwrites authored copy with whatever is live');
	return 0;
}

/** asc payloads arrive as a bare array, or wrapped in one of a few envelopes. */
function rows(payload) {
	if (Array.isArray(payload)) return payload;
	for (const key of ['data', 'items', 'results', 'versions', 'builds']) {
		if (Array.isArray(payload?.[key])) return payload[key];
	}
	return payload && typeof payload === 'object' ? [payload] : [];
}

const stateOf = (v) => v?.appStoreState ?? v?.state ?? v?.attributes?.appStoreState ?? null;

/**
 * Shared version-state gate. `apply` and `cpp apply` write against the same
 * version record, so a state that rejects one rejects the other — and ASC
 * rejects server-side, usually after a few locales have already landed.
 */
async function requireApplyableState(cfg, appId, version, flags) {
	const live = rows(
		await asc(['versions', 'list', '--app', appId, '--version', version, '--platform', cfg.asc.platform], {
			fallback: [],
		}),
	);
	const state = stateOf(live[0]);
	if (!state) {
		if (!flags.force)
			throw new ShipError(`no ${cfg.asc.platform} version ${version} in App Store Connect`, {
				hint: `create it first (\`asc versions list --app ${appId}\` to see what exists), or pass --force`,
			});
		warn(`--force: could not read app store state for ${version}`);
		return null;
	}
	const ok = APPLYABLE.has(state);
	info(`app store state: ${ok ? c.green(state) : c.red(state)}`);
	if (!ok) {
		if (!flags.force)
			throw new ShipError(`version ${version} is ${state} — metadata is locked`, {
				hint: `apply is only accepted in ${[...APPLYABLE].join(', ')}; wait for review to finish or pass --force`,
			});
		warn(`--force: applying anyway against ${state}`);
	}
	return state;
}

/**
 * Count planned mutations without depending on asc's exact plan schema — it has
 * changed shape twice and a hard-coded path silently reports "0 changes" when it
 * moves again, which reads exactly like a no-op release.
 */
function planCounts(payload) {
	const out = { add: 0, update: 0, delete: 0 };
	const bucket = (k) =>
		/^(add|added|create|created|new)/i.test(k)
			? 'add'
			: /^(update|updated|change|changed|modif)/i.test(k)
				? 'update'
				: /^(delete|deleted|remove|removed)/i.test(k)
					? 'delete'
					: null;
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		if (typeof node.action === 'string') {
			const key = bucket(node.action);
			if (key) out[key]++;
		}
		for (const [k, v] of Object.entries(node)) {
			const key = bucket(k);
			if (key && typeof v === 'number') out[key] += v;
			else if (key && Array.isArray(v)) out[key] += v.length;
			else walk(v);
		}
	};
	walk(payload);
	return out;
}

/** Pull human-readable failures out of an apply payload, whatever it nests them in. */
function failureList(payload) {
	const found = [];
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		for (const [k, v] of Object.entries(node)) {
			if (/error|failure|failed/i.test(k) && v) {
				if (typeof v === 'string') found.push(v);
				else if (Array.isArray(v)) for (const e of v) found.push(typeof e === 'string' ? e : (e?.detail ?? e?.message ?? JSON.stringify(e)));
				else if (typeof v === 'object') found.push(v.detail ?? v.message ?? JSON.stringify(v));
			} else walk(v);
		}
	};
	walk(payload);
	return found.filter(Boolean);
}

async function apply({ flags }) {
	const cfg = await loadConfig();
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, str(flags.version));
	const dry = isDryRun();
	heading(`${cfg.name} ${version} — apply to App Store Connect`);

	await gateOnLint(cfg, flags);

	if (flags['no-stage']) {
		note('--no-stage: pushing store/app-info + store/version as they are on disk');
	} else {
		const { written, locales } = await expand(cfg, version, { write: !dry });
		good(`staged ${locales.length} locales (${written.length} files)${dry ? c.dim(' — dry-run, not written') : ''}`);
	}

	await requireApplyableState(cfg, appId, version, flags);

	const applyArgs = ['metadata', 'apply', '--app', appId, '--version', version, '--dir', cfg.paths.store, '--platform', cfg.asc.platform];

	step('dry-run apply');
	const plan = await asc([...applyArgs, '--dry-run']);
	const counts = planCounts(plan);
	info(`${c.green(`+${counts.add}`)} add  ${c.yellow(`~${counts.update}`)} update  ${c.red(`-${counts.delete}`)} delete`);
	if (!counts.add && !counts.update && !counts.delete) note('asc reported no changes — the live listing already matches store/');

	if (dry) {
		info(`${c.yellow('dry-run')} stopping before the real apply`);
		note(`next: ship meta apply --version ${version}`);
		return 0;
	}

	// Two passes, always. On a fresh version pass 1 creates the empty
	// localizations and then reports "entity with locale already exists" for the
	// same locales it just made; pass 2 is the one that actually fills the fields.
	// Pass 1 may legitimately exit non-zero on that noise, so it warns; pass 2 is
	// the record of truth and must exit clean — a swallowed failure here is how a
	// release reports success over metadata that never landed.
	step('apply pass 1/2');
	const pass1 = await ascMutate(applyArgs);
	if (!pass1.ok)
		warn(`apply pass 1 exited ${pass1.code} — pass 2 decides${pass1.stderr ? `:\n${pass1.stderr.split('\n').slice(-4).join('\n')}` : ''}`);
	step('apply pass 2/2');
	const res = await ascMutate(applyArgs);
	if (!res.ok)
		throw new ShipError(`metadata apply pass 2 exited ${res.code}`, {
			hint: (res.stderr || 'check asc auth: asc auth status').split('\n').slice(-6).join('\n'),
		});

	const reportDir = join(cfg.paths.reports, 'metadata-apply');
	await mkdir(reportDir, { recursive: true });
	// Colons are legal here but break the moment the repo is opened on exFAT or
	// a Windows checkout, and the report is the only record of a failed apply.
	const reportFile = join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`);
	await writeFile(reportFile, `${JSON.stringify(res.data ?? { note: 'asc returned no JSON' }, null, '\t')}\n`);
	note(reportFile.replace(`${cfg.root}/`, ''));

	const failures = failureList(res.data);
	if (failures.length) {
		for (const f of failures) process.stdout.write(`  ${c.red('fail')} ${f}\n`);
		throw new ShipError(`${failures.length} localization${failures.length === 1 ? '' : 's'} failed to apply`, {
			hint: `full payload: ${reportFile}`,
		});
	}

	good(`metadata applied to ${cfg.name} ${version}`);
	note(`then: asc metadata keywords audit --app ${appId} --version ${version}`);
	return 0;
}

/**
 * Legacy `.strings` keys, normalised: promotional_text, promotionalText and
 * PROMOTIONAL-TEXT all came out of different asc generations.
 */
const STRINGS_FIELDS = new Map(
	[...APP_INFO_FIELDS, ...VERSION_FIELDS].map((f) => [f.toLowerCase(), f]),
);
const fieldFor = (key) => STRINGS_FIELDS.get(key.toLowerCase().replace(/[^a-z]/g, '')) ?? null;

async function readStringsDir(dir, label) {
	if (!existsSync(dir)) throw new ShipError(`${label}: ${dir} does not exist`);
	const files = (await readdir(dir)).filter((f) => f.endsWith('.strings')).sort();
	if (!files.length) throw new ShipError(`${label}: no .strings files in ${dir}`);
	const out = new Map();
	for (const f of files) {
		const locale = basename(f, '.strings');
		const parsed = parseStrings(await readFile(join(dir, f), 'utf8'));
		const mapped = {};
		const unknown = [];
		for (const [key, value] of Object.entries(parsed)) {
			const field = fieldFor(key);
			if (field) mapped[field] = value;
			else unknown.push(key);
		}
		out.set(locale, { fields: mapped, unknown });
	}
	return out;
}

/**
 * `asc metadata` has always written .strings into `localizations/` and
 * `app-info-localizations/` at the repo root, so those are defaults rather than
 * flags an operator should have to rediscover.
 */
const DEFAULT_STRINGS_DIRS = { from: 'localizations', appInfo: 'app-info-localizations' };

async function migrate({ flags }) {
	const cfg = await loadConfig();
	const auto = (dir) => {
		const p = join(cfg.root, dir);
		return existsSync(p) ? p : null;
	};
	const from = str(flags.from) ?? auto(DEFAULT_STRINGS_DIRS.from);
	const appInfoDir = str(flags['app-info']) ?? auto(DEFAULT_STRINGS_DIRS.appInfo);
	if (!from && !appInfoDir)
		throw new ShipError('meta migrate: nothing to convert', {
			hint: `no ${DEFAULT_STRINGS_DIRS.from}/ or ${DEFAULT_STRINGS_DIRS.appInfo}/ under ${cfg.root} — pass --from <dir> and/or --app-info <dir>`,
		});

	heading(`${cfg.name} — migrate .strings → staged/`);
	const versionSrc = from ? await readStringsDir(from, '--from') : new Map();
	const appInfoSrc = appInfoDir ? await readStringsDir(appInfoDir, '--app-info') : new Map();
	const all = [...new Set([...versionSrc.keys(), ...appInfoSrc.keys()])].sort();

	const dry = isDryRun();
	if (!dry) await mkdir(cfg.paths.staged, { recursive: true });

	const done = [];
	const skipped = [];
	for (const locale of all) {
		const target = join(cfg.paths.staged, `${locale}.json`);
		const existing = await readMaybe(target);
		if (existing && !flags.force) {
			skipped.push(locale);
			continue;
		}
		const merged = authoredOrder(locale, {
			...appInfoSrc.get(locale)?.fields,
			...versionSrc.get(locale)?.fields,
			...(existing?.notes !== undefined ? { notes: existing.notes } : {}),
		});
		if (!dry) await writeFile(target, `${JSON.stringify(merged, null, '\t')}\n`);
		done.push({
			locale,
			fields: Object.keys(merged).filter((k) => k !== 'locale' && k !== 'notes').length,
			source: [appInfoSrc.has(locale) ? 'app-info' : null, versionSrc.has(locale) ? 'version' : null].filter(Boolean).join('+'),
			action: existing ? 'overwrote' : 'created',
		});
	}

	table(done, [
		{ header: 'locale', get: (r) => r.locale },
		{ header: 'fields', get: (r) => r.fields },
		{ header: 'from', get: (r) => r.source },
		{ header: 'action', get: (r) => (dry ? `would ${r.action.replace(/e?d$/, 'e')}` : r.action) },
	]);

	const unknownKeys = new Set();
	for (const src of [versionSrc, appInfoSrc]) for (const v of src.values()) for (const k of v.unknown) unknownKeys.add(k);
	if (unknownKeys.size) warn(`ignored unmapped .strings keys: ${[...unknownKeys].join(', ')}`);
	if (skipped.length) warn(`${skipped.length} locale${skipped.length === 1 ? '' : 's'} already staged, left alone: ${skipped.join(', ')} — re-run with --force to overwrite`);

	const verb = dry ? `${c.yellow('dry-run')} would convert` : 'converted';
	good(`${verb} ${done.length} locale${done.length === 1 ? '' : 's'} into ${cfg.paths.staged.replace(`${cfg.root}/`, '')}/`);
	if (!dry && done.length) note('next: ship meta lint');
	return 0;
}

/** The exact set lintListing warns against — keyword terms already indexed by name+subtitle. */
function indexedWords(data) {
	return new Set(
		`${data.name ?? ''} ${data.subtitle ?? ''}`
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 2),
	);
}

async function keywords({ args, flags }) {
	const cfg = await loadConfig();
	const wanted = args[0] ?? cfg.asc.primaryLocale;
	const found = await readStaged(cfg);
	const entry = found.find((l) => l.locale === wanted);
	if (!entry)
		throw new ShipError(`no staged listing for ${wanted}`, {
			hint: found.length ? `have: ${found.map((l) => l.locale).join(', ')}` : `nothing in ${cfg.paths.staged}`,
		});

	if (flags.set !== undefined) return setKeywords(cfg, entry, flags);

	const list = keywordList(entry.data.keywords);
	const indexed = indexedWords(entry.data);
	let running = 0;
	const rowsOut = list.map((term, i) => {
		// A term costs its own characters plus the comma that joins it to the previous one.
		const cost = chars(term) + (i === 0 ? 0 : 1);
		running += cost;
		return { term, cost, running, wasted: indexed.has(term.toLocaleLowerCase()) };
	});

	if (flags.json) {
		emit({ locale: entry.locale, file: entry.file, limit: LIMITS.keywords, used: running, terms: rowsOut });
		return running > LIMITS.keywords ? 1 : 0;
	}

	heading(`${cfg.name} — keywords ${entry.locale}`);
	table(rowsOut, [
		{ header: '#', get: (r) => rowsOut.indexOf(r) + 1 },
		{ header: 'term', get: (r) => r.term },
		{ header: 'cost', get: (r) => r.cost },
		{ header: 'total', get: (r) => `${r.running}/${LIMITS.keywords}` },
		{ header: '', get: (r) => (r.wasted ? c.yellow('already in name/subtitle') : '') },
	]);

	const wasted = rowsOut.filter((r) => r.wasted);
	const free = LIMITS.keywords - running;
	process.stdout.write('\n');
	if (running > LIMITS.keywords) {
		warn(`${running}/${LIMITS.keywords} — ${running - LIMITS.keywords} characters over the limit`);
	} else if (free > LIMITS.keywords * 0.2) {
		warn(`${running}/${LIMITS.keywords} — ${free} characters unused, that is free search coverage`);
	} else {
		good(`${running}/${LIMITS.keywords} characters used`);
	}
	if (wasted.length)
		warn(`${wasted.length} wasted slot${wasted.length === 1 ? '' : 's'}: ${wasted.map((r) => r.term).join(', ')} — ASC already indexes name and subtitle`);
	note(`rewrite: ship meta keywords ${entry.locale} --set "term,term,term"`);
	return running > LIMITS.keywords ? 1 : 0;
}

async function setKeywords(cfg, entry, flags) {
	const raw = str(flags.set);
	if (raw === undefined) throw new ShipError('meta keywords --set needs a comma-separated value');
	const next = normaliseKeywords(raw);
	const used = chars(next);
	if (used > LIMITS.keywords)
		throw new ShipError(`${used}/${LIMITS.keywords} characters — ${used - LIMITS.keywords} over the limit`, {
			hint: `drop a term: ${keywordList(next).slice(-3).join(', ')}`,
		});

	const before = entry.data.keywords ?? '';
	if (isDryRun()) {
		info(`${c.yellow('dry-run')} ${entry.file.replace(`${cfg.root}/`, '')}`);
		note(`- ${before}`);
		note(`+ ${next}`);
		return 0;
	}
	// Rewrite through the parsed object so `notes` and every other authored field survive.
	await writeFile(entry.file, `${JSON.stringify({ ...entry.data, keywords: next }, null, '\t')}\n`);
	good(`${entry.locale}: ${used}/${LIMITS.keywords} characters, ${keywordList(next).length} terms`);
	note(next);
	note('next: ship meta stage');
	return 0;
}

// ─── custom product pages ────────────────────────────────────────────────────

/**
 * A custom product page is the only way an ad group's landing screen can say
 * what its keyword says: name, subtitle, keywords and description are shared
 * across every page, so promotional text and screenshots are the entire lever.
 * One page per ad group, headline matching that keyword's intent.
 *
 * `ship ads sync` reads the `adGroup` recorded by `cpp link` and binds the page
 * to the ad group through an Apple Ads creative.
 */
const attr = (o, key) => o?.[key] ?? o?.attributes?.[key] ?? null;
const first = (payload) => rows(payload)[0] ?? null;
const idOf = (o) => {
	const id = o?.id ?? attr(o, 'id');
	return id == null ? null : String(id);
};

/** Directory names under a screenshotDir are display types, exactly as `ship shots` lays them out. */
async function deviceDirs(dir) {
	if (!existsSync(dir)) return [];
	return (await readdir(dir, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

function printCppProblems(entry, problems) {
	if (!problems.length) return;
	process.stdout.write(`\n  ${c.bold(entry.slug)}\n`);
	for (const p of problems) {
		const tag = p.level === 'fail' ? c.red('fail') : c.yellow('warn');
		process.stdout.write(`    ${tag} ${c.cyan(`${p.locale}/${p.field}`)}  ${p.message}\n`);
	}
}

async function pagesFor(cfg, slug) {
	if (slug) {
		const entry = await readPage(cfg, slugify(slug));
		if (!entry)
			throw new ShipError(`no custom product page "${slug}"`, {
				hint: `expected ${cppDir(cfg, slugify(slug))}/ — it holds cpp.json plus one <locale>.json per language`,
			});
		return [entry];
	}
	const all = await readPages(cfg);
	if (!all.length)
		throw new ShipError(`no custom product pages under ${cppRoot(cfg)}`, {
			hint: 'a page is store/cpp/<slug>/cpp.json + <locale>.json — one per ad group, headline matching that keyword',
		});
	return all;
}

async function cppList(cfg, flags) {
	const pages = await readPages(cfg);
	const local = pages.map((p) => ({
		slug: p.slug,
		name: p.page.name ?? p.slug,
		adGroup: p.page.adGroup ?? null,
		locales: p.locales.map((l) => l.locale),
		pageId: p.page.pageId ?? null,
		problems: lintPage(p),
	}));

	let live = null;
	if (!flags.local && cfg.asc?.appId) {
		const payload = await asc(
			['product-pages', 'custom-pages', 'list', '--app', String(cfg.asc.appId), '--paginate'],
			{ fallback: null, allowFail: true },
		);
		if (payload)
			live = rows(payload).map((r) => ({
				id: idOf(r),
				name: attr(r, 'name'),
				visible: attr(r, 'visible'),
			}));
	}

	if (flags.json) {
		emit({ dir: cppRoot(cfg), pages: local, live });
		return local.some((p) => p.problems.some((x) => x.level === 'fail')) ? 1 : 0;
	}

	heading(`Custom product pages (${local.length})`);
	if (!local.length) {
		note(`none in ${cppRoot(cfg)}`);
		note('create store/cpp/<slug>/cpp.json + <locale>.json, then `ship meta cpp link <slug> --ad-group "…"`');
	} else {
		table(local, [
			{ header: 'slug', get: (p) => p.slug },
			{ header: 'name', get: (p) => p.name },
			{ header: 'ad group', get: (p) => p.adGroup ?? c.dim('—') },
			{ header: 'locales', get: (p) => p.locales.join(',') || '—' },
			{ header: 'pageId', get: (p) => p.pageId ?? '—' },
		]);
		for (const p of pages) printCppProblems(p, lintPage(p));
	}

	if (live) {
		heading(`Live in App Store Connect (${live.length})`);
		table(live, [
			{ header: 'id', get: (p) => p.id ?? '' },
			{ header: 'name', get: (p) => p.name ?? '' },
			{ header: 'visible', get: (p) => String(p.visible ?? '') },
		]);
		const names = new Set(local.map((p) => p.name));
		const orphans = live.filter((p) => p.name && !names.has(p.name));
		if (orphans.length)
			warn(`${orphans.length} live page(s) with no local source: ${orphans.map((p) => p.name).join(', ')}`);
	} else if (!flags.local) {
		note('no asc.appId — skipped the live lookup');
	}
	return local.some((p) => p.problems.some((x) => x.level === 'fail')) ? 1 : 0;
}

async function cppStage(cfg, entries, flags) {
	const dry = isDryRun();
	const staged = [];
	for (const entry of entries) {
		const problems = lintPage(entry);
		printCppProblems(entry, problems);
		const failures = problems.filter((p) => p.level === 'fail');
		if (failures.length) {
			if (!flags.force)
				throw new ShipError(`${entry.slug}: ${failures.length} failure${failures.length === 1 ? '' : 's'}`, {
					hint: 'fix them, or re-run with --force',
				});
			warn(`--force: staging ${entry.slug} past ${failures.length} failure(s)`);
		}
		const res = await stagePage(cfg, entry, { write: !dry });
		staged.push({ slug: entry.slug, locales: res.locales, written: res.written, screenshots: res.screenshots });
	}

	if (flags.json) {
		emit({ dryRun: dry, staged });
		return 0;
	}
	for (const s of staged) {
		const label = `${s.slug} → ${s.written.length} file(s) for ${s.locales.length} locale(s)`;
		if (dry) info(`${c.yellow('dry-run')} would write ${label}`);
		else good(label);
	}
	note('generated/ is generated — never hand-edit it, `cpp stage` overwrites it');
	return 0;
}

/**
 * ASC nests the copy page → version → localization and every write needs the id
 * above it, so each run re-resolves the chain by name. Matching by name is what
 * makes a re-run idempotent: ASC will happily create a second page called
 * "Oil change" and then serve whichever one the ad happens to point at.
 */
async function cppApply(cfg, entries, flags) {
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, str(flags.version));
	const dry = isDryRun();
	heading(`${cfg.name} ${version} — custom product pages`);
	await requireApplyableState(cfg, appId, version, flags);

	const livePages = rows(
		await asc(['product-pages', 'custom-pages', 'list', '--app', appId, '--paginate'], { fallback: [] }),
	);
	const results = [];
	const screenshotFailures = [];

	for (const entry of entries) {
		const name = entry.page.name ?? entry.slug;
		step(`${entry.slug} · "${name}"`);
		if (!flags['no-stage']) await stagePage(cfg, entry, { write: !dry });

		let page = livePages.find((p) => attr(p, 'name') === name) ?? null;
		if (page) note(`page exists → ${idOf(page)}`);
		else {
			const created = await ascMutate(['product-pages', 'custom-pages', 'create', '--app', appId, '--name', name]);
			if (!created.ok && !dry)
				throw new ShipError(`custom product page create for "${name}" exited ${created.code}`, {
					hint: (created.stderr || 'check asc auth: asc auth status').split('\n').slice(-6).join('\n'),
				});
			page = first(created.data);
		}
		const pageId = idOf(page);
		if (!pageId) {
			if (dry) {
				note(`dry-run: ${entry.locales.length} localization(s) would follow page creation`);
				continue;
			}
			throw new ShipError(`custom product page create returned no id for "${name}"`);
		}

		// Versions are append-only and a submitted one is frozen. Prefer the
		// editable draft; fall back to the newest and let ASC reject rather than
		// silently writing into a page nobody is serving.
		const versions = rows(
			await asc(['product-pages', 'custom-pages', 'versions', 'list', '--custom-page-id', pageId, '--paginate'], {
				fallback: [],
			}),
		);
		let pageVersion =
			versions.find((v) => stateOf(v) === 'PREPARE_FOR_SUBMISSION') ?? versions[0] ?? null;
		if (!pageVersion) {
			const createdVersion = await ascMutate(
				['product-pages', 'custom-pages', 'versions', 'create', '--custom-page-id', pageId],
			);
			if (!createdVersion.ok && !dry)
				throw new ShipError(`custom page version create for "${name}" exited ${createdVersion.code}`, {
					hint: (createdVersion.stderr || 'check asc auth: asc auth status').split('\n').slice(-6).join('\n'),
				});
			pageVersion = first(createdVersion.data);
		}
		const versionId = idOf(pageVersion);
		if (!versionId) {
			if (dry) continue;
			throw new ShipError(`custom product page "${name}" has no writable version`);
		}
		if (stateOf(pageVersion) && stateOf(pageVersion) !== 'PREPARE_FOR_SUBMISSION')
			warn(`${entry.slug}: version ${versionId} is ${stateOf(pageVersion)} — ASC may reject the write`);

		const existing = rows(
			await asc(
				['product-pages', 'custom-pages', 'localizations', 'list', '--custom-page-version-id', versionId, '--paginate'],
				{ fallback: [] },
			),
		);

		const applied = [];
		for (const { locale } of entry.locales) {
			const payload = await readMaybe(join(generatedDir(entry.dir), `${locale}.json`));
			if (!payload) {
				warn(`${entry.slug}/${locale}: nothing staged — run \`ship meta cpp stage ${entry.slug}\``);
				continue;
			}
			const promo = payload.promotionalText ?? '';
			const live = existing.find((l) => attr(l, 'locale') === locale) ?? null;
			const localizationId = idOf(live);
			const written = await ascMutate(
				localizationId
					? ['product-pages', 'custom-pages', 'localizations', 'update', '--localization-id', localizationId, '--promotional-text', promo]
					: ['product-pages', 'custom-pages', 'localizations', 'create', '--custom-page-version-id', versionId, '--locale', locale, '--promotional-text', promo],
			);
			if (!written.ok && !dry)
				throw new ShipError(`${entry.slug}/${locale}: localization ${localizationId ? 'update' : 'create'} exited ${written.code}`, {
					hint: (written.stderr || 'check asc auth: asc auth status').split('\n').slice(-6).join('\n'),
				});
			applied.push({ locale, action: localizationId ? 'update' : 'create', localizationId });
			if (!flags.json) note(`${locale} ${localizationId ? 'updated' : 'created'} ${c.dim(`${chars(promo)}/${LIMITS.promotionalText}`)}`);

			// Opt-in: this endpoint has no --skip-existing, so a second run would
			// append the same captures again and a set over 10 is rejected at
			// submission. `ship shots` owns the main listing's sets for the same reason.
			const shots = entry.locales.find((l) => l.locale === locale)?.data?.screenshotDir;
			if (!shots) continue;
			if (!flags.screenshots) {
				note(`${locale}: screenshotDir set — pass --screenshots to upload it`);
				continue;
			}
			const dir = screenshotDir(cfg, shots);
			const types = await deviceDirs(dir);
			const explicit = str(flags['device-type']);
			if (!types.length && !explicit) {
				warn(`${locale}: ${dir} has no <DISPLAY_TYPE>/ subdirectories — pass --device-type`);
				continue;
			}
			for (const deviceType of types.length ? types : [explicit]) {
				const path = types.length ? join(dir, deviceType) : dir;
				const localizationTarget = localizationId ?? idOf(first(
					await asc(
						['product-pages', 'custom-pages', 'localizations', 'list', '--custom-page-version-id', versionId, '--paginate'],
						{ fallback: [] },
					),
				));
				if (!localizationTarget) break;
				step(`upload ${locale}/${deviceType}`);
				const upload = await ascMutate(
					['product-pages', 'custom-pages', 'localizations', 'screenshot-sets', 'upload', '--localization-id', localizationTarget, '--path', path, '--device-type', deviceType],
				);
				if (!upload.ok) {
					const msg = `${entry.slug}/${locale}/${deviceType}: screenshot upload exited ${upload.code}`;
					if (dry) warn(msg);
					else screenshotFailures.push(`${msg}\n${(upload.stderr || 'no stderr').split('\n').slice(-4).join('\n')}`);
				}
			}
		}

		results.push({ slug: entry.slug, name, pageId, versionId, locales: applied });
		if (!dry) await writeMeta(entry, { ...entry.page, name, pageId, versionId, appliedAt: new Date().toISOString() });
	}

	if (flags.json) {
		emit({ app: appId, version, dryRun: dry, pages: results });
		return 0;
	}
	process.stdout.write('\n');
	if (screenshotFailures.length) {
		for (const f of screenshotFailures) process.stdout.write(`  ${c.red('fail')} ${f}\n`);
		throw new ShipError(`${screenshotFailures.length} screenshot upload${screenshotFailures.length === 1 ? '' : 's'} failed`, {
			hint: 're-run `ship meta cpp apply --screenshots` — uploads are append-only, so check the sets in ASC first',
		});
	}
	good(`${dry ? 'dry-run: ' : ''}${results.length} page(s) applied`);
	const unlinked = entries.filter((e) => !e.page.adGroup);
	if (unlinked.length)
		warn(`${unlinked.map((e) => e.slug).join(', ')} serve no ad group — \`ship meta cpp link <slug> --ad-group "…"\``);
	else note('next: ship ads sync — it binds each page to its ad group');
	return 0;
}

async function cppLink(cfg, entry, flags) {
	const adGroup = str(flags['ad-group'] ?? flags.adGroup);
	if (!adGroup)
		throw new ShipError('meta cpp link: --ad-group is required', {
			hint: 'use the ad group name from aso/asa/campaign-plan.json, e.g. --ad-group "EX · oil change reminder"',
		});

	const clash = (await readPages(cfg)).find((p) => p.slug !== entry.slug && p.page.adGroup === adGroup);
	if (clash && !flags.force)
		throw new ShipError(`ad group "${adGroup}" is already served by ${clash.slug}`, {
			hint: 'one ad group, one page — that split is the only thing making the pages measurable. --force moves it.',
		});

	const page = {
		...entry.page,
		name: entry.page.name ?? entry.slug,
		adGroup,
		campaign: str(flags.campaign) ?? entry.page.campaign ?? null,
	};
	if (flags.json) {
		if (!isDryRun()) await writeMeta(entry, page);
		emit(page);
		return 0;
	}
	if (isDryRun()) {
		info(`${c.yellow('dry-run')} ${entry.metaFile.replace(`${cfg.root}/`, '')}`);
		note(`adGroup: ${adGroup}`);
		return 0;
	}
	await writeMeta(entry, page);
	good(`${entry.slug} serves ad group "${adGroup}"`);
	note('next: ship ads sync — it binds the page to that ad group through an Apple Ads creative');
	return 0;
}

const CPP_SUB = new Set(['list', 'stage', 'apply', 'link']);

async function cpp({ args, flags }) {
	const [sub = 'list', ...rest] = args;
	if (!CPP_SUB.has(sub))
		throw new ShipError(`meta cpp: unknown subcommand "${sub}"`, {
			hint: `try: ${[...CPP_SUB].join(', ')}`,
		});
	const cfg = await loadConfig();
	if (sub === 'list') return cppList(cfg, flags);

	const slug = rest[0] ? String(rest[0]) : (str(flags.slug) ?? null);
	if (sub === 'link') {
		if (!slug) throw new ShipError('meta cpp link: name the page', { hint: 'ship meta cpp link <slug> --ad-group "…"' });
		const [entry] = await pagesFor(cfg, slug);
		return cppLink(cfg, entry, flags);
	}
	const entries = await pagesFor(cfg, slug);
	return sub === 'stage' ? cppStage(cfg, entries, flags) : cppApply(cfg, entries, flags);
}

const SUB = { lint, stage: stageCmd, pull, apply, migrate, keywords, cpp };

export async function run({ args, flags }) {
	const [sub = 'lint', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`meta: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}
