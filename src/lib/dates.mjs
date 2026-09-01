// Date math shared by the dashboards. Apple timestamps are ISO with offsets;
// whole days are the useful resolution everywhere.
export const DAY_MS = 86_400_000;

/**
 * Whole days from `now` until the ISO timestamp (countdown semantics: rounds).
 * Null when there is no timestamp to count from.
 */
export function daysUntil(iso, now = Date.now()) {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? Math.round((t - now) / DAY_MS) : null;
}

/**
 * Whole days elapsed since `iso` (age semantics: floors). Accepts a number
 * (epoch ms) or an ISO string; null when the input carries no date.
 */
export function daysElapsed(iso, now = Date.now()) {
	const t = typeof iso === 'number' ? iso : Date.parse(iso ?? '');
	return Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null;
}

/** `YYYY-MM-DD` for an epoch-ms instant (UTC). */
export function isoDay(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}
