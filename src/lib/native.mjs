// OTA-vs-native-build decision.
//
// Both tour and idea6 record the same scar: an OTA update shipped against a
// changed native dependency graph breaks installed clients, because the JS
// bundle references native modules the installed binary does not contain.
// The rule is mechanical, so this encodes it instead of asking a human to remember.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Packages that never contain native code, so their version drift is OTA-safe. */
const PURE_JS = new Set([
	'@babel/core', '@types/react', 'typescript', 'jest', 'jest-expo', 'ts-jest',
	'eslint', 'prettier', 'zod', 'zustand', '@tanstack/react-query', 'nativewind',
	'react', 'react-dom',
]);

/** Anything matching these is native by construction. */
const NATIVE_HINT = /^(expo-|react-native-|@react-native|@expo\/|@stripe\/stripe-react-native|@sentry\/react-native)/;

export function isNativeDep(name) {
	if (PURE_JS.has(name)) return false;
	if (name === 'react-native' || name === 'expo' || NATIVE_HINT.test(name)) return true;
	// `react-native` anywhere in the name, not just at the front: scoped natives
	// like @shopify/react-native-skia, @notifee/react-native and
	// posthog-react-native all carry native code the old prefix match missed.
	if (name.includes('react-native')) return true;
	// Unknown package: assume native. A false "unsafe" costs one rebuild; a
	// false "OTA safe" costs every installed client.
	return true;
}

/** The version actually installed in node_modules, or null when not present. */
async function installedVersion(appDir, name) {
	try {
		const pkg = JSON.parse(await readFile(join(appDir, 'node_modules', name, 'package.json'), 'utf8'));
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

/**
 * Native dependency fingerprint of an app dir.
 *
 * The value fingerprinted is the version resolved in node_modules, not the
 * declared range: `npm update` can move a ^/~ range without package.json
 * changing, and a fingerprint of ranges would call the result OTA-safe while
 * the lockfile moved native code under the installed binary. Works for
 * npm/pnpm/bun alike because all three resolve through node_modules.
 */
export async function nativeFingerprint(appDir) {
	const pkgFile = join(appDir, 'package.json');
	const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
	const deps = { ...pkg.dependencies };
	const out = {};
	for (const [name, range] of Object.entries(deps)) {
		if (!isNativeDep(name)) continue;
		out[name] = (await installedVersion(appDir, name)) ?? range;
	}
	return out;
}

/** Expo config keys whose change requires a new binary regardless of deps. */
const NATIVE_CONFIG_KEYS = ['plugins', 'ios', 'android', 'scheme', 'newArchEnabled'];

export async function nativeConfigFingerprint(appDir) {
	const appJson = join(appDir, 'app.json');
	if (!existsSync(appJson)) return {};
	const expo = JSON.parse(await readFile(appJson, 'utf8')).expo ?? {};
	const out = {};
	for (const key of NATIVE_CONFIG_KEYS) if (expo[key] !== undefined) out[key] = expo[key];
	return out;
}

const LOCK_PATH = (cfg) => join(cfg.root, '.asc', 'native-lock.json');

export async function readLock(cfg) {
	const file = LOCK_PATH(cfg);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return null;
	}
}

export async function writeLock(cfg, lock) {
	const file = LOCK_PATH(cfg);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(lock, null, '\t')}\n`);
	return file;
}

/**
 * Compare the working tree against the fingerprint captured at the last native build.
 * @returns {Promise<{safe:boolean, reason:string, added:string[], removed:string[], changed:string[], configChanged:string[], lock:object|null}>}
 */
export async function otaSafety(cfg, version) {
	const deps = await nativeFingerprint(cfg.paths.app);
	const config = await nativeConfigFingerprint(cfg.paths.app);
	const lock = await readLock(cfg);
	const current = { version, deps, config };

	if (!lock)
		return {
			safe: false,
			reason: 'no native build recorded — run `ship build` so OTA has a baseline binary',
			added: [], removed: [], changed: [], configChanged: [], lock: null, current,
		};

	if (lock.version !== version)
		return {
			safe: false,
			reason: `app version moved ${lock.version} → ${version}; runtimeVersion no longer matches the installed binary`,
			added: [], removed: [], changed: [], configChanged: [], lock, current,
		};

	const added = Object.keys(deps).filter((k) => !(k in lock.deps));
	const removed = Object.keys(lock.deps).filter((k) => !(k in deps));
	const changed = Object.keys(deps).filter((k) => k in lock.deps && lock.deps[k] !== deps[k]);
	const configChanged = Object.keys({ ...config, ...lock.config }).filter(
		(k) => JSON.stringify(config[k]) !== JSON.stringify(lock.config[k]),
	);

	const drift = added.length + removed.length + changed.length + configChanged.length;
	return {
		safe: drift === 0,
		reason: drift === 0
			? 'native graph identical to the last build — OTA is safe'
			: `${drift} native change(s) since the last build — installed clients would crash on this bundle`,
		added, removed, changed, configChanged, lock, current,
	};
}
