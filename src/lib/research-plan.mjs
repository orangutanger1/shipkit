// The research planner: which apps, which flows, and how many requests that
// costs. Pure and offline — it reads artifacts the ASO side already wrote, so
// the run is decided before a single byte is fetched and `research verify` has
// a number to hold the fetch to.
import { ShipError } from '../log.mjs';
import { DEFAULT_RESEARCH_FLOWS, requireFlow } from './flows.mjs';

/** Both RSS orderings. Recent shows what broke; helpful shows what persists. */
export const SORTS = /** @type {const} */ (['mostrecent', 'mosthelpful']);

/** @typedef {import('../config.mjs').Config} Config */
/** As `ship aso competitors` writes them. */
/** @typedef {{id: number, name: string, seller?: string, ratings?: number, stars?: number, price?: number, genre?: string}} CompetitorRow */
/** @typedef {{trackId: number, name: string, rank: number, score: number, ratings: number, stars: number, why: string}} PlannedApp */
/** @typedef {{lookup: number, screenshots: number, reviews: number, total: number}} RequestCost */
/** @typedef {{slug: string, createdAt: string, provider: string, country: string, product: {category: string|null, audience: string|null}, flows: string[], apps: PlannedApp[], sorts: string[], budget: {apps: number, screensPerApp: number, reviewPages: number, requests: RequestCost}, outputs: Record<string, string>}} ResearchPlan */

/**
 * Rank a competitor set by evidence weight: a 4.8 with 300 ratings is a nicer
 * app than a 4.4 with 300k, but it is far weaker evidence about what works.
 * Ratings enter logarithmically so the top of the store cannot own the plan.
 * @type {(rows: CompetitorRow[], limit: number) => PlannedApp[]}
 */
export function rankApps(rows, limit) {
	const scored = rows
		.filter((r) => Number.isFinite(Number(r.id)))
		.map((r) => {
			const ratings = Math.max(0, Number(r.ratings ?? 0));
			const stars = Math.min(5, Math.max(0, Number(r.stars ?? 0)));
			return {
				trackId: Number(r.id),
				name: String(r.name ?? `app ${r.id}`),
				ratings,
				stars,
				score: Number((stars * Math.log10(ratings + 1)).toFixed(3)),
			};
		})
		.sort((a, b) => b.score - a.score || b.ratings - a.ratings || a.trackId - b.trackId)
		.slice(0, limit);
	return scored.map((a, i) => ({
		...a,
		rank: i + 1,
		why: `${a.stars || '?'}★ over ${a.ratings.toLocaleString('en-US')} ratings`,
	}));
}

/**
 * What one run costs Apple, exactly. Screenshot URLs come free with the lookup
 * response but each image is its own GET, and every review page is fetched once
 * per sort.
 * @type {(budget: {apps: number, screensPerApp: number, reviewPages: number}, apps: number) => {lookup: number, screenshots: number, reviews: number, total: number}}
 */
export function requestCost(budget, apps) {
	const lookup = apps;
	const screenshots = apps * budget.screensPerApp;
	const reviews = apps * budget.reviewPages * SORTS.length;
	return { lookup, screenshots, reviews, total: lookup + screenshots + reviews };
}

/**
 * Flows to research: the `--flows` list, else the config's, else the default
 * six. Unknown names raise rather than silently researching nothing.
 * @type {(configured: string[], requested?: string) => string[]}
 */
export function resolveFlows(configured, requested) {
	const raw = requested
		? String(requested).split(',').map((s) => s.trim()).filter(Boolean)
		: configured.length
			? configured
			: [...DEFAULT_RESEARCH_FLOWS];
	if (!raw.length) throw new ShipError('research: no flows to research', { hint: 'pass --flows welcome,paywall' });
	return [...new Set(raw.map((f) => requireFlow(f, 'research flow')))];
}

/**
 * A run slug: the date, plus a name when one run needs telling from another.
 * @type {(now: string, name?: string) => string}
 */
export const slugFor = (now, name) => (name ? `${now.slice(0, 10)}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : now.slice(0, 10));

/**
 * Build the plan. Every path in it is repo-relative so the artifact is
 * diffable and portable; the command resolves them against research.dir.
 * @type {(input: {cfg: Config, competitors: CompetitorRow[], flows: string[], slug: string, country: string, apps?: number, now?: string}) => ResearchPlan}
 */
export function buildPlan({ cfg, competitors, flows, slug, country, apps, now = new Date().toISOString() }) {
	const budget = {
		...cfg.research.budget,
		apps: Math.min(apps ?? cfg.research.budget.apps, cfg.research.budget.apps),
	};
	const ranked = rankApps(competitors, budget.apps);
	if (!ranked.length) {
		throw new ShipError('research plan: no competitor apps to research', {
			hint: 'run `ship aso competitors` first — the plan ranks the set it wrote',
		});
	}
	const provider = cfg.research.providers[0] ?? 'appstore';
	return {
		slug,
		createdAt: now,
		provider,
		country,
		product: { category: cfg.product.category, audience: cfg.product.audience },
		flows,
		apps: ranked,
		sorts: [...SORTS],
		budget: { ...budget, requests: requestCost(budget, ranked.length) },
		outputs: {
			references: `${slug}/references`,
			reviews: `${slug}/reviews`,
			assets: `${slug}/assets`,
			themes: `${slug}/themes.json`,
			patterns: `${slug}/patterns.json`,
			index: `${slug}/index.json`,
		},
	};
}
