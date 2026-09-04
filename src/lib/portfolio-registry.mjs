// ship portfolio registry: which repos the dashboard covers, kept in
// ~/.omp/shipkit-portfolio.json (override with SHIP_PORTFOLIO_FILE).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_NAME } from '../config.mjs';
import { ShipError } from '../log.mjs';

/** One registered repo: where it is, and what to call it in the dashboard. */
/** @typedef {{path: string, name: string}} PortfolioApp */
/** @typedef {{apps: PortfolioApp[]}} Registry */

/** @returns {string} */
export function registryFile() {
	return process.env.SHIP_PORTFOLIO_FILE || join(homedir(), '.omp', 'shipkit-portfolio.json');
}

/** Tolerate a bare string per app, a missing name, and duplicate paths. */
/** @param {any} raw @returns {Registry} */
export function normaliseRegistry(raw) {
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {PortfolioApp[]} */
	const apps = [];
	for (const entry of Array.isArray(raw?.apps) ? raw.apps : []) {
		const path = typeof entry === 'string' ? entry : entry?.path;
		if (typeof path !== 'string' || !path.trim()) continue;
		const abs = resolve(path.trim());
		if (seen.has(abs)) continue;
		seen.add(abs);
		const name = typeof entry === 'object' && entry?.name ? String(entry.name) : basename(abs);
		apps.push({ path: abs, name });
	}
	return { apps };
}

/** @param {string} [file] @returns {Promise<Registry>} */
export async function readRegistry(file = registryFile()) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (err) {
		if (err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { apps: [] };
		throw new ShipError(`cannot read ${file}`, { hint: err instanceof Error ? err.message : String(err) });
	}
	try {
		return normaliseRegistry(JSON.parse(text));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err instanceof Error ? err.message : String(err) });
	}
}

/** @param {Registry} reg @param {string} [file] @returns {Promise<string>} */
export async function writeRegistry(reg, file = registryFile()) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ apps: reg.apps }, null, 2)}\n`);
	return file;
}

/** Idempotent by resolved path: re-adding refreshes the name, never duplicates. */
/**
 * @param {Registry} reg
 * @param {{path: string, name?: string}} entry
 * @returns {{registry: Registry, existed: boolean}}
 */
export function addEntry(reg, { path, name }) {
	const abs = resolve(path);
	const existed = reg.apps.some((a) => a.path === abs);
	const apps = reg.apps
		.filter((a) => a.path !== abs)
		.concat({ path: abs, name: name || basename(abs) })
		.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	return { registry: { apps }, existed };
}

/** Remove by registered path or by name — you remember one or the other, never both. */
/**
 * @param {Registry} reg
 * @param {string} key
 * @returns {{registry: Registry, removed: PortfolioApp[]}}
 */
export function removeEntry(reg, key) {
	const abs = resolve(key);
	/** @type {(a: PortfolioApp) => boolean} */
	const hit = (a) => a.path === abs || a.name === key || basename(a.path) === key;
	const removed = reg.apps.filter(hit);
	return { registry: { apps: reg.apps.filter((a) => !hit(a)) }, removed };
}

/** Generated, vendored, or another toolchain's repo entirely. */
const SCAN_SKIP_DIRS = new Set([
	'node_modules', '.git', 'ios', 'android', 'Pods', '.expo', 'build', 'dist', 'vendor', 'coverage',
]);

/**
 * Directories holding a ship.config.json, at most `depth` levels below `dir`.
 * An app repo is a leaf: nothing below a config is another app, and descending
 * into one costs a full node_modules walk for nothing.
 */
/** @param {string} dir @param {{depth?: number}} [opts] @returns {Promise<string[]>} */
export async function scanConfigs(dir, { depth = 4 } = {}) {
	const root = resolve(dir);
	/** @type {string[]} */
	const found = [];
	/** @type {(current: string, level: number) => Promise<void>} */
	const walk = async (current, level) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.isFile() && e.name === CONFIG_NAME)) {
			found.push(current);
			return;
		}
		if (level >= depth) return;
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith('.') || SCAN_SKIP_DIRS.has(e.name)) continue;
			await walk(join(current, e.name), level + 1);
		}
	};
	await walk(root, 0);
	return found.sort();
}
