// ship init — adopt an app repo that already exists.
//
// Every value this command writes is one someone previously kept in their head
// and got wrong at 2am: the ASC app id that lives in eas.json and nowhere else,
// the entitlement string the paywall reads, the locale set that has to match
// what is already on App Store Connect. Detection is best-effort and always
// printed with its source, because a silently guessed bundle id ships a build
// to the wrong app record.
//
// Re-running is the normal case, not the exception: repos grow a staged
// listing, an ASC record, a RevenueCat entitlement weeks apart. So the merge
// rule is "fill holes, never overwrite" — a human-set value outranks anything
// we can infer, and only --force disagrees.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import { CONFIG_NAME, SHIPKIT_ROOT, normalise, saveConfig } from '../config.mjs';
import { asc, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, warn } from '../log.mjs';
import { parseStrings } from '../lib/locales.mjs';

export const help = `
${c.bold('ship init')} ${c.dim('— adopt an existing app repo')}

${c.dim('usage:')} ship init [--dir <repo>] [flags]

Detects the app's identity from app.json / app.config.* / eas.json / App Store
Connect, then writes ${c.cyan(CONFIG_NAME)}, MCP config, npm scripts and the
directories the rest of ${c.bold('ship')} expects. Safe to re-run: existing values are
kept, only holes are filled.

${c.bold('Flags')}
  ${c.cyan('--dir <path>')}  repo root to adopt ${c.dim('(default: cwd)')}
  ${c.cyan('--force')}       overwrite human-set config values and npm scripts
  ${c.cyan('--no-mcp')}      skip .omp/mcp.json and .mcp.json
  ${c.cyan('--dry-run')}     print every intended write, change nothing

${c.dim('Detected: name · version · bundleId · appDir · eas.projectId/owner/channel')}
${c.dim('          asc.appId · store.locales · legal urls · revenuecat.entitlement/keyEnv')}
`;

/** Directories that are either generated, vendored, or another repo entirely. */
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.expo',
	'.expo-shared',
	'.next',
	'.worktrees',
	'.asc',
	'.omp',
	'ios',
	'android',
	'Pods',
	'dist',
	'build',
	'coverage',
	'vendor',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Bound the scan: a monorepo will happily hand us 40k files. */
const MAX_SOURCE_FILES = 3000;
const MAX_SOURCE_BYTES = 256 * 1024;

const NPM_SCRIPTS = {
	ship: 'ship',
	'ship:doctor': 'ship doctor',
	'ship:status': 'ship status',
	'ship:preflight': 'ship preflight',
	'ship:meta': 'ship meta',
	'ship:aso': 'ship aso',
	'ship:build': 'ship build',
	'ship:submit': 'ship submit',
	'ship:ota': 'ship ota',
	'ship:release': 'ship release',
};

const GITIGNORE_LINES = ['.asc/reports/', 'aso/**/candidates.json'];

async function readJSON(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

async function readText(file) {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
}

async function listDir(dir) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Recursive file walk, depth- and skip-list-bounded. */
async function* walk(dir, depth = 0) {
	if (depth > 6) return;
	for (const ent of await listDir(dir)) {
		if (SKIP_DIRS.has(ent.name)) continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) yield* walk(p, depth + 1);
		else if (ent.isFile()) yield p;
	}
}

// ---------------------------------------------------------------- detection

/**
 * Locate the Expo app directory: the one holding app.json, at the repo root or
 * exactly one level below it. One level is deliberate — /home/myen/tour keeps
 * its app in `mobile/` alongside `supabase/`, and deeper searches start finding
 * example apps inside node_modules clones.
 */
async function findAppDir(root) {
	if (existsSync(join(root, 'app.json'))) return '.';
	const candidates = [];
	for (const ent of await listDir(root)) {
		if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
		if (existsSync(join(root, ent.name, 'app.json'))) candidates.push(ent.name);
	}
	candidates.sort();
	if (!candidates.length)
		throw new ShipError(`no app.json under ${root} or its immediate subdirectories`, {
			hint: 'point at the repo root with --dir, or run `ship new` to scaffold a fresh app',
		});
	// Several app.json files (a docs site, an example) — the real app depends on expo.
	for (const name of candidates) {
		const pkg = await readJSON(join(root, name, 'package.json'));
		const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
		if (deps.expo) return name;
	}
	return candidates[0];
}

/** app.config.js/ts/mjs, which overrides app.json at evaluation time. */
async function findDynamicConfig(appPath) {
	for (const name of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']) {
		const p = join(appPath, name);
		if (existsSync(p)) return { file: p, name, text: (await readText(p)) ?? '' };
	}
	return null;
}

/**
 * Pull a plain string literal out of a dynamic config without executing it.
 * Executing app.config.ts needs a TS loader and the app's whole env; reading it
 * costs nothing and is correct for the only shape that matters — a hardcoded
 * identifier. Two different literals means a variant-switching config
 * (idea6 suffixes `.dev`), so we refuse to guess and let app.json win.
 */
function literalFromConfig(text, key) {
	const re = new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`$\\n]+)['"\`]`, 'g');
	const found = new Set();
	for (const m of text.matchAll(re)) found.add(m[1]);
	return found.size === 1 ? [...found][0] : null;
}

/** Every scannable source file under the app dir, plus its committed env samples. */
async function sourceFiles(appPath) {
	const out = [];
	for await (const file of walk(appPath)) {
		const base = basename(file);
		if (base.startsWith('.env')) out.push(file);
		else if (SOURCE_EXT.has(extname(file))) out.push(file);
		if (out.length >= MAX_SOURCE_FILES) break;
	}
	return out;
}

const ENTITLEMENT_PATTERNS = [
	/entitlements\s*(?:\?\.)?\s*\.\s*active\s*\[\s*['"`]([\w][\w.\- ]*)['"`]\s*\]/g,
	/entitlements\s*(?:\?\.)?\s*\.\s*active\s*\.\s*([A-Za-z_$][\w$]*)/g,
	/ENTITLEMENT(?:_ID|_KEY)?\s*[:=]\s*['"`]([\w][\w.\- ]*)['"`]/g,
	/\bentitlement(?:Id|Identifier)?\s*:\s*['"`]([\w][\w.\- ]*)['"`]/g,
];

const KEY_ENV_RE = /\bEXPO_PUBLIC_(?:[A-Z0-9_]*RC[A-Z0-9_]*KEY|REVENUECAT[A-Z0-9_]*)\b/g;

/**
 * Entitlement + key env var, read out of the app's own source. Ambiguity stays
 * null: a wrong entitlement id renders an empty paywall to a paying customer,
 * which is strictly worse than an unset field `ship rc audit` will flag.
 */
async function scanSources(files) {
	const entitlements = new Map();
	const keyEnvs = new Map();
	for (const file of files) {
		const text = await readText(file);
		if (text == null || text.length > MAX_SOURCE_BYTES) continue;

		for (const m of text.matchAll(KEY_ENV_RE))
			keyEnvs.set(m[0], (keyEnvs.get(m[0]) ?? 0) + 1);

		// Only trust an entitlement literal in a file that actually talks to RevenueCat.
		if (!/react-native-purchases|\bPurchases\b|CustomerInfo/.test(text)) continue;
		for (const re of ENTITLEMENT_PATTERNS)
			for (const m of text.matchAll(re)) {
				const v = m[1];
				if (!v || v === 'active' || v === 'entitlements' || v.length > 64) continue;
				entitlements.set(v, (entitlements.get(v) ?? 0) + 1);
			}
	}
	const pick = (map) => {
		if (map.size === 0) return { value: null, ambiguous: false };
		if (map.size === 1) return { value: [...map.keys()][0], ambiguous: false };
		return { value: null, ambiguous: true, all: [...map.keys()] };
	};
	// A repo may legitimately reference an iOS *and* an Android key; prefer the
	// iOS one rather than calling it ambiguous, since ship is iOS-only.
	const ios = [...keyEnvs.keys()].filter((k) => k.includes('IOS'));
	const keyEnv =
		ios.length === 1 ? { value: ios[0], ambiguous: false } : pick(keyEnvs);
	return { entitlement: pick(entitlements), keyEnv };
}

/** Locale basenames from a directory of `<locale>.json` / `<locale>.strings`. */
async function localesIn(dir, ext = '.json') {
	return (await listDir(dir))
		.filter((e) => e.isFile() && extname(e.name) === ext)
		.map((e) => basename(e.name, ext))
		.sort();
}

const URL_KEYS = [
	['privacyUrl', 'privacyPolicyUrl'],
	['supportUrl', 'supportUrl'],
	['marketingUrl', 'marketingUrl'],
];

/**
 * Legal URLs, from whatever listing form this repo already has. Prefer the
 * primary locale; these URLs are shared across locales in practice and ASC
 * rejects a version that is missing them.
 */
async function detectLegal(root, storeDir, primaryLocale) {
	const sources = [];
	const jsonDirs = [join(storeDir, 'app-info')];
	const versionRoot = join(storeDir, 'version');
	for (const ent of await listDir(versionRoot)) if (ent.isDirectory()) jsonDirs.push(join(versionRoot, ent.name));
	for (const dir of jsonDirs) {
		for (const locale of await localesIn(dir, '.json')) {
			const data = await readJSON(join(dir, `${locale}.json`));
			if (data) sources.push({ locale, data, from: `${relative(root, join(dir, `${locale}.json`))}` });
		}
	}
	for (const name of ['app-info-localizations', 'localizations']) {
		const dir = join(root, name);
		for (const locale of await localesIn(dir, '.strings')) {
			const text = await readText(join(dir, `${locale}.strings`));
			if (text) sources.push({ locale, data: parseStrings(text), from: `${name}/${locale}.strings` });
		}
	}
	sources.sort((a, b) => (a.locale === primaryLocale ? -1 : b.locale === primaryLocale ? 1 : 0));

	const legal = { privacyUrl: null, supportUrl: null, marketingUrl: null };
	const from = {};
	for (const src of sources)
		for (const [field, key] of URL_KEYS) {
			const v = src.data?.[key];
			if (legal[field] || typeof v !== 'string' || !v.startsWith('http')) continue;
			legal[field] = v;
			from[field] = src.from;
		}
	return { legal, from };
}

/** ASC list payloads come back as `{data:[…]}` or a bare array depending on subcommand. */
const rows = (payload) =>
	Array.isArray(payload) ? payload : (payload?.data ?? payload?.apps ?? payload?.items ?? []);

/**
 * Resolve the ASC app id from the bundle id. Never fatal: adopting a repo whose
 * App Store Connect record does not exist yet is a completely normal first day,
 * and the next-steps block tells the operator how to create one.
 */
async function ascAppIdFor(bundleId) {
	const payload = await asc(['apps', 'list', '--bundle-id', bundleId, '--limit', '200'], {
		allowFail: true,
		fallback: null,
	});
	const match = rows(payload).find((a) => (a?.attributes?.bundleId ?? a?.bundleId) === bundleId);
	return match ? String(match.id ?? match.attributes?.id ?? '') || null : null;
}

/**
 * The App Store Connect record is the only authoritative source for the
 * *product* name and primary locale. `app.json` carries the home-screen name,
 * which a dynamic config routinely rewrites per variant ("Glovebox (dev)"), and
 * static analysis cannot tell which branch ships. Never fatal: no record yet is
 * the normal first day.
 */
async function ascAppRecord(appId) {
	if (!appId) return null;
	const payload = await asc(['apps', 'view', '--id', String(appId)], { allowFail: true, fallback: null });
	return payload?.data?.attributes ?? payload?.attributes ?? null;
}

// ------------------------------------------------------------------ writing

const shown = (v) =>
	v === null || v === undefined || v === '' ? c.dim('—') : Array.isArray(v) ? v.join(', ') : String(v);

function detection(label, value, source) {
	const val = value === null || value === undefined || value === '' ? c.dim('not found') : c.bold(String(value));
	process.stdout.write(`  ${c.cyan(label.padEnd(22))} ${val}${source ? ` ${c.dim(source)}` : ''}\n`);
}

function preview(text) {
	for (const line of text.replace(/\n$/, '').split('\n')) process.stdout.write(`    ${c.dim(line)}\n`);
}

/** Single write funnel so --dry-run cannot be forgotten at a call site. */
async function put(file, content, root, { intent = 'write' } = {}) {
	const label = relative(root, file) || basename(file);
	if (isDryRun()) {
		note(`${c.yellow(`would ${intent}`)} ${label}`);
		return false;
	}
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
	good(`${intent === 'create' ? 'created' : 'wrote'} ${label}`);
	return true;
}

/**
 * Fill holes in `existing` from `detected`, recording every change.
 * A hole is null / undefined / '' / []. Anything else a human decided.
 */
function mergeFill(existing, detected, changes, path = []) {
	const out = { ...existing };
	for (const [k, v] of Object.entries(detected)) {
		const cur = out[k];
		const at = [...path, k];
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			out[k] = mergeFill(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}, v, changes, at);
			continue;
		}
		const empty =
			cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && cur.length === 0);
		if (!empty) continue;
		const blank = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
		if (blank) {
			if (cur === undefined) out[k] = v ?? null;
			continue;
		}
		out[k] = v;
		changes.push({ path: at.join('.'), from: cur, to: v });
	}
	return out;
}

/** Servers shipkit owns and therefore refreshes; anything else in the file survives. */
async function shipkitServers() {
	const file = join(SHIPKIT_ROOT, 'mcp', 'servers.json');
	const doc = await readJSON(file);
	if (!doc?.mcpServers) throw new ShipError(`${file} has no "mcpServers" block`, { hint: 'shipkit install looks incomplete' });
	return { file, servers: doc.mcpServers, schema: doc.$schema };
}

/** Detect a JSON file's own indentation so a merge does not reformat the diff. */
function indentOf(text, fallback = '\t') {
	const m = /\n([\t ]+)"/.exec(text ?? '');
	return m ? m[1] : fallback;
}

// -------------------------------------------------------------------- entry

export async function run({ args, flags }) {
	const root = resolve(String(flags.dir ?? args[0] ?? process.cwd()));
	if (!existsSync(root)) throw new ShipError(`no such directory: ${root}`);
	const force = Boolean(flags.force);
	const dry = isDryRun();

	heading(`ship init ${c.dim(root)}`);
	if (dry) info(c.yellow('dry run — nothing will be written'));

	// ---- 1. locate the app -------------------------------------------------
	const appDir = await findAppDir(root);
	const appPath = join(root, appDir);
	const appJson = (await readJSON(join(appPath, 'app.json'))) ?? {};
	const expo = appJson.expo ?? appJson;
	const dynamic = await findDynamicConfig(appPath);
	const easJsonFile = existsSync(join(appPath, 'eas.json')) ? join(appPath, 'eas.json') : join(root, 'eas.json');
	const easJson = (await readJSON(easJsonFile)) ?? {};

	// ---- 2. detect ---------------------------------------------------------
	step('detected');
	detection('appDir', appDir, appDir === '.' ? '(repo root)' : `${appDir}/app.json`);

	// The dynamic config is evaluated last by Expo, so its literal wins when it
	// sets one unambiguously; literalFromConfig returns null for variant configs.
	const dynBundle = dynamic ? literalFromConfig(dynamic.text, 'bundleIdentifier') : null;
	const bundleId = dynBundle ?? expo.ios?.bundleIdentifier ?? null;
	if (!bundleId)
		throw new ShipError('cannot determine the iOS bundle identifier', {
			hint: `set expo.ios.bundleIdentifier in ${relative(root, join(appPath, 'app.json'))}`,
		});

	const easAscId = easJson.submit?.production?.ios?.ascAppId ?? null;
	let ascAppId = easAscId ? String(easAscId) : null;
	let ascSource = ascAppId ? `${relative(root, easJsonFile)} submit.production.ios` : '';
	if (!ascAppId) {
		ascAppId = await ascAppIdFor(bundleId);
		ascSource = ascAppId ? 'asc apps list (matched bundleId)' : '';
	}
	const ascApp = await ascAppRecord(ascAppId);

	const name = ascApp?.name ?? expo.name ?? null;
	detection('name', name, ascApp?.name ? 'App Store Connect' : 'app.json expo.name');

	const version = expo.version ?? null;
	detection('version', version, 'app.json expo.version');

	detection('bundleId', bundleId, dynBundle ? `${dynamic.name} (overrides app.json)` : 'app.json expo.ios');

	const easProjectId = expo.extra?.eas?.projectId ?? null;
	detection('eas.projectId', easProjectId, 'app.json expo.extra.eas');
	const easOwner = expo.owner ?? null;
	detection('eas.owner', easOwner, expo.owner ? 'app.json expo.owner' : '');
	const easChannel = easJson.build?.production?.channel ?? null;
	detection('eas.channel', easChannel, easChannel ? `${relative(root, easJsonFile)} build.production` : '');

	detection('asc.appId', ascAppId, ascSource);

	const primaryLocale = ascApp?.primaryLocale ?? 'en-US';
	if (ascApp?.primaryLocale) detection('asc.primaryLocale', primaryLocale, 'App Store Connect');
	const storeDir = join(root, 'store');
	let locales = await localesIn(join(storeDir, 'staged'));
	let localeSource = 'store/staged/*.json';
	if (!locales.length) {
		locales = await localesIn(join(storeDir, 'app-info'));
		localeSource = 'store/app-info/*.json';
	}
	if (!locales.length) {
		locales = [primaryLocale];
		localeSource = 'default (primary locale)';
	}
	detection('store.locales', `${locales.length} · ${locales.slice(0, 6).join(', ')}${locales.length > 6 ? ', …' : ''}`, localeSource);

	const scanned = await sourceFiles(appPath);
	const { entitlement, keyEnv } = await scanSources(scanned);
	detection('rc.entitlement', entitlement.value, entitlement.ambiguous ? `ambiguous: ${entitlement.all.join(', ')} — left unset` : entitlement.value ? 'app sources' : '');
	detection('rc.keyEnv', keyEnv.value, keyEnv.ambiguous ? `ambiguous: ${keyEnv.all.join(', ')} — left unset` : keyEnv.value ? 'app sources' : '');

	const { legal, from: legalFrom } = await detectLegal(root, storeDir, primaryLocale);
	detection('legal.privacyUrl', legal.privacyUrl, legalFrom.privacyUrl ?? '');
	detection('legal.supportUrl', legal.supportUrl, legalFrom.supportUrl ?? '');
	detection('legal.marketingUrl', legal.marketingUrl, legalFrom.marketingUrl ?? '');

	const detected = {
		name,
		bundleId,
		version,
		appDir,
		asc: { appId: ascAppId, profile: null, primaryLocale, platform: 'IOS' },
		eas: {
			projectId: easProjectId,
			owner: easOwner,
			profile: 'production',
			platform: 'ios',
			channel: easChannel ?? 'production',
		},
		store: { dir: 'store', locales },
		revenuecat: { projectId: null, appId: null, entitlement: entitlement.value, keyEnv: keyEnv.value },
		ads: { orgId: null, dir: 'aso/asa' },
		aso: { dir: 'aso', markets: ['us'], seeds: [] },
		legal,
	};

	// ---- 3. ship.config.json ----------------------------------------------
	step(CONFIG_NAME);
	const configFile = join(root, CONFIG_NAME);
	const existing = existsSync(configFile) ? await readJSON(configFile) : null;
	if (existsSync(configFile) && existing === null)
		throw new ShipError(`${configFile} exists but is not valid JSON`, {
			hint: 'fix or delete it, then re-run `ship init`',
		});

	let merged = detected;
	if (existing && !force) {
		const changes = [];
		merged = mergeFill(existing, detected, changes);
		if (changes.length) {
			info(`filling ${changes.length} empty field${changes.length === 1 ? '' : 's'}; every other value kept as-is`);
			for (const ch of changes)
				note(`${ch.path}: ${shown(ch.from)} ${c.dim('→')} ${c.green(shown(ch.to))}`);
		} else {
			good(`${CONFIG_NAME} already complete — nothing to fill`);
		}
	} else if (existing && force) {
		warn(`--force: replacing ${CONFIG_NAME} with detected values`);
	}

	// normalise() is the same gate loadConfig() uses; failing here beats failing
	// inside the next command with a half-written config on disk.
	normalise(structuredClone(merged), configFile);
	const configText = `${JSON.stringify(merged, null, '\t')}\n`;
	const wroteConfig = !existing || force || configText !== `${JSON.stringify(existing, null, '\t')}\n`;
	if (!wroteConfig) note('unchanged');
	else if (dry) {
		note(`${c.yellow('would write')} ${CONFIG_NAME}`);
		preview(configText);
	} else {
		await saveConfig(merged, configFile);
		good(`wrote ${CONFIG_NAME}`);
	}

	// ---- 4. MCP ------------------------------------------------------------
	if (flags['no-mcp'] || flags.mcp === false) {
		step('mcp');
		note('skipped (--no-mcp)');
	} else {
		step('mcp');
		const { servers, schema } = await shipkitServers();
		const ompFile = join(root, '.omp', 'mcp.json');
		const ompRaw = await readText(ompFile);
		const ompIndent = ompRaw == null ? '\t' : indentOf(ompRaw);
		const ompDoc = (await readJSON(ompFile)) ?? {};
		const kept = Object.keys(ompDoc.mcpServers ?? {}).filter((k) => !(k in servers));
		// Shipkit-owned entries are refreshed; anything the operator added stays.
		const ompNext = {
			$schema: ompDoc.$schema ?? schema,
			...ompDoc,
			mcpServers: { ...ompDoc.mcpServers, ...servers },
		};
		const ompText = `${JSON.stringify(ompNext, null, ompIndent)}\n`;
		info(`${Object.keys(servers).join(', ')}${kept.length ? ` ${c.dim(`(keeping ${kept.join(', ')})`)}` : ''}`);
		if (ompText === `${JSON.stringify(ompDoc, null, ompIndent)}\n`) note('.omp/mcp.json unchanged');
		else if (dry) {
			note(`${c.yellow('would write')} .omp/mcp.json`);
			preview(ompText);
		} else await put(ompFile, ompText, root);

		// Claude Code / Cursor read .mcp.json at the repo root; same servers, own file.
		const claudeFile = join(root, '.mcp.json');
		const claudeRaw = await readText(claudeFile);
		const claudeIndent = claudeRaw == null ? ompIndent : indentOf(claudeRaw);
		const claudeDoc = (await readJSON(claudeFile)) ?? {};
		const claudeNext = { ...claudeDoc, mcpServers: { ...claudeDoc.mcpServers, ...servers } };
		const claudeText = `${JSON.stringify(claudeNext, null, claudeIndent)}\n`;
		if (claudeText === `${JSON.stringify(claudeDoc, null, claudeIndent)}\n`) note('.mcp.json unchanged');
		else if (dry) note(`${c.yellow('would write')} .mcp.json ${c.dim('(same mcpServers block)')}`);
		else await put(claudeFile, claudeText, root);
	}

	// ---- 5. npm scripts ----------------------------------------------------
	step('npm scripts');
	const pkgFile = join(appPath, 'package.json');
	const pkgText = await readText(pkgFile);
	if (pkgText == null) warn(`no package.json in ${appDir === '.' ? 'repo root' : appDir} — skipping scripts`);
	else {
		const pkg = JSON.parse(pkgText);
		// JSON.parse preserves insertion order for string keys, so mutating in
		// place and re-stringifying keeps the operator's diff to the new lines.
		pkg.scripts ??= {};
		const added = [];
		const clashes = [];
		for (const [key, cmd] of Object.entries(NPM_SCRIPTS)) {
			if (pkg.scripts[key] === cmd) continue;
			if (pkg.scripts[key] !== undefined && !force) {
				clashes.push(key);
				continue;
			}
			pkg.scripts[key] = cmd;
			added.push(key);
		}
		if (clashes.length) note(`kept existing: ${clashes.join(', ')} ${c.dim('(--force to replace)')}`);
		if (!added.length) good('all ship scripts present');
		else {
			const indent = indentOf(pkgText);
			const text = `${JSON.stringify(pkg, null, indent)}${pkgText.endsWith('\n') ? '\n' : ''}`;
			if (dry) {
				note(`${c.yellow('would write')} ${relative(root, pkgFile)}`);
				preview(added.map((k) => `"${k}": "${NPM_SCRIPTS[k]}",`).join('\n'));
			} else await put(pkgFile, text, root);
		}
	}

	// ---- 6. directories ----------------------------------------------------
	step('directories');
	const dirs = [join(storeDir, 'staged'), join(root, 'aso'), join(root, '.asc', 'reports')];
	const missing = dirs.filter((d) => !existsSync(d));
	if (!missing.length) good('store/staged, aso, .asc/reports all present');
	else if (dry) for (const d of missing) note(`${c.yellow('would create')} ${relative(root, d)}/`);
	else
		for (const d of missing) {
			await mkdir(d, { recursive: true });
			good(`created ${relative(root, d)}/`);
		}

	const stagedCount = (await localesIn(join(storeDir, 'staged'))).length;
	const appInfoCount = (await localesIn(join(storeDir, 'app-info'))).length;
	const versionCount = (await listDir(join(storeDir, 'version'))).length;
	// Canonical trees without a staged tree means listings exist but are not
	// authorable — `ship meta` reads staged/, so this repo is half-adopted.
	if (!stagedCount && (appInfoCount || versionCount))
		warn('store/app-info or store/version has content but store/staged is empty — run `ship meta pull` to author them');

	// ---- 7. .gitignore -----------------------------------------------------
	step('.gitignore');
	const giFile = join(root, '.gitignore');
	const giText = (await readText(giFile)) ?? '';
	const have = new Set(giText.split('\n').map((l) => l.trim()));
	const need = GITIGNORE_LINES.filter((l) => !have.has(l));
	if (!need.length) good('already ignores ship artefacts');
	else {
		const prefix = giText === '' ? '' : giText.endsWith('\n') ? '' : '\n';
		const block = `${prefix}\n# shipkit\n${need.join('\n')}\n`;
		if (dry) {
			note(`${c.yellow('would append')} .gitignore`);
			preview(need.join('\n'));
		} else await put(giFile, giText + block, root, { intent: giText ? 'write' : 'create' });
	}

	// ---- 8. next steps -----------------------------------------------------
	const steps = [];
	if (!merged.asc?.appId)
		steps.push(
			`No App Store Connect app record for ${c.bold(bundleId)}.\n` +
				`  Create one at https://appstoreconnect.apple.com/apps (+ → New App), then re-run ${c.cyan('ship init')}\n` +
				`  or set ${c.cyan('asc.appId')} in ${CONFIG_NAME}. Verify with ${c.cyan(`asc apps list --bundle-id ${bundleId}`)}.`,
		);
	if (!stagedCount)
		steps.push(
			appInfoCount || versionCount
				? `Store listings exist but are not staged — ${c.cyan('ship meta migrate')} converts the canonical tree into ${c.cyan('store/staged/*.json')}.`
				: `No store listings yet — ${c.cyan('ship meta pull')} downloads what App Store Connect already has, or write ${c.cyan(`store/staged/${primaryLocale}.json`)} by hand and run ${c.cyan('ship meta lint')}.`,
		);
	if (!merged.revenuecat?.projectId)
		steps.push(`RevenueCat project not linked — ${c.cyan('ship rc projects')} lists the ids, then set ${c.cyan('revenuecat.projectId')}.`);
	if (!merged.ads?.orgId)
		steps.push(`No Apple Search Ads org — ${c.cyan('ship ads status')} shows whether credentials are stored and how to add them.`);
	if (!merged.legal?.privacyUrl)
		steps.push(`No privacy policy URL — App Store review rejects without one. Set ${c.cyan('legal.privacyUrl')} in ${CONFIG_NAME}.`);
	steps.push(`Confirm the machine is wired up: ${c.cyan('ship doctor')}, then ${c.cyan('ship status')} for the release dashboard.`);

	heading('next');
	steps.forEach((s, i) => process.stdout.write(`  ${c.bold(`${i + 1}.`)} ${s}\n`));
	if (dry) process.stdout.write(`\n${c.dim('dry run — re-run without --dry-run to apply.')}\n`);
	return 0;
}
