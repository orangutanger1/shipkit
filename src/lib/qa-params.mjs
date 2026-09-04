// src/lib/qa-params.mjs
// The QA query-parameter contract, and the only place it is interpreted.
//
// lib/qa-matrix.mjs sets qaTheme/qaState/qaLocale/qaTextScale on every capture
// URL. expo-router honours the same parameters over a deep link on NATIVE, so
// an ungated release build would accept a URL that puts any screen into any
// state — a paywall in its success state included. `enabled` is that gate, and
// it returns before reading a single field.
//
// This module is also emitted verbatim into the generated app as
// src/theme/qa-params.ts, so the logic shipkit tests is the logic that ships.

/** Every state `ux-spec` allows a screen to declare. */
export const QA_STATES = /** @type {const} */ ([
	'default', 'empty', 'loading', 'error', 'offline', 'success', 'disabled',
]);

/** What a capture renders when nothing valid was asked for. */
export const QA_DEFAULTS = /** @type {const} */ ({ theme: null, state: 'default', locale: null, scale: 1 });

/** Dynamic Type never shrinks below half or grows past 4× body on iOS. */
const SCALE_MIN = 0.5;
const SCALE_MAX = 4;

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** expo-router gives a repeated parameter as an array; a single value is the only one we honour.
 * @type {(value: unknown) => string|null}
 */
function oneString(value) {
	return typeof value === 'string' ? value : null;
}

/** @type {(value: unknown, allowed: readonly string[], fallback: string|null) => string|null} */
function oneOf(value, allowed, fallback) {
	const str = oneString(value);
	return str !== null && allowed.includes(str) ? str : fallback;
}

/** @type {(value: unknown) => string|null} */
function localeOf(value) {
	const str = oneString(value);
	return str !== null && LOCALE_RE.test(str) ? str : null;
}

/** Clamped rather than rejected: an out-of-range scale is a typo, and the nearest legal size still measures something.
 * @type {(value: unknown) => number}
 */
function scaleOf(value) {
	const n = Number(oneString(value));
	if (!Number.isFinite(n) || n <= 0) return QA_DEFAULTS.scale;
	return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/**
 * @type {(raw: any, opts: {enabled: boolean, themes: readonly string[], states?: readonly string[]}) => {theme: string|null, state: string, locale: string|null, scale: number}}
 */
export function sanitizeQa(raw, { enabled, themes, states = QA_STATES }) {
	if (!enabled || !raw || typeof raw !== 'object') return { ...QA_DEFAULTS };
	return {
		theme: oneOf(raw.qaTheme, themes, QA_DEFAULTS.theme),
		state: oneOf(raw.qaState, states, QA_DEFAULTS.state) ?? QA_DEFAULTS.state,
		locale: localeOf(raw.qaLocale),
		scale: scaleOf(raw.qaTextScale),
	};
}
