// Small async/collection utilities shared across commands.
import { homedir } from 'node:os';
import { ShipError } from '../log.mjs';

/** Absolute paths are noise in a report; the reader knows their own home. */
export function tilde(p) {
	const home = homedir();
	return typeof p === 'string' && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Expand a leading `~/` or `~` to the user's home directory. */
export function expandTilde(p) {
	return String(p).replace(/^~(?=\/|$)/, homedir());
}

/** Cache an async call so N callers share one credential check / fetch. */
export function memo(fn) {
	let promise;
	return () => (promise ??= fn());
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
		return { value: null, error: err?.message ?? String(err) };
	}
}

/** Median of numbers; 0 for an empty list (matching every current caller). */
export function median(values) {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** First real string among the candidates (a bare `--flag` parses as `true`). */
export function strOf(...candidates) {
	for (const v of candidates) {
		if (typeof v === 'string' && v.length) return v;
	}
	return undefined;
}

/** Resolve a subcommand word. Unknown names raise with the valid set. */
export function resolveSubcommand({ command, args, subs, fallback }) {
	const [name = fallback, ...rest] = args;
	const fn = subs[name];
	if (!fn)
		throw new ShipError(`${command}: unknown subcommand "${name}"`, {
			hint: `try: ${Object.keys(subs).join(', ')}`,
		});
	return { fn, args: rest };
}
