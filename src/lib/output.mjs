// Shared stdout output shapes: the `--json` emitter and the key/value table.
import { table } from '../log.mjs';

/** `--json` output: the payload and nothing else. Returns 0 for `return emit(…)`. */
export function emit(data) {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
}

/** Two-column `field` / `value` table for a list of pairs. */
export function kvTable(pairs) {
	table(pairs, [
		{ header: 'field', get: (r) => r[0] },
		{ header: 'value', get: (r) => r[1] },
	]);
}
