// Measured search popularity for a set of candidate terms.
//
// Every other demand number in `aso` is inferred from autocomplete rank. This
// one is Apple's own, out of the Ads Platform API's keyword-suggestion
// endpoint, and two properties of that endpoint shape everything here:
//
//   · it honours one term per call, so a candidate list is N round trips;
//   · each answer expands the seed into up to 100 related terms that also carry
//     a popularity — and those numbers are **seed-relative**. Live, "car care"
//     reads 26 as its own seed and 14 inside "carfax"'s expansion. Reusing an
//     expansion row to save a call would put two different scales in one
//     column, so only the row for the term we asked about is read. The rest is
//     a seed source, not a demand reading (see backlog 5).
//
// The network is injected, so the batching and the matching rule are testable
// offline and the caller owns the credentials.
import { POPULARITY_FLOOR } from './ads-v1.mjs';

/** @typedef {{text: string, popularity: number}} Suggestion */

/** @type {(s: string) => string} */
const normal = (s) => String(s ?? '').trim().toLocaleLowerCase();

/**
 * Popularity for as many of `terms` as Apple will say something about.
 *
 * Batches run concurrently because the endpoint tolerates it — fifteen parallel
 * calls answered in under a second live, against roughly 600ms each serially.
 *
 * @param {string[]} terms
 * @param {(term: string) => Promise<Suggestion[]>} ask
 * @param {{max?: number, concurrency?: number, onProgress?: (done: number, total: number, label: string, extra: string) => void}} [opts]
 * @returns {Promise<{found: Map<string, number>, calls: number, wanted: string[], overBudget: string[], unanswered: string[]}>}
 */
export async function collectPopularity(terms, ask, { max = 200, concurrency = 5, onProgress } = {}) {
	const wanted = [...new Set(terms.map(normal).filter(Boolean))];
	const budget = wanted.slice(0, max);
	/** @type {Map<string, number>} */
	const found = new Map();

	for (let at = 0; at < budget.length; at += concurrency) {
		const batch = budget.slice(at, at + concurrency);
		const answers = await Promise.all(batch.map(ask));
		for (const [i, rows] of answers.entries()) {
			const own = rows.find(matches, batch[i]);
			if (own) found.set(batch[i], own.popularity);
		}
		onProgress?.(at + batch.length, wanted.length, `${at + batch.length} asked`, `${found.size} answered`);
	}
	// Two different silences: a term the budget never reached, and one Apple
	// answered without mentioning. Only the first is fixed by raising --max.
	return { found, calls: budget.length, wanted, overBudget: wanted.slice(max), unanswered: budget.filter(missing, found) };
}

/** The row for the term we asked about. @this {string} @param {Suggestion} row */
function matches(row) {
	return normal(row.text) === this;
}

/** @this {Map<string, number>} @param {string} term */
function missing(term) {
	return !this.has(term);
}

/**
 * The `volume.json` an answered collection is worth.
 *
 * Floor rows are counted and thrown away. Apple echoes a term it has no data
 * for back at exactly {@link POPULARITY_FLOOR}, and that is also the lowest
 * real popularity it reports, so a 5 cannot be read as measured demand — it
 * would collapse every long-tail candidate onto one value and hand the ranking
 * to competition alone. Dropped, the term keeps its autocomplete-rank estimate,
 * which is a worse number that at least still discriminates.
 *
 * @param {Map<string, number>} found
 * @param {string[]} wanted
 * @returns {{terms: Record<string, {popularity: number}>, floor: string[]}}
 */
export function volumeTerms(found, wanted) {
	/** @type {Record<string, {popularity: number}>} */
	const terms = {};
	/** @type {string[]} */
	const floor = [];
	for (const term of new Set(wanted.map(normal))) {
		const popularity = found.get(term);
		if (popularity === undefined) continue;
		if (popularity <= POPULARITY_FLOOR) floor.push(term);
		else terms[term] = { popularity };
	}
	return { terms, floor };
}
