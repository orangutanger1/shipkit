// ship.config.json — the single per-app identity manifest.
// Every command resolves paths and IDs through here; nothing hardcodes an app.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ShipError } from './log.mjs';
import { checkAdsConfig } from './lib/asa.mjs';

/** @typedef {import('./lib/util.mjs').Json} Json */
/** @typedef {import('./lib/util.mjs').JsonObject} JsonObject */

/** The `asc` block: App Store Connect identity and auth defaults. */
/** @typedef {{appId: string|null, profile: string|null, primaryLocale: string, platform: string}} AscConfig */
/** The `eas` block: build/submit defaults; `projectId`/`owner` are EAS-account passthroughs `init` writes. */
/** @typedef {{profile: string, platform: string, channel: string, environment: string, projectId?: string|null, owner?: string|null}} EasConfig */
/** The `ota` block: every key here must reach the exported bundle before `ship ota` publishes. */
/** @typedef {{requiredEnv: string[]}} OtaConfig */
/** The `store` block: where staged listings and screenshots live. */
/** @typedef {{dir: string, locales: string[]}} StoreConfig */
/** The `shots` block: the screenshot design spec, relative to store.dir. */
/** @typedef {{spec: string}} ShotsConfig */
/** The `revenuecat` block. `key` names a per-project key file instead of the ambient one. */
/** @typedef {{projectId: string|null, appId: string|null, entitlement: string|null, keyEnv: string|null, key?: string|null}} RevenuecatConfig */
/** The `ads` block: Apple Search Ads spend settings. `targetCpi`/`subPrice` are coherence-checked at load. */
/** @typedef {{orgId: string|null, dir: string, targetCpi: number|null, subPrice: number|null, retentionMonths: number, seedBid: number|null, baselineInstallRate: number, minTaps: number|null, retain: number}} AdsConfig */
/** The `aso` block: keyword seeds and the autocomplete-mining floor. */
/** @typedef {{dir: string, seeds: string[], seedsByLocale: Record<string, string[]>, minVolume: number}} AsoConfig */
/** The `loc` block: which locale is authored and where the glossary lives. */
/** @typedef {{sourceLocale: string|null, glossary: string}} LocConfig */
/** @typedef {{dir: string}} AnalyticsConfig */
/** @typedef {{dir: string, basePriceUsd: number|null}} PriceConfig */
/** @typedef {{privacyUrl: string|null, supportUrl: string|null, marketingUrl: string|null, euTrader: string|null}} LegalConfig */
/** What ship.config.json itself contains. Every block is optional; the
 * defaults fill whatever is absent (see DEFAULTS). */
/** @typedef {{name?: string, bundleId?: string, version?: string, appDir?: string, asc?: AscConfig, eas?: EasConfig, ota?: OtaConfig, store?: StoreConfig, shots?: ShotsConfig, revenuecat?: RevenuecatConfig, ads?: AdsConfig, aso?: AsoConfig, loc?: LocConfig, analytics?: AnalyticsConfig, price?: PriceConfig, legal?: LegalConfig}} FileConfig */
/** The config after the defaults have filled every absent block. */
/** @typedef {{name?: string, bundleId?: string, version?: string, appDir: string, asc: AscConfig, eas: EasConfig, ota: OtaConfig, store: StoreConfig, shots: ShotsConfig, revenuecat: RevenuecatConfig, ads: AdsConfig, aso: AsoConfig, loc: LocConfig, analytics: AnalyticsConfig, price: PriceConfig, legal: LegalConfig}} MergedConfig */
/** Absolute paths derived from the file's location; never read from the file. */
/** @typedef {{root: string, app: string, store: string, staged: string, appInfo: string, aso: string, asa: string, reports: string, analytics: string, pricing: string, glossary: string}} ConfigPaths */
/**
 * The fully-normalised config every command receives from {@link loadConfig}.
 * @typedef {MergedConfig & {
 *   name: string,
 *   bundleId: string,
 *   file: string,
 *   root: string,
 *   paths: ConfigPaths,
 *   versionDir: (version: string) => string,
 *   warnings: string[],
 * }} Config
 */

export const CONFIG_NAME = 'ship.config.json';
export const SHIPKIT_ROOT = resolve(new URL('..', import.meta.url).pathname);

/** ASC field limits. Enforced offline so a bad listing never reaches review. */
/** @typedef {{name: number, subtitle: number, keywords: number, promotionalText: number, description: number, whatsNew: number}} Limits */
/** @type {Limits} */
export const LIMITS = {
	name: 30,
	subtitle: 30,
	keywords: 100,
	promotionalText: 170,
	description: 4000,
	whatsNew: 4000,
};

/** @type {MergedConfig} */
const DEFAULTS = {
	appDir: '.',
	asc: { appId: null, profile: null, primaryLocale: 'en-US', platform: 'IOS' },
	eas: { profile: 'production', platform: 'ios', channel: 'production', environment: 'production' },
	// `requiredEnv` is the OTA publish gate: every key listed here must be present
	// in the EAS environment *and* inlined into the exported bundle before
	// `ship ota` will publish. A key whose absence crashes the app (RevenueCat,
	// analytics) belongs here, not in memory.
	ota: { requiredEnv: [] },
	store: { dir: 'store', locales: [] },
	// `spec` is relative to store.dir and is absent in most repos: a repo that
	// only uploads finished PNGs never loads it. Its presence is what turns on
	// `ship shots capture/render/verify`.
	shots: { spec: 'figma-geometry.json' },
	revenuecat: { projectId: null, appId: null, entitlement: null, keyEnv: null },
	// `targetCpi` and `subPrice` are checked against each other at load time: a
	// target above everything a subscriber ever pays is a decision to lose money,
	// and nothing else in the tool would ever notice. `seedBid` is where a bid
	// starts before the account has a realised CPT of its own — deliberately not
	// Apple's $0.30 floor, which loses every auction.
	ads: {
		orgId: null,
		dir: 'aso/asa',
		targetCpi: null,
		subPrice: null,
		retentionMonths: 1,
		seedBid: null,
		baselineInstallRate: 0.4,
		minTaps: null,
		retain: 12,
	},
	aso: { dir: 'aso', seeds: [], seedsByLocale: {}, minVolume: 0 },
	loc: { sourceLocale: null, glossary: 'store/glossary.json' },
	analytics: { dir: '.asc/analytics' },
	price: { dir: 'store/pricing', basePriceUsd: null },
	legal: { privacyUrl: null, supportUrl: null, marketingUrl: null, euTrader: null },
};

/**
 * Deep-merge `over` onto `base`: the defaults' shape wins wherever the user's
 * JSON is silent; a user value replaces a default outright. The result is the
 * defaults' shape by construction, which is what the return annotation states —
 * user JSON that adds an unknown key rides along untyped until a validator
 * consumes it. (The two casts bridge base's declared shape to the index-signature
 * view the merge loop needs; they carry no data across a trust boundary.)
 * @param {FileConfig} base
 * @param {Json|undefined} over
 * @returns {MergedConfig}
 */
function deepMerge(base, over) {
	if (over === undefined || over === null) return /** @type {MergedConfig} */ (base);
	if (Array.isArray(base) || typeof base !== 'object' || typeof over !== 'object') {
		return /** @type {MergedConfig} */ (over);
	}
	/** @type {Record<string, Json>} */
	const out = {};
	for (const [k, v] of Object.entries(base)) {
		if (v !== undefined) out[k] = v;
	}
	for (const [k, v] of Object.entries(over)) {
		const slot = out[k];
		out[k] =
			slot !== null && typeof slot === 'object' && !Array.isArray(slot) && v !== null && typeof v === 'object' && !Array.isArray(v)
				? deepMerge(/** @type {FileConfig} */ (slot), v)
				: v;
	}
	return /** @type {MergedConfig} */ (out);
}

/**
 * Walk up from `start` looking for ship.config.json.
 * @param {string} [start]
 * @returns {string|null}
 */
function findConfigFile(start = process.cwd()) {
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
 * @overload
 * @param {string} [cwd]
 * @returns {Promise<Config>}
 *//**
 * Load and normalise the config; null when the repo has none and `optional` is set.
 * @overload
 * @param {string} [cwd]
 * @param {{optional: true}} [opts]
 * @returns {Promise<Config|null>}
 *//**
 * @param {string} [cwd]
 * @param {{optional?: boolean}} [opts]
 * @returns {Promise<Config|null>}
 */
export async function loadConfig(cwd = process.cwd(), opts = {}) {
	const { optional = false } = opts ?? {};
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
		throw new ShipError(`${file} is not valid JSON`, { hint: err instanceof Error ? err.message : String(err) });
	}
	return normalise(/** @type {JsonObject} */ (raw), file);
}

/**
 * Normalise a raw ship.config.json object into a {@link Config}.
 * @param {JsonObject} raw
 * @param {string} file
 * @returns {Config}
 */
export function normalise(raw, file) {
	const root = dirname(file);
	const merged = deepMerge(DEFAULTS, raw);
	if (!merged.name) throw new ShipError(`${file}: "name" is required`);
	if (!merged.bundleId) throw new ShipError(`${file}: "bundleId" is required`);
	const name = merged.name;
	const bundleId = merged.bundleId;

	/** @param {string} p */
	const abs = (p) => (isAbsolute(p) ? p : join(root, p));
	const paths = {
		root,
		app: abs(merged.appDir),
		store: abs(merged.store.dir),
		staged: join(abs(merged.store.dir), 'staged'),
		appInfo: join(abs(merged.store.dir), 'app-info'),
		aso: abs(merged.aso.dir),
		asa: abs(merged.ads.dir),
		reports: join(root, '.asc', 'reports'),
		analytics: abs(merged.analytics.dir),
		pricing: abs(merged.price.dir),
		glossary: abs(merged.loc.glossary),
	};

	// Spend settings are validated here rather than in `ship ads`, because a
	// contradiction between targetCpi and subPrice is a property of the config and
	// every command that reads one of them inherits it. Errors are fatal;
	// warnings ride along for whichever command wants to print them.
	const ads = checkAdsConfig(merged.ads);
	if (ads.errors.length)
		throw new ShipError(`${file}: incoherent "ads" settings`, { hint: ads.errors.join('\n') });
	return {
		...merged,
		name,
		bundleId,
		file,
		root,
		paths,
		versionDir: (version) => join(paths.store, 'version', version),
		warnings: ads.warnings.map((w) => `ads: ${w}`),
	};
}

/**
 * Write the config back without its runtime-only fields.
 * @param {Config} cfg
 * @param {string} [file]
 * @returns {Promise<string>}
 */
export async function saveConfig(cfg, file = cfg.file) {
	const { file: _f, root: _r, paths: _p, versionDir: _v, warnings: _w, ...clean } = cfg;
	await writeFile(file, `${JSON.stringify(clean, null, '\t')}\n`);
	return file;
}

/**
 * Read the Expo config (app.json / app.config.js) for version + project identity.
 * @param {Config} cfg
 * @returns {Promise<JsonObject|null>}
 */
export async function readExpoConfig(cfg) {
	const appJson = join(cfg.paths.app, 'app.json');
	if (!existsSync(appJson)) return null;
	const parsed = JSON.parse(await readFile(appJson, 'utf8'));
	const expo =
		parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.expo : parsed;
	return expo !== null && typeof expo === 'object' && !Array.isArray(expo) ? expo : null;
}

/**
 * Marketing version string, preferring ship.config override then app.json.
 * @param {Config} cfg
 * @param {string|undefined} override
 * @returns {Promise<string>}
 */
export async function resolveVersion(cfg, override) {
	if (override) return override;
	if (cfg.version) return cfg.version;
	const expo = await readExpoConfig(cfg);
	if (expo?.version) return String(expo.version);
	throw new ShipError('cannot determine app version', {
		hint: 'pass --version, or set "version" in ship.config.json / app.json',
	});
}

/**
 * ASC app id from config or ASC_APP_ID; null when neither is set.
 * @param {Config} cfg
 * @returns {string|null}
 */
export function optionalAppId(cfg) {
	const id = cfg.asc.appId ?? process.env.ASC_APP_ID;
	return id === null || id === undefined ? null : String(id);
}

/**
 * ASC app id, from config or ASC_APP_ID.
 * @param {Config} cfg
 * @returns {string}
 */
export function requireAppId(cfg) {
	const id = optionalAppId(cfg);
	if (!id)
		throw new ShipError(`${cfg.name}: no App Store Connect app id`, {
			hint: 'set asc.appId in ship.config.json (find it with `asc apps list`)',
		});
	return id;
}
