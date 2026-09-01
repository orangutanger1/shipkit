// Number/money/percent formatting shared by the reporting commands.
export const DASH = '—';

/** Coerce to a finite number, falling back when the value is junk. */
export function num(v, fallback = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const round1 = (n) => Math.round(n * 10) / 10;

/** Clamp into [lo, hi]. */
export function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

/** Demand/percent style clamps: anything outside 0-100 saturates, never wraps. */
export const clamp100 = (n) => clamp(num(n), 0, 100);

/** `$12.34`; null/undefined read as zero, matching ASC's "no spend yet". */
export function money(n) {
	return `$${num(n ?? 0).toFixed(2)}`;
}

/** `$12.34`, or an em dash when there is no value at all (distinct from $0.00). */
export function moneyOrDash(n) {
	return n === null || n === undefined ? DASH : money(n);
}

/** Fraction → percent. `pct(0.1234)` is `12.34%`. */
export function pct(n, digits = 2) {
	return `${(num(n) * 100).toFixed(digits)}%`;
}
