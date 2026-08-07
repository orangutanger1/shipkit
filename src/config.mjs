// ship.config.json — the single per-app identity manifest.
// Every command resolves paths and IDs through here; nothing hardcodes an app.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ShipError } from './log.mjs';

export const CONFIG_NAME = 'ship.config.json';
export const SHIPKIT_ROOT = resolve(new URL('..', import.meta.url).pathname);

/** ASC field limits. Enforced offline so a bad listing never reaches review. */
export const LIMITS = {
	name: 30,
	subtitle: 30,
	keywords: 100,
	promotionalText: 170,
	description: 4000,
	whatsNew: 4000,
};

const DEFAULTS = {
	appDir: '.',
	asc: { appId: null, profile: null, primaryLocale: 'en-US', platform: 'IOS' },
	eas: { profile: 'production', platform: 'ios', channel: 'production' },
	store: { dir: 'store', locales: [] },
	revenuecat: { projectId: null, appId: null, entitlement: null, keyEnv: null },
	ads: { orgId: null, dir: 'aso/asa' },
	aso: { dir: 'aso', markets: ['us'], seeds: [] },
	legal: { privacyUrl: null, supportUrl: null, marketingUrl: null },
};

function deepMerge(base, over) {
	if (over === undefined || over === null) return base;
	if (Array.isArray(base) || typeof base !== 'object' || typeof over !== 'object') return over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
	return out;
}

/** Walk up from `start` looking for ship.config.json. */
export function findConfigFile(start = process.cwd()) {
	let dir = resolve(start);
	for (;;) {
		const candidate = join(dir, CONFIG_NAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Load and normalise the config for the repo containing `cwd`.
 * @returns {Promise<Config>}
 */
export async function loadConfig(cwd = process.cwd(), { optional = false } = {}) {
	const file = findConfigFile(cwd);
	if (!file) {
		if (optional) return null;
		throw new ShipError(`no ${CONFIG_NAME} found from ${cwd}`, {
			hint: 'run `ship init` inside the app repo to create one',
		});
	}
	let raw;
	try {
		raw = JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
	return normalise(raw, file);
}

/** @typedef {ReturnType<typeof normalise>} Config */
export function normalise(raw, file) {
	const root = dirname(file);
	const cfg = deepMerge(DEFAULTS, raw);
	if (!cfg.name) throw new ShipError(`${file}: "name" is required`);
	if (!cfg.bundleId) throw new ShipError(`${file}: "bundleId" is required`);

	const abs = (p) => (isAbsolute(p) ? p : join(root, p));
	cfg.file = file;
	cfg.root = root;
	cfg.paths = {
		root,
		app: abs(cfg.appDir),
		store: abs(cfg.store.dir),
		staged: join(abs(cfg.store.dir), 'staged'),
		appInfo: join(abs(cfg.store.dir), 'app-info'),
		aso: abs(cfg.aso.dir),
		asa: abs(cfg.ads.dir),
		reports: join(root, '.asc', 'reports'),
	};
	cfg.versionDir = (version) => join(cfg.paths.store, 'version', version);
	return cfg;
}

export async function saveConfig(cfg, file = cfg.file) {
	const { file: _f, root: _r, paths: _p, versionDir: _v, ...clean } = cfg;
	await writeFile(file, `${JSON.stringify(clean, null, '\t')}\n`);
	return file;
}

/** Read the Expo config (app.json / app.config.js) for version + project identity. */
export async function readExpoConfig(cfg) {
	const appJson = join(cfg.paths.app, 'app.json');
	if (!existsSync(appJson)) return null;
	const parsed = JSON.parse(await readFile(appJson, 'utf8'));
	return parsed.expo ?? parsed;
}

/** Marketing version string, preferring ship.config override then app.json. */
export async function resolveVersion(cfg, override) {
	if (override) return override;
	if (cfg.version) return cfg.version;
	const expo = await readExpoConfig(cfg);
	if (expo?.version) return expo.version;
	throw new ShipError('cannot determine app version', {
		hint: 'pass --version, or set "version" in ship.config.json / app.json',
	});
}

/** ASC app id, from config or ASC_APP_ID. */
export function requireAppId(cfg) {
	const id = cfg.asc.appId ?? process.env.ASC_APP_ID;
	if (!id)
		throw new ShipError(`${cfg.name}: no App Store Connect app id`, {
			hint: 'set asc.appId in ship.config.json (find it with `asc apps list`)',
		});
	return String(id);
}
