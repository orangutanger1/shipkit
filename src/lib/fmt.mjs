// Number/money/percent formatting shared by the reporting commands.

/** The em dash used across every report for "no value at all". */
/** @typedef {'—'} Dash */
/** @type {Dash} */
export const DASH = '—';

/**
 * Coerce to a finite number, falling back when the value is junk. Report cells
 * arrive as strings, numbers, `null` or objects ({@link import('./util.mjs').Json});
 * the unified rule is: `Number(v)`, and anything non-finite becomes `fallback`.
 * @param {string|number|boolean|null|undefined} v
 * @param {number} [fallback]
 * @returns {number}
 */
export function num(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {number} n
 * @returns {number}
 */
export const round2 = (n) => Math.round(n * 100) / 100;
/**
 * @param {number} n
 * @returns {number}
 */
export const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Clamp into [lo, hi].
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Demand/percent style clamps: anything outside 0-100 saturates, never wraps.
 * @param {string|number|boolean|null|undefined} n
 * @returns {number}
 */
export const clamp100 = (n) => clamp(num(n), 0, 100);

/**
 * `$12.34`; null/undefined read as zero, matching ASC's "no spend yet".
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function money(n) {
	return `$${num(n ?? 0).toFixed(2)}`;
}

/**
 * `$12.34`, or an em dash when there is no value at all (distinct from $0.00).
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function moneyOrDash(n) {
	return n === null || n === undefined ? DASH : money(n);
}

/**
 * Fraction → percent. `pct(0.1234)` is `12.34%`.
 * @param {string|number|boolean|null|undefined} n
 * @param {number} [digits]
 * @returns {string}
 */
export function pct(n, digits = 2) {
	return `${(num(n) * 100).toFixed(digits)}%`;
}
