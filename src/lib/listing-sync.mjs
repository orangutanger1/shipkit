// Listing lifecycle for `ship meta`: lint, pull, apply, migrate and keywords.
// `store/staged/<locale>.json` is the authored source; store/app-info/ and
// store/version/<v>/ are generated from it; the CPP writer is cpp-asc.mjs.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LIMITS, loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { asc, ascMutate, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { emit } from './output.mjs';
import { readJSONIfExists } from './jsonio.mjs';
import { rowsOf } from './asc-report.mjs';
import { strOf } from './util.mjs';
import { charCount } from './text.mjs';
import { APP_INFO_FIELDS, VERSION_FIELDS, keywordList, lintListing, normaliseKeywords, parseStrings, readStaged, stage as expand } from './locales.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').Flags} Flags */
/** @typedef {import('./util.mjs').SubCtx} SubCtx */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./locales.mjs').ListingData} ListingData */
/** @typedef {import('./locales.mjs').StagedListing} StagedListing */
/** @typedef {import('./locales.mjs').ListingProblem} ListingProblem */

/** A staged listing plus its lint result: the row every meta subcommand handles. */
/** @typedef {StagedListing & {problems: ListingProblem[]}} LintRow */
/** One .strings file's parse: the mapped ASC fields and the keys nothing maps to. */
/** @typedef {{fields: Record<string, string>, unknown: string[]}} StringsFile */

/** The tail of an asc stderr is the actionable part; shared with the CPP writer in cpp-asc.mjs. */
/**
 * @param {string|undefined} stderr
 * @param {{lines?: number, fallback?: string}} [opts]
 * @returns {string}
 */
export function stderrTail(stderr, { lines = 6, fallback = 'check asc auth: asc auth status' } = {}) {
	return (stderr || fallback).split('\n').slice(-lines).join('\n');
}

/** App Store states where `asc metadata apply` is accepted; the rest reject the write server-side. */
const APPLYABLE = new Set(['READY_FOR_SALE', 'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED']);

/** @type {('name'|'subtitle'|'keywords'|'description')[]} */
const LINT_COLUMNS = ['name', 'subtitle', 'keywords', 'description'];

/**
 * @param {Config} cfg
 * @returns {Promise<LintRow[]>}
 */
async function listings(cfg) {
	const found = await readStaged(cfg);
	if (!found.length)
		throw new ShipError(`no staged listings in ${cfg.paths.staged}`, { hint: 'run `ship meta pull` to seed from App Store Connect, `ship meta migrate` to convert .strings, or `ship init`' });
	return found.map((l) => ({ ...l, problems: lintListing(l) }));
}

/**
 * @param {LintRow[]} rows
 * @returns {void}
 */
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

/**
 * The non-optional loadConfig throws before it can return null; this narrows
 * the type so callers do not repeat the check.
 *
 * @returns {Promise<Config>}
 */
async function requireConfig() {
	const cfg = await loadConfig();
	if (!cfg) throw new ShipError('no ship.config.json found', { hint: 'run `ship init` inside the app repo to create one' });
	return cfg;
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function lint({ flags }) {
	const cfg = await requireConfig();
	const rows = await listings(cfg);
	const failures = rows.flatMap((r) => r.problems.filter((p) => p.level === 'fail'));
	const warnings = rows.flatMap((r) => r.problems.filter((p) => p.level === 'warn'));

	if (flags.json) {
		/** @param {LintRow} r @returns {Record<string, number>} */
		const lengths = (r) => Object.fromEntries(LINT_COLUMNS.map((f) => [f, charCount(r.data[f])]));
		emit({
			staged: cfg.paths.staged,
			locales: rows.map((r) => ({
				locale: r.locale,
				file: r.file,
				lengths: lengths(r),
				limits: Object.fromEntries(LINT_COLUMNS.map((f) => [f, LIMITS[f]])),
				problems: r.problems,
			})),
			failures: failures.length,
			warnings: warnings.length,
		});
		return failures.length ? 1 : 0;
	}

	heading(`${cfg.name} — ${rows.length} locale${rows.length === 1 ? '' : 's'}`);
	/**
	 * @param {LintRow} row
	 * @param {'name'|'subtitle'|'keywords'|'description'} field
	 * @returns {string}
	 */
	const cell = (row, field) => `${charCount(row.data[field])}/${LIMITS[field]}`;
	// Colour lives in the last column only: table() pads on raw string length, so an ANSI escape elsewhere knocks the grid out of alignment.
	table(rows, [
		{ header: 'locale', get: (r) => r.locale },
		...LINT_COLUMNS.map((field) => ({ header: field, get: (r) => cell(r, field) })),
		{ header: '', get: (r) => (r.problems.some((p) => p.level === 'fail') ? c.red('fail') : r.problems.length ? c.yellow('warn') : c.green('ok')) },
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
/**
 * @param {Config} cfg
 * @param {Flags} flags
 * @returns {Promise<LintRow[]>}
 */
export async function gateOnLint(cfg, flags) {
	const rows = await listings(cfg);
	const failures = rows.flatMap((r) => r.problems.filter((p) => p.level === 'fail'));
	const warnings = rows.flatMap((r) => r.problems.filter((p) => p.level === 'warn'));
	if (failures.length) {
		printProblems(rows.filter((r) => r.problems.some((p) => p.level === 'fail')));
		if (!flags.force)
			throw new ShipError(`${failures.length} lint failure${failures.length === 1 ? '' : 's'} in staged listings`, { hint: 'fix them, or re-run with --force to push anyway' });
		warn(`--force: continuing past ${failures.length} lint failure${failures.length === 1 ? '' : 's'}`);
	} else {
		good(`lint clean${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`);
	}
	return rows;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function localesIn(dir) {
	if (!existsSync(dir)) return [];
	return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'));
}

/** Authored key order — keeps diffs readable when a pull rewrites a file. */
/**
 * @param {string} locale
 * @param {JsonObject} data
 * @returns {JsonObject}
 */
function authoredOrder(locale, data) {
	/** @type {JsonObject} */
	const out = { locale };
	for (const field of ['name', 'subtitle', 'keywords', 'description', 'promotionalText', 'whatsNew', 'privacyPolicyUrl', 'privacyPolicyText', 'privacyChoicesUrl', 'supportUrl', 'marketingUrl']) {
		if (data[field] != null && String(data[field]).length) out[field] = data[field];
	}
	if (data.notes !== undefined) out.notes = data.notes;
	return out;
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function pull({ flags }) {
	const cfg = await requireConfig();
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, strOf(flags.version));
	heading(`${cfg.name} ${version} — pull`);

	step(`asc metadata pull --app ${appId} --version ${version}`);
	const pulled = await ascMutate(['metadata', 'pull', '--app', appId, '--version', version, '--dir', cfg.paths.store, '--platform', cfg.asc.platform, '--force']);
	if (!pulled.ok)
		throw new ShipError(`asc metadata pull exited ${pulled.code}`, { hint: stderrTail(pulled.stderr) });

	// Reverse the expansion: asc writes the canonical two-tree layout, we fold it
	// back into one authored file per locale so the next edit has a single home.
	const versionDir = cfg.versionDir(version);
	const all = [...new Set([...(await localesIn(cfg.paths.appInfo)), ...(await localesIn(versionDir))])].sort();
	if (!all.length) {
		if (isDryRun()) {
			info(`${c.yellow('dry-run')} nothing pulled, so nothing to fold back into staged/`);
			return 0;
		}
		throw new ShipError(`asc pulled no localizations into ${cfg.paths.store}`, { hint: `check that version ${version} exists: asc versions list --app ${appId}` });
	}

	const dry = isDryRun();
	if (!dry) await mkdir(cfg.paths.staged, { recursive: true });
	let created = 0;
	let updated = 0;
	for (const locale of all) {
		const appInfo = (await readJSONIfExists(join(cfg.paths.appInfo, `${locale}.json`))) ?? {};
		const versionData = (await readJSONIfExists(join(versionDir, `${locale}.json`))) ?? {};
		const target = join(cfg.paths.staged, `${locale}.json`);
		const existing = await readJSONIfExists(target);
		// `notes` is research prose (why these keywords, what was rejected) that only
		// ever lived locally. ASC has never heard of it; a pull must not eat it.
		const merged = authoredOrder(locale, {
			...appInfo,
			...versionData,
			...(existing && !Array.isArray(existing) && existing.notes !== undefined ? { notes: existing.notes } : {}),
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

/** ASC payloads arrive as a bare array, or wrapped in one of a few envelopes. */
/**
 * @param {Json|undefined} v
 * @returns {string|null}
 */
export const stateOf = (v) => {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
	const attr =
		typeof v.attributes === 'object' && v.attributes !== null && !Array.isArray(v.attributes)
			? v.attributes.appStoreState
			: null;
	const raw = v.appStoreState ?? v.state ?? attr;
	return raw === null || raw === undefined ? null : String(raw);
};

/**
 * Shared version-state gate. `apply` and `cpp apply` write against the same
 * version record, so a state that rejects one rejects the other — and ASC
 * rejects server-side, usually after a few locales have already landed.
 *
 * @param {Config} cfg
 * @param {string} appId
 * @param {string} version
 * @param {Flags} flags
 * @returns {Promise<string|null>}
 */
export async function requireApplyableState(cfg, appId, version, flags) {
	const live = rowsOf(await asc(['versions', 'list', '--app', appId, '--version', version, '--platform', cfg.asc.platform], { fallback: [] }));
	const state = stateOf(live[0]);
	if (!state) {
		if (!flags.force)
			throw new ShipError(`no ${cfg.asc.platform} version ${version} in App Store Connect`, { hint: `create it first (\`asc versions list --app ${appId}\` to see what exists), or pass --force` });
		warn(`--force: could not read app store state for ${version}`);
		return null;
	}
	const ok = APPLYABLE.has(state);
	info(`app store state: ${ok ? c.green(state) : c.red(state)}`);
	if (!ok) {
		if (!flags.force)
			throw new ShipError(`version ${version} is ${state} — metadata is locked`, { hint: `apply is only accepted in ${[...APPLYABLE].join(', ')}; wait for review to finish or pass --force` });
		warn(`--force: applying anyway against ${state}`);
	}
	return state;
}

/**
 * Count planned mutations without depending on asc's exact plan schema — it has
 * changed shape twice and a hard-coded path silently reports "0 changes" when
 * it moves again, which reads exactly like a no-op release.
 *
 * @param {Json|undefined} payload
 * @returns {{add: number, update: number, delete: number}}
 */
function planCounts(payload) {
	const out = { add: 0, update: 0, delete: 0 };
	/** @param {string} k @returns {'add'|'update'|'delete'|null} */
	const bucket = (k) => (/^(add|added|create|created|new)/i.test(k) ? 'add' : /^(update|updated|change|changed|modif)/i.test(k) ? 'update' : /^(delete|deleted|remove|removed)/i.test(k) ? 'delete' : null);
	/** @param {Json|undefined} node @returns {void} */
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
/**
 * @param {Json|undefined} payload
 * @returns {Json[]}
 */
function failureList(payload) {
	/** @type {Json[]} */
	const found = [];
	/** @param {Json|undefined} node @returns {void} */
	const walk = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		for (const [k, v] of Object.entries(node)) {
			if (/error|failure|failed/i.test(k) && v) {
				if (typeof v === 'string') found.push(v);
				else if (Array.isArray(v)) for (const e of v) found.push(typeof e === 'string' ? e : (typeof e === 'object' && e !== null && !Array.isArray(e) ? e.detail ?? e.message : JSON.stringify(e)));
				else if (typeof v === 'object') found.push(v.detail ?? v.message ?? JSON.stringify(v));
			} else walk(v);
		}
	};
	walk(payload);
	return found.filter(Boolean);
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function apply({ flags }) {
	const cfg = await requireConfig();
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, strOf(flags.version));
	const dry = isDryRun();
	heading(`${cfg.name} ${version} — apply to App Store Connect`);

	await gateOnLint(cfg, flags);

	if (flags['no-stage']) note('--no-stage: pushing store/app-info + store/version as they are on disk');
	else {
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

	// Two passes, always. On a fresh version pass 1 creates the empty localizations
	// and then reports "entity with locale already exists" for the same locales it
	// just made; pass 2 is the one that actually fills the fields. Pass 1 may
	// legitimately exit non-zero on that noise, so it warns; pass 2 must exit clean
	// — a swallowed failure here is how a release reports success over metadata
	// that never landed.
	step('apply pass 1/2');
	const pass1 = await ascMutate(applyArgs);
	if (!pass1.ok)
		warn(`apply pass 1 exited ${pass1.code} — pass 2 decides${pass1.stderr ? `:\n${stderrTail(pass1.stderr, { lines: 4 })}` : ''}`);
	step('apply pass 2/2');
	const res = await ascMutate(applyArgs);
	if (!res.ok)
		throw new ShipError(`metadata apply pass 2 exited ${res.code}`, { hint: stderrTail(res.stderr) });

	const reportDir = join(cfg.paths.reports, 'metadata-apply');
	await mkdir(reportDir, { recursive: true });
	// Colons are legal here but break on exFAT or a Windows checkout, and the report
	// is the only record of a failed apply.
	const reportFile = join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`);
	await writeFile(reportFile, `${JSON.stringify(res.data ?? { note: 'asc returned no JSON' }, null, '\t')}\n`);
	note(reportFile.replace(`${cfg.root}/`, ''));

	const failures = failureList(res.data);
	if (failures.length) {
		for (const f of failures) process.stdout.write(`  ${c.red('fail')} ${f}\n`);
		throw new ShipError(`${failures.length} localization${failures.length === 1 ? '' : 's'} failed to apply`, { hint: `full payload: ${reportFile}` });
	}

	good(`metadata applied to ${cfg.name} ${version}`);
	note(`then: asc metadata keywords audit --app ${appId} --version ${version}`);
	return 0;
}

/**
 * Legacy `.strings` keys, normalised: promotional_text, promotionalText and
 * PROMOTIONAL-TEXT all came out of different asc generations.
 */
const STRINGS_FIELDS = new Map([...APP_INFO_FIELDS, ...VERSION_FIELDS].map((f) => [f.toLowerCase(), f]));
/** @param {string} key @returns {string|null} */
const fieldFor = (key) => STRINGS_FIELDS.get(key.toLowerCase().replace(/[^a-z]/g, '')) ?? null;

/**
 * @param {string} dir
 * @param {string} label
 * @returns {Promise<Map<string, StringsFile>>}
 */
async function readStringsDir(dir, label) {
	if (!existsSync(dir)) throw new ShipError(`${label}: ${dir} does not exist`);
	const files = (await readdir(dir)).filter((f) => f.endsWith('.strings')).sort();
	if (!files.length) throw new ShipError(`${label}: no .strings files in ${dir}`);
	/** @type {Map<string, StringsFile>} */
	const out = new Map();
	for (const f of files) {
		const locale = basename(f, '.strings');
		/** @type {Record<string, string>} */
		const mapped = {};
		const unknown = [];
		for (const [key, value] of Object.entries(parseStrings(await readFile(join(dir, f), 'utf8')))) {
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
 * `app-info-localizations/` at the repo root — defaults, not flags to rediscover.
 */
const DEFAULT_STRINGS_DIRS = { from: 'localizations', appInfo: 'app-info-localizations' };

/** Where `--from`/`--app-info` point: flags win, else those defaults under the repo root. */
/**
 * @param {Config} cfg
 * @param {Flags} flags
 * @returns {Promise<{from: string|null, appInfoDir: string|null}>}
 */
async function migrateSourceDirs(cfg, flags) {
	/** @param {string} dir @returns {string|null} */
	const auto = (dir) => {
		const p = join(cfg.root, dir);
		return existsSync(p) ? p : null;
	};
	const from = strOf(flags.from) ?? auto(DEFAULT_STRINGS_DIRS.from);
	const appInfoDir = strOf(flags['app-info']) ?? auto(DEFAULT_STRINGS_DIRS.appInfo);
	if (!from && !appInfoDir)
		throw new ShipError('meta migrate: nothing to convert', { hint: `no ${DEFAULT_STRINGS_DIRS.from}/ or ${DEFAULT_STRINGS_DIRS.appInfo}/ under ${cfg.root} — pass --from <dir> and/or --app-info <dir>` });
	return { from, appInfoDir };
}

/** Merge one locale's .strings fields (plus any authored notes) into staged/<locale>.json. */
/**
 * @param {Config} cfg
 * @param {{versionSrc: Map<string, StringsFile>, appInfoSrc: Map<string, StringsFile>, dry: boolean, force: string|boolean|undefined}} srcs
 * @param {string} locale
 * @param {string[]} skipped
 * @returns {Promise<{locale: string, fields: number, source: string, action: string}|null>}
 */
async function convertLocale(cfg, { versionSrc, appInfoSrc, dry, force }, locale, skipped) {
	const target = join(cfg.paths.staged, `${locale}.json`);
	const existing = await readJSONIfExists(target);
	if (existing && !force) {
		skipped.push(locale);
		return null;
	}
	const merged = authoredOrder(locale, {
		...appInfoSrc.get(locale)?.fields,
		...versionSrc.get(locale)?.fields,
		...(existing && !Array.isArray(existing) && existing.notes !== undefined ? { notes: existing.notes } : {}),
	});
	if (!dry) await writeFile(target, `${JSON.stringify(merged, null, '\t')}\n`);
	return {
		locale,
		fields: Object.keys(merged).filter((k) => k !== 'locale' && k !== 'notes').length,
		source: [appInfoSrc.has(locale) ? 'app-info' : null, versionSrc.has(locale) ? 'version' : null].filter(Boolean).join('+'),
		action: existing ? 'overwrote' : 'created',
	};
}

/** The human-facing end of migrate: the done table, then warnings and next steps. */
/**
 * @param {Config} cfg
 * @param {{versionSrc: Map<string, StringsFile>, appInfoSrc: Map<string, StringsFile>}} srcs
 * @param {{locale: string, fields: number, source: string, action: string}[]} done
 * @param {string[]} skipped
 * @param {boolean} dry
 * @returns {void}
 */
function reportMigrate(cfg, { versionSrc, appInfoSrc }, done, skipped, dry) {
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
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function migrate({ flags }) {
	const cfg = await requireConfig();
	const { from, appInfoDir } = await migrateSourceDirs(cfg, flags);

	heading(`${cfg.name} — migrate .strings → staged/`);
	const versionSrc = from ? await readStringsDir(from, '--from') : new Map();
	const appInfoSrc = appInfoDir ? await readStringsDir(appInfoDir, '--app-info') : new Map();
	const all = [...new Set([...versionSrc.keys(), ...appInfoSrc.keys()])].sort();

	const dry = isDryRun();
	if (!dry) await mkdir(cfg.paths.staged, { recursive: true });

	const done = [];
	const skipped = [];
	for (const locale of all) {
		const row = await convertLocale(cfg, { versionSrc, appInfoSrc, dry, force: flags.force }, locale, skipped);
		if (row) done.push(row);
	}

	reportMigrate(cfg, { versionSrc, appInfoSrc }, done, skipped, dry);
	return 0;
}

/** The exact set lintListing warns against — keyword terms already indexed by name+subtitle. */
/**
 * @param {ListingData} data
 * @returns {Set<string>}
 */
function indexedWords(data) {
	const words = `${data.name ?? ''} ${data.subtitle ?? ''}`.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
	return new Set(words.filter((w) => w.length > 2));
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function keywords({ args, flags }) {
	const cfg = await requireConfig();
	const wanted = args[0] ?? cfg.asc.primaryLocale;
	const found = await readStaged(cfg);
	const entry = found.find((l) => l.locale === wanted);
	if (!entry)
		throw new ShipError(`no staged listing for ${wanted}`, { hint: found.length ? `have: ${found.map((l) => l.locale).join(', ')}` : `nothing in ${cfg.paths.staged}` });

	if (flags.set !== undefined) return setKeywords(cfg, entry, flags);

	const list = keywordList(entry.data.keywords);
	const indexed = indexedWords(entry.data);
	let running = 0;
	// A term costs its own characters plus the comma that joins it to the previous one.
	const rowsOut = list.map((term, i) => {
		const cost = charCount(term) + (i === 0 ? 0 : 1);
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

/**
 * @param {Config} cfg
 * @param {StagedListing} entry
 * @param {Flags} flags
 * @returns {Promise<number>}
 */
async function setKeywords(cfg, entry, flags) {
	const raw = strOf(flags.set);
	if (raw === undefined) throw new ShipError('meta keywords --set needs a comma-separated value');
	const next = normaliseKeywords(raw);
	const used = charCount(next);
	if (used > LIMITS.keywords)
		throw new ShipError(`${used}/${LIMITS.keywords} characters — ${used - LIMITS.keywords} over the limit`, { hint: `drop a term: ${keywordList(next).slice(-3).join(', ')}` });

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
