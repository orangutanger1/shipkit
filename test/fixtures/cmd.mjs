// Harness for the command-level tests: a temp repo, fake binaries on PATH, a
// stubbed fetch and a muzzled stdout. Commands import `exec` and `fetch`
// directly rather than taking them as arguments, so the seam has to be the
// process: PATH decides which `asc`/`npx`/`eas` runs, and globalThis decides
// which `fetch` answers. Nothing here reaches the network or the real machine.
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

const FAKE = new URL('./fake-bin.mjs', import.meta.url).pathname;

/**
 * Put stand-ins for `names` at the front of PATH for the rest of this test
 * file. `node --test` gives each file its own process, so mutating PATH once
 * per file is contained.
 * @param {string[]} names
 * @returns {Promise<string>} the directory that now shadows the real binaries
 */
export async function fakeBins(names) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-bin-'));
	for (const name of names) await symlink(FAKE, join(dir, name));
	process.env.PATH = `${dir}:${process.env.PATH}`;
	process.env.SHIP_FAKE_LOG = join(dir, 'calls.log');
	return dir;
}

/**
 * Teach one fake binary how to answer. Rules are `[argsPattern, response]`
 * pairs, first match wins; anything unmatched exits 0 with empty output.
 * @param {string} name
 * @param {[string, {out?: string|object, err?: string, code?: number, files?: Record<string, string>}][]} rules
 */
export function setBin(name, rules) {
	const key = `SHIP_FAKE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	process.env[key] = JSON.stringify(rules.map(([p, r]) => [p, { ...r, out: typeof r.out === 'object' ? JSON.stringify(r.out) : r.out }]));
}

/** Every fake-binary invocation so far, oldest first. @returns {Promise<{bin: string, args: string[]}[]>} */
export async function calls() {
	const log = process.env.SHIP_FAKE_LOG;
	if (!log) return [];
	const text = await readFile(log, 'utf8').catch(() => '');
	return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Forget the calls recorded so far, so one test does not read another's. */
export async function resetCalls() {
	if (process.env.SHIP_FAKE_LOG) await writeFile(process.env.SHIP_FAKE_LOG, '');
}

/**
 * A repo with a ship.config.json and whatever files the test needs.
 * @param {{config?: object|null, files?: Record<string, unknown>, prefix?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function repo({ config = {}, files = {}, prefix = 'ship-cmd-' } = {}) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	// `config: null` means a directory that is deliberately not a ship repo.
	if (config !== null) await writeFile(join(dir, 'ship.config.json'), JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', version: '1.0.0', ...config }));
	await writeFiles(dir, files);
	return dir;
}

/** @param {string} dir @param {Record<string, unknown>} files */
export async function writeFiles(dir, files) {
	for (const [rel, body] of Object.entries(files)) {
		if (body === null) continue;
		await mkdir(dirname(join(dir, rel)), { recursive: true });
		await writeFile(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
	}
}

/** Run `fn` with `dir` as cwd. @template T @param {string} dir @param {() => T|Promise<T>} fn @returns {Promise<T>} */
export async function inDir(dir, fn) {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(cwd);
	}
}

/** Swallow stdout/stderr and hand back what was written. @template T @param {() => T|Promise<T>} fn @returns {Promise<{result: T, out: string}>} */
export async function capture(fn) {
	const chunks = [];
	const saved = { out: process.stdout.write, err: process.stderr.write };
	process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
	process.stderr.write = (chunk) => (chunks.push(String(chunk)), true);
	try {
		return { result: await fn(), out: chunks.join('') };
	} finally {
		process.stdout.write = saved.out;
		process.stderr.write = saved.err;
	}
}

/** @template T @param {() => T|Promise<T>} fn @returns {Promise<T>} */
export const quiet = async (fn) => (await capture(fn)).result;

/**
 * Answer every fetch with `handler` for the duration of `fn`.
 * @template T @param {typeof fetch} handler @param {() => T|Promise<T>} fn @returns {Promise<T>}
 */
export async function withFetch(handler, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

/** A JSON Response, for a fetch stub. @param {unknown} body @param {number} [status] */
export const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Put the stand-in native modules (sharp, fontkit, puppeteer) where shipkit
 * looks for them: the app repo's own node_modules. appDep resolves from there
 * first, which is the whole reason the render pipeline can be tested at all.
 * @param {string} dir the app repo
 * @param {string[]} [names]
 * @returns {Promise<void>}
 */
export async function linkNativeDeps(dir, names = ['sharp', 'fontkit', 'puppeteer']) {
	const from = new URL('./native/', import.meta.url).pathname;
	await mkdir(join(dir, 'node_modules'), { recursive: true });
	for (const name of names) await symlink(join(from, name), join(dir, 'node_modules', name)).catch(() => {});
}

/** Point homedir() at a temp dir, so a test never reads the real ~. @returns {Promise<string>} */
export async function fakeHome() {
	const dir = await mkdtemp(join(tmpdir(), 'ship-home-'));
	process.env.HOME = dir;
	return dir;
}

export { homedir };
