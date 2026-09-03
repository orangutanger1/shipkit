// Readers for the loose shapes Apple APIs return through `asc`. Apple wraps
// lists in a payload object whose key varies by endpoint and by whether asc has
// already unwrapped it, so each reader states its tolerance instead of every
// caller re-guessing.

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */

/** Keys under which ASC/Apple payloads hide their list. */
const LIST_KEYS = [
	'data', 'items', 'results', 'versions', 'builds', 'prices', 'apps',
	'tags', 'findings', 'issues', 'keywords', 'localizations',
];

/**
 * Find the list in an ASC payload.
 * - a bare array comes back as-is
 * - an array under any known list key is returned
 * - `payload.data.data` (the raw Apple Ads `pagination` shape) is unwrapped
 * - otherwise: `[payload]` when `allowSingle`, else `[]`
 *
 * `allowSingle: false` is for callers that must not invent a row from a
 * payload they do not recognise — a guessed row reads as real data downstream.
 * @param {Json|undefined} payload
 * @param {{allowSingle?: boolean}} [opts]
 * @returns {JsonArray}
 */
export function rowsOf(payload, { allowSingle = true } = {}) {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== 'object') return [];
	for (const key of LIST_KEYS) {
		if (Array.isArray(payload[key])) return payload[key];
	}
	const inner = payload.data;
	if (inner !== null && typeof inner === 'object' && !Array.isArray(inner) && Array.isArray(inner.data)) {
		return inner.data;
	}
	return allowSingle ? [payload] : [];
}

/**
 * Apple Ads report responses bury rows under `reportingDataResponse`. Depth-first
 * search for the first `node.row` array; `[]` when the payload carries none.
 * @param {Json|undefined} payload
 * @returns {JsonArray}
 */
export function reportRows(payload) {
	/** @type {Set<Json>} */
	const seen = new Set();
	/** @type {Json[]} */
	const stack = payload === undefined ? [] : [payload];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== 'object' || seen.has(node)) continue;
		seen.add(node);
		if (!Array.isArray(node) && Array.isArray(node.row)) return node.row;
		for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
	}
	return [];
}

/**
 * Apple Ads money arrives as `{amount, currency}` or a bare number/string.
 * @param {Json} v
 * @returns {number}
 */
export function metric(v) {
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Number(v.amount) || 0;
	return Number(v) || 0;
}
