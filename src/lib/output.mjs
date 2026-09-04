// Shared stdout output shapes: the `--json` emitter and the key/value table.
import { table } from '../log.mjs';

/** @typedef {import('./util.mjs').Json} Json */

/**
 * `--json` output: the payload and nothing else. Returns 0 for `return emit(…)`.
 *
 * Takes `object` as well as `Json` because a command's artifact is a declared
 * shape with optional fields, and an optional field is `T|undefined`, which
 * `Json` cannot hold — `JSON.stringify` drops those keys anyway.
 * @param {Json|object} data
 * @returns {number}
 */
export function emit(data) {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
}

/**
 * Two-column `field` / `value` table for a list of pairs.
 * @param {[string, Json][]} pairs
 * @returns {void}
 */
export function kvTable(pairs) {
	table(pairs, [
		{ header: 'field', get: (r) => r[0] },
		{ header: 'value', get: (r) => r[1] },
	]);
}
