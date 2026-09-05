// ship init detection: everything that infers an app's identity from the repo
// without executing anything. Detection is best-effort and always reported with
// its source, because a silently guessed bundle id ships a build to the wrong
// app record.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { asc } from '../exec.mjs';
import { ShipError } from '../log.mjs';
import { rowsOf } from './asc-report.mjs';
import { readJSONOrNull } from './jsonio.mjs';
import { parseStrings } from './locales.mjs';

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

const ENTITLEMENT_PATTERNS = [
	/entitlements\s*(?:\?\.)?\s*\.\s*active\s*\[\s*['"`]([\w][\w.\- ]*)['"`]\s*\]/g,
	/entitlements\s*(?:\?\.)?\s*\.\s*active\s*\.\s*([A-Za-z_$][\w$]*)/g,
	/ENTITLEMENT(?:_ID|_KEY)?\s*[:=]\s*['"`]([\w][\w.\- ]*)['"`]/g,
	/\bentitlement(?:Id|Identifier)?\s*:\s*['"`]([\w][\w.\- ]*)['"`]/g,
];

const KEY_ENV_RE = /\bEXPO_PUBLIC_(?:[A-Z0-9_]*RC[A-Z0-9_]*KEY|REVENUECAT[A-Z0-9_]*)\b/g;

/** @type {['privacyUrl'|'supportUrl'|'marketingUrl', string][]} */
const URL_KEYS = [
	['privacyUrl', 'privacyPolicyUrl'],
	['supportUrl', 'supportUrl'],
	['marketingUrl', 'marketingUrl'],
];

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** A source-scan hit: one value, an ambiguous list, or nothing. */
/** @typedef {{value: string|null, ambiguous: boolean, all?: string[]}} ScanHit */

/** @param {Json|undefined} v @returns {v is JsonObject} */
const isJsonObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * JSON:API row → its attributes block, or the row itself when asc answers flat.
 * @param {Json|undefined} row
 * @returns {JsonObject}
 */
const attrsOf = (row) => {
	if (!isJsonObject(row)) return {};
	const attrs = row.attributes;
	return isJsonObject(attrs) ? attrs : row;
};

/** @param {string} file @returns {Promise<string|null>} */
async function readTextOrNull(file) {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return null;
	}
}

/** @param {string} dir */
export async function listDir(dir) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Recursive file walk, depth- and skip-list-bounded.
 * @param {string} dir
 * @param {number} [depth]
 * @returns {AsyncGenerator<string, void, undefined>}
 */
async function* walk(dir, depth = 0) {
	if (depth > 6) return;
	for (const ent of await listDir(dir)) {
		if (SKIP_DIRS.has(ent.name)) continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) yield* walk(p, depth + 1);
		else if (ent.isFile()) yield p;
	}
}

/**
 * Locate the Expo app directory: the one holding app.json, at the repo root or
 * exactly one level below it. One level is deliberate — deeper searches start
 * finding example apps inside node_modules clones.
 *
 * @param {string} root
 * @returns {Promise<string>} '.' or a subdirectory name
 */
export async function findAppDir(root) {
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
		const pkg = await readJSONOrNull(join(root, name, 'package.json'));
		const deps = {
			...(isJsonObject(pkg) && isJsonObject(pkg.dependencies) ? pkg.dependencies : null),
			...(isJsonObject(pkg) && isJsonObject(pkg.devDependencies) ? pkg.devDependencies : null),
		};
		if (deps.expo) return name;
	}
	return candidates[0];
}

/** app.config.js/ts/mjs, which overrides app.json at evaluation time.
 * @param {string} appPath
 * @returns {Promise<{file: string, name: string, text: string}|null>}
 */
export async function findDynamicConfig(appPath) {
	for (const name of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']) {
		const p = join(appPath, name);
		if (existsSync(p)) return { file: p, name, text: (await readTextOrNull(p)) ?? '' };
	}
	return null;
}

/**
 * Pull a plain string literal out of a dynamic config without executing it.
 * Executing app.config.ts needs a TS loader and the app's whole env; reading it
 * costs nothing and is correct for the only shape that matters — a hardcoded
 * identifier. Two different literals means a variant-switching config
 * (idea6 suffixes `.dev`), so we refuse to guess and let app.json win.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
export function literalFromConfig(text, key) {
	const re = new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`$\\n]+)['"\`]`, 'g');
	const found = new Set();
	for (const m of text.matchAll(re)) found.add(m[1]);
	return found.size === 1 ? [...found][0] : null;
}

/** Every scannable source file under the app dir, plus its committed env samples.
 * @param {string} appPath
 * @returns {Promise<string[]>}
 */
export async function sourceFiles(appPath) {
	const out = [];
	for await (const file of walk(appPath)) {
		const base = basename(file);
		if (base.startsWith('.env')) out.push(file);
		else if (SOURCE_EXT.has(extname(file))) out.push(file);
		if (out.length >= MAX_SOURCE_FILES) break;
	}
	return out;
}

/**
 * Entitlement + key env var, read out of the app's own source. Ambiguity stays
 * null: a wrong entitlement id renders an empty paywall to a paying customer,
 * which is strictly worse than an unset field `ship rc audit` will flag.
 *
 * @param {string[]} files
 * @returns {Promise<{entitlement: ScanHit, keyEnv: ScanHit}>}
 */
export async function scanSources(files) {
	/** @type {Map<string, number>} */
	const entitlements = new Map();
	/** @type {Map<string, number>} */
	const keyEnvs = new Map();
	for (const file of files) {
		const text = await readTextOrNull(file);
		if (text == null || text.length > MAX_SOURCE_BYTES) continue;

		for (const m of text.matchAll(KEY_ENV_RE)) keyEnvs.set(m[0], (keyEnvs.get(m[0]) ?? 0) + 1);

		// Only trust an entitlement literal in a file that actually talks to RevenueCat.
		if (!/react-native-purchases|\bPurchases\b|CustomerInfo/.test(text)) continue;
		for (const re of ENTITLEMENT_PATTERNS)
			for (const m of text.matchAll(re)) {
				const v = m[1];
				if (!v || v === 'active' || v === 'entitlements' || v.length > 64) continue;
				entitlements.set(v, (entitlements.get(v) ?? 0) + 1);
			}
	}
	/** @param {Map<string, number>} map @returns {ScanHit} */
	const pick = (map) => {
		if (map.size === 0) return { value: null, ambiguous: false };
		if (map.size === 1) return { value: [...map.keys()][0], ambiguous: false };
		return { value: null, ambiguous: true, all: [...map.keys()] };
	};
	// A repo may legitimately reference an iOS *and* an Android key; prefer the
	// iOS one rather than calling it ambiguous, since ship is iOS-only.
	const ios = [...keyEnvs.keys()].filter((k) => k.includes('IOS'));
	const keyEnv = ios.length === 1 ? { value: ios[0], ambiguous: false } : pick(keyEnvs);
	return { entitlement: pick(entitlements), keyEnv };
}

/** Locale basenames from a directory of `<locale>.json` / `<locale>.strings`.
 * @param {string} dir
 * @param {string} [ext]
 * @returns {Promise<string[]>}
 */
export async function localesIn(dir, ext = '.json') {
	return (await listDir(dir))
		.filter((e) => e.isFile() && extname(e.name) === ext)
		.map((e) => basename(e.name, ext))
		.sort();
}

/**
 * Legal URLs, from whatever listing form this repo already has. Prefer the
 * primary locale; these URLs are shared across locales in practice and ASC
 * rejects a version that is missing them.
 *
 * @param {string} root
 * @param {string} storeDir
 * @param {string} primaryLocale
 * @returns {Promise<{legal: Record<'privacyUrl'|'supportUrl'|'marketingUrl', string|null>, from: Record<string, string>}>}
 */
export async function detectLegal(root, storeDir, primaryLocale) {
	const sources = [];
	const jsonDirs = [join(storeDir, 'app-info')];
	const versionRoot = join(storeDir, 'version');
	for (const ent of await listDir(versionRoot)) if (ent.isDirectory()) jsonDirs.push(join(versionRoot, ent.name));
	for (const dir of jsonDirs) {
		for (const locale of await localesIn(dir, '.json')) {
			const data = await readJSONOrNull(join(dir, `${locale}.json`));
			if (data) sources.push({ locale, data, from: `${relative(root, join(dir, `${locale}.json`))}` });
		}
	}
	for (const name of ['app-info-localizations', 'localizations']) {
		const dir = join(root, name);
		for (const locale of await localesIn(dir, '.strings')) {
			const text = await readTextOrNull(join(dir, `${locale}.strings`));
			if (text) sources.push({ locale, data: parseStrings(text), from: `${name}/${locale}.strings` });
		}
	}
	sources.sort((a, b) => (a.locale === primaryLocale ? -1 : b.locale === primaryLocale ? 1 : 0));

	/** @type {Record<'privacyUrl'|'supportUrl'|'marketingUrl', string|null>} */
	const legal = { privacyUrl: null, supportUrl: null, marketingUrl: null };
	/** @type {Record<string, string>} */
	const from = {};
	for (const src of sources)
		for (const [field, key] of URL_KEYS) {
			const v = isJsonObject(src.data) ? src.data[key] : undefined;
			if (legal[field] || typeof v !== 'string' || !v.startsWith('http')) continue;
			legal[field] = v;
			from[field] = src.from;
		}
	return { legal, from };
}

/**
 * Resolve the ASC app id from the bundle id. Never fatal: adopting a repo whose
 * App Store Connect record does not exist yet is a completely normal first day,
 * and the next-steps block tells the operator how to create one.
 *
 * @param {string} bundleId
 * @returns {Promise<string|null>}
 */
export async function ascAppIdFor(bundleId) {
	const payload = await asc(['apps', 'list', '--bundle-id', bundleId, '--limit', '200'], {
		allowFail: true,
		fallback: null,
	});
	const match = rowsOf(payload, { allowSingle: false }).find((a) => attrsOf(a).bundleId === bundleId);
	if (!match) return null;
	// attrsOf(match).bundleId only ever equals bundleId (a non-empty string) when
	// match is itself a JsonObject — attrsOf returns {} for anything else, whose
	// .bundleId is undefined. So .find already proved match is a JsonObject.
	const id = /** @type {JsonObject} */ (match).id ?? attrsOf(match).id ?? '';
	return id === '' ? null : String(id);
}

/**
 * The App Store Connect record is the only authoritative source for the
 * *product* name and primary locale. `app.json` carries the home-screen name,
 * which a dynamic config routinely rewrites per variant ("Glovebox (dev)"), and
 * static analysis cannot tell which branch ships. Never fatal: no record yet is
 * the normal first day.
 *
 * @param {string|null} appId
 * @returns {Promise<JsonObject|null>}
 */
export async function ascAppRecord(appId) {
	if (!appId) return null;
	const payload = await asc(['apps', 'view', '--id', String(appId)], { allowFail: true, fallback: null });
	const data = isJsonObject(payload) ? payload.data : null;
	const attrs = isJsonObject(data) ? data.attributes : null;
	const found = attrs ?? (isJsonObject(payload) ? payload.attributes : null);
	return isJsonObject(found) ? found : null;
}
