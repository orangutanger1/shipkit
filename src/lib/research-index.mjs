// `research index`: rank what the run gathered and join the numbers only Node
// can know. Pure — the command hands it parsed artifacts and writes what comes
// back, so `ship design` reads one provider-agnostic file and never learns
// where any of it came from.
import { round2 } from './fmt.mjs';
import { meanRating } from './research-verify.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ratings gained per day since the previous run. This is Shipkit's own free
 * stand-in for the downloads number the storefront will not give: it costs
 * nothing, and it gets more accurate the longer the tool has been run against
 * the same competitor set. Null on a first run, which has no prior to subtract.
 * @type {(prev: {ratingCount?: number, at?: string}|null, now: {ratingCount?: number, at: string}) => number|null}
 */
export function ratingVelocity(prev, now) {
	if (!prev || typeof prev.ratingCount !== 'number' || typeof now.ratingCount !== 'number') return null;
	const days = (Date.parse(now.at) - Date.parse(prev.at ?? '')) / DAY_MS;
	if (!Number.isFinite(days) || days <= 0) return null;
	return round2((now.ratingCount - prev.ratingCount) / days);
}

/**
 * How much an app's screens are worth as evidence — the planner's own weighting.
 * @type {(app: any) => number}
 */
export const appWeight = (app) =>
	round2(Math.min(5, Math.max(0, app?.rating ?? 0)) * Math.log10(Math.max(0, app?.ratingCount ?? 0) + 1));

/** @type {Record<string, number>} */
const CONFIDENCE = { high: 1, medium: 0.8, low: 0.5 };

/**
 * Rank a reference. Marketing-shot position is developer-ranked priority, so
 * shot 1 is evidence about what its team thought mattered most and shot 9 is
 * nearly none; the decay is gentle enough that a strong app's later screens
 * still outrank a weak app's first.
 * @type {(ref: any) => number}
 */
export const referenceScore = (ref) =>
	round2(
		appWeight(ref?.app) *
			(CONFIDENCE[ref?.confidence] ?? 0.8) *
			(typeof ref?.position === 'number' ? 1 / (1 + (ref.position - 1) / 12) : 0.9),
	);

/**
 * flow → what the run actually holds for it, so a thin flow is visible not assumed.
 * @type {(references: any[], flows: string[]) => Record<string, {references: number, apps: number}>}
 */
function coverage(references, flows) {
	/** @type {Record<string, {references: number, apps: number}>} */
	const out = {};
	for (const flow of flows) out[flow] = { references: 0, apps: 0 };
	for (const ref of references) {
		const row = (out[ref.flow] ??= { references: 0, apps: 0 });
		row.references++;
	}
	for (const [flow, row] of Object.entries(out)) {
		row.apps = new Set(references.filter((r) => r.flow === flow).map((r) => r.trackId)).size;
	}
	return out;
}

/** @type {(trackId: number, held: {app: any, references: number}, ctx: any) => any} */
function appRow(trackId, { app, references }, { corpora, prevApps, prevAt, themeCounts, now }) {
	const corpus = corpora.find((/** @type {any} */ c) => c.trackId === trackId);
	const prev = prevApps.get(trackId);
	return {
		trackId,
		name: app.name,
		rating: app.rating ?? null,
		ratingCount: app.ratingCount ?? null,
		ratingVelocity: ratingVelocity(prev ? { ratingCount: prev.ratingCount, at: prevAt } : null, {
			ratingCount: app.ratingCount,
			at: now,
		}),
		weight: appWeight(app),
		references,
		reviews: corpus?.count ?? 0,
		reviewMean: corpus ? (corpus.appMeanRating ?? meanRating(corpus.reviews ?? [])) : null,
		themes: themeCounts.get(trackId) ?? 0,
	};
}

/** @type {(ref: any) => any} */
const refRow = (ref) => ({
	id: ref.id,
	flow: ref.flow ?? null,
	position: ref.position ?? null,
	trackId: ref.app?.trackId ?? null,
	app: ref.app?.name ?? null,
	confidence: ref.confidence ?? null,
	path: ref.image?.path ?? null,
	score: referenceScore(ref),
});

/**
 * @param {{plan: any, references: any[], corpora: any[], themes?: any, patterns?: any, previous?: any, now?: string}} input
 *   `previous` is the last run's index.json; it exists only to date the velocity.
 */
export function buildIndex({ plan, references, corpora, themes, patterns, previous = null, now = new Date().toISOString() }) {
	const prevApps = new Map((previous?.apps ?? []).map((/** @type {any} */ a) => [a.trackId, a]));
	const prevAt = previous?.generatedAt;
	/** @type {Map<number, {app: any, references: number}>} */
	const byTrack = new Map();
	for (const ref of references) {
		const id = ref?.app?.trackId;
		if (id === undefined) continue;
		const row = byTrack.get(id) ?? { app: ref.app, references: 0 };
		row.references++;
		byTrack.set(id, row);
	}
	for (const corpus of corpora) if (!byTrack.has(corpus.trackId)) byTrack.set(corpus.trackId, { app: { name: `app ${corpus.trackId}`, trackId: corpus.trackId }, references: 0 });

	/** @type {Map<number, number>} */
	const themeCounts = new Map();
	for (const t of themes?.themes ?? []) themeCounts.set(t.trackId, (themeCounts.get(t.trackId) ?? 0) + 1);

	const apps = [...byTrack.entries()]
		.map(([trackId, held]) => appRow(trackId, held, { corpora, prevApps, prevAt, themeCounts, now }))
		.sort((a, b) => b.weight - a.weight || a.trackId - b.trackId);

	const ranked = references
		.map(refRow)
		.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
		.map((r, i) => ({ rank: i + 1, ...r }));

	const claims = patterns?.claims ?? [];
	return {
		slug: plan?.slug ?? null,
		generatedAt: now,
		provider: plan?.provider ?? 'appstore',
		country: plan?.country ?? null,
		flows: plan?.flows ?? [],
		apps,
		references: ranked,
		coverage: coverage(ranked, plan?.flows ?? []),
		reviews: { apps: corpora.length, total: corpora.reduce((/** @type {number} */ n, /** @type {any} */ c) => n + (c?.count ?? 0), 0) },
		themes: (themes?.themes ?? []).length,
		claims: {
			total: claims.length,
			evidence: claims.filter((/** @type {any} */ c) => c.kind === 'evidence').length,
			hypothesis: claims.filter((/** @type {any} */ c) => c.kind === 'hypothesis').length,
		},
	};
}
