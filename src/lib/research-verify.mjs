// The gate between the agent's half of a research run and everything
// downstream. Pure: it is handed already-parsed artifacts and returns issues,
// so `ship design` can reuse the same checks without a second file walk.
//
// Every check here is arithmetic or set membership. Judgement about whether a
// claim is *true* is not a gate's business; whether it is *cited* is.
import { round2 } from './fmt.mjs';

/** @typedef {import('./research-fetch.mjs').Review} Review */

/**
 * Mean rating of a review set, to the precision themes.ratingSkew is stored at.
 * @type {(reviews: {rating: number}[]) => number}
 */
export const meanRating = (reviews) =>
	reviews.length ? round2(reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) : 0;

/**
 * `ratingSkew` is what the supporting reviews say relative to the app's own
 * mean, so a theme that only shows up in 1★ reviews reads as -2 and not as
 * "people mention this".
 * @type {(ids: string[], byId: Map<string, Review>, appMean: number) => number|null}
 */
export function skewFor(ids, byId, appMean) {
	const found = ids.map((id) => byId.get(id)).filter(Boolean);
	if (!found.length) return null;
	return round2(meanRating(/** @type {Review[]} */ (found)) - appMean);
}

/**
 * Reference ids on disk, so a claim can be checked against what was actually fetched.
 * @type {(refs: any[]) => Set<string>}
 */
const idsOf = (refs) => new Set(refs.map((r) => r?.id).filter(Boolean));

/**
 * References: the image a reference names must be the image on disk. A hash
 * that does not match means the assets and the notes have drifted apart, and
 * every observation written against that screen is now about a different one.
 * @type {(refs: any[], hashes: Map<string, string>, plan: any) => string[]}
 */
export function checkReferences(refs, hashes, plan) {
	/** @type {string[]} */
	const issues = [];
	const flows = new Set(plan?.flows ?? []);
	const seen = new Set();
	for (const ref of refs) {
		const at = ref?.id ?? '(reference with no id)';
		if (seen.has(at)) issues.push(`${at}: duplicate reference id`);
		seen.add(at);
		if (Array.isArray(ref?._todo) && ref._todo.length)
			issues.push(`${at}: still a fetch draft — fill ${ref._todo.join(', ')} and drop _todo`);
		if (ref?.flow && flows.size && !flows.has(ref.flow))
			issues.push(`${at}: flow "${ref.flow}" is not one of the planned flows (${[...flows].join(', ')})`);
		const path = ref?.image?.path;
		if (!path) continue;
		const actual = hashes.get(path);
		if (!actual) issues.push(`${at}: ${path} is missing from the run`);
		else if (actual !== ref.image.sha256) issues.push(`${at}: ${path} does not match its recorded sha256`);
	}
	return issues;
}

/**
 * Themes: `support` and `ratingSkew` are Node's numbers, not the agent's. A
 * theme citing a review the fetch never returned is the failure mode that
 * matters — it is how a synthesized quote gets attributed to nobody.
 * @type {(themes: any, byId: Map<string, Review>, appMeans: Map<number, number>) => string[]}
 */
export function checkThemes(themes, byId, appMeans) {
	/** @type {string[]} */
	const issues = [];
	for (const t of themes?.themes ?? []) {
		const at = `theme "${t?.label ?? '?'}"`;
		const ids = Array.isArray(t?.reviewIds) ? t.reviewIds : [];
		const missing = ids.filter((/** @type {string} */ id) => !byId.has(id));
		if (missing.length) issues.push(`${at}: cites ${missing.length} review id(s) not in the corpus (${missing[0]})`);
		if (t?.support !== ids.length) issues.push(`${at}: support is ${t?.support}, reviewIds has ${ids.length}`);
		if (t?.ratingSkew === undefined || missing.length) continue;
		const mean = appMeans.get(t?.trackId) ?? meanRating([...byId.values()]);
		const computed = skewFor(ids, byId, mean);
		if (computed !== null && Math.abs(computed - t.ratingSkew) > 0.01)
			issues.push(`${at}: ratingSkew is ${t.ratingSkew}, the supporting reviews give ${computed}`);
	}
	return issues;
}

/**
 * An evidence claim needs three references; anything with none is an opinion.
 * @type {(patterns: any, refs: any[]) => string[]}
 */
export function checkClaims(patterns, refs) {
	const known = idsOf(refs);
	/** @type {string[]} */
	const issues = [];
	for (const claim of patterns?.claims ?? []) {
		const at = `claim "${String(claim?.claim ?? '?').slice(0, 60)}"`;
		const cited = Array.isArray(claim?.refs) ? claim.refs : [];
		const unknown = cited.filter((/** @type {string} */ id) => !known.has(id));
		if (unknown.length) issues.push(`${at}: cites unknown reference ${unknown[0]}`);
		if (!cited.length) issues.push(`${at}: cites no references`);
		else if (claim?.kind === 'evidence' && cited.length < 3)
			issues.push(`${at}: kind is "evidence" with ${cited.length} ref(s); evidence needs 3`);
		for (const id of claim?.counterexamples ?? [])
			if (!known.has(id)) issues.push(`${at}: counterexample ${id} is not a reference in this run`);
	}
	return issues;
}

/**
 * The budget is a cap on what a run was allowed to cost Apple, so it is checked
 * against the artifacts rather than against the fetcher's own tally — a tally
 * can be wrong in exactly the direction that makes it useless.
 * @type {(plan: any, counts: {apps: number, references: number, reviewPages: number}) => string[]}
 */
export function checkBudget(plan, counts) {
	const b = plan?.budget ?? {};
	const sorts = (plan?.sorts ?? []).length || 1;
	/** @type {string[]} */
	const issues = [];
	/** @type {(what: string, got: number, cap: number) => boolean|number} */
	const over = (what, got, cap) => got > cap && issues.push(`budget: ${what} ${got} exceeds the planned cap of ${cap}`);
	over('apps', counts.apps, b.apps ?? 0);
	over('references', counts.references, (b.apps ?? 0) * (b.screensPerApp ?? 0));
	over('review pages', counts.reviewPages, (b.apps ?? 0) * (b.reviewPages ?? 0) * sorts);
	return issues;
}

/**
 * Reviews as one lookup table, plus each app's own mean for the skew baseline.
 * @type {(corpora: any[]) => {byId: Map<string, Review>, appMeans: Map<number, number>}}
 */
export function indexReviews(corpora) {
	/** @type {Map<string, Review>} */
	const byId = new Map();
	/** @type {Map<number, number>} */
	const appMeans = new Map();
	for (const corpus of corpora) {
		for (const r of corpus?.reviews ?? []) byId.set(r.id, r);
		appMeans.set(corpus?.trackId, corpus?.appMeanRating ?? meanRating(corpus?.reviews ?? []));
	}
	return { byId, appMeans };
}
