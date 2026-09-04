// Small async/collection utilities shared across commands.
import { homedir } from 'node:os';
import { ShipError } from '../log.mjs';

/**
 * The shape unvalidated JSON has before a parse/normalise function narrows it.
 * Every external payload starts here; only `typeof`/`Array.isArray` narrowing
 * promotes a value into a trusted type — never a cast.
 * @typedef {string|number|boolean|null|JsonArray|JsonObject} Json
 */
/** @typedef {Json[]} JsonArray */
/** @typedef {{[key: string]: Json}} JsonObject */

/** `--flag` values as parseArgs delivers them: a string payload or a boolean. */
/** @typedef {Record<string, string|boolean>} Flags */
/** What a subcommand receives: the parsed flags and the remaining positionals. */
/** @typedef {{flags: Flags, args: string[]}} SubCtx */

/**
 * Cache an async call so N callers share one credential check / fetch.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {() => Promise<T>}
 */
export function memo(fn) {
	let promise;
	return () => (promise ??= fn());
}

/**
 * Absolute paths are noise in a report; the reader knows their own home.
 * @param {string} p
 * @returns {string}
 */
export function tilde(p) {
	const home = homedir();
	return typeof p === 'string' && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Expand a leading `~/` or `~` to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
export function expandTilde(p) {
	return String(p).replace(/^~(?=\/|$)/, homedir());
}

/**
 * Run `fn` in isolation: a rejection becomes `{value:null, error}` instead of
 * aborting the batch, so one broken app cannot blank a whole dashboard.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{value: T|null, error: string|null}>}
 */
export async function settle(fn) {
	try {
		return { value: await fn(), error: null };
	} catch (err) {
		return { value: null, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Median of numbers; 0 for an empty list (matching every current caller).
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * First real string among the candidates (a bare `--flag` parses as `true`).
 * @param {...(string|boolean|null|undefined)} candidates
 * @returns {string|undefined}
 */
export function strOf(...candidates) {
	for (const v of candidates) {
		if (typeof v === 'string' && v.length) return v;
	}
	return undefined;
}

/**
 * The message of anything thrown. `catch` binds `unknown` because a non-Error
 * can be thrown, and `String(err)` on one of those is still a better line in a
 * report than nothing.
 * @param {unknown} err
 * @returns {string}
 */
export function errMessage(err) {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The exit code a thrown ShipError carries; anything else exits 1.
 * @param {unknown} err
 * @returns {number}
 */
export function errExitCode(err) {
	return err instanceof ShipError ? err.exitCode : 1;
}

/**
 * A JSON value narrowed to a string, or `null`. Narrowing rather than casting:
 * an object where a string was promised stays untrusted instead of being told
 * it is one.
 * @param {Json|undefined} value
 * @returns {string|null}
 */
export function strOrNull(value) {
	return typeof value === 'string' ? value : null;
}

/**
 * A JSON value narrowed to an object, or an empty one. Property access on a
 * scalar would have yielded nothing anyway; this makes that explicit and keeps
 * a spread from widening into a union no caller can use.
 * @param {Json|undefined} value
 * @returns {JsonObject}
 */
export function objOrEmpty(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * Resolve a subcommand word. Unknown names raise with the valid set.
 * @template C
 * @template R
 * @param {{command: string, args: string[], subs: Record<string, (ctx: C) => R>, fallback: string}} spec
 * @returns {{fn: (ctx: C) => R, args: string[]}}
 */
export function resolveSubcommand({ command, args, subs, fallback }) {
	const [name = fallback, ...rest] = args;
	const fn = subs[name];
	if (!fn)
		throw new ShipError(`${command}: unknown subcommand "${name}"`, {
			hint: `try: ${Object.keys(subs).join(', ')}`,
		});
	return { fn, args: rest };
}
