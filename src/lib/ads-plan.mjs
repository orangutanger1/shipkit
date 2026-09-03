import { writeFile } from 'node:fs/promises';
import { ShipError, good, heading, info, note, step, table, warn } from '../log.mjs';
import { DASH, money, num, round2 } from './fmt.mjs';
import { metric, rowsOf } from './asc-report.mjs';
import { BID, assertBidSpread, bidFor, resolveBidding, resolveKillRule } from './asa.mjs';
import { pageForAdGroup } from './cpp.mjs';
import { brandTokens, tokenSupport, words } from './text.mjs';
import { emit } from './output.mjs';
/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./cpp.mjs').CppEntry} CppEntry */
/** @typedef {import('./util.mjs').Flags} Flags */
/** Every JSON scalar, i.e. exactly what `num` coerces. */
/** @typedef {string|number|boolean|null} Num */
/** Anything JSON.stringify can serialise; undefined-valued members are dropped. */
/** @typedef {Json|{[k: string]: WriteBody|undefined}|Array<WriteBody|undefined>} WriteBody */
/** Budget split by campaign role. */
/** @typedef {Record<string, number>} Split */
/** An app a scored term or competitors.json names. */
/** @typedef {{name?: string, seller?: string, id?: Json, ratings?: Json}} AppRef */
/** @typedef {{term?: Json, keyword?: Json, demand?: Num, competition?: Num, opportunity?: Num, medianRatings?: Num, weakAppsTop10?: Num, exactTitleMatches?: Num, volume?: Num, text?: Json, top3?: AppRef[]}} ScoredRowInput */
/** @typedef {{term?: Json, demand?: Num, competition?: Num, opportunity?: Num, medianRatings?: Num, weakAppsTop10?: Num, exactTitleMatches?: Num, top3?: AppRef[]}} ScoredRow */
/** @typedef {{term: string, demand: number, competition: number, opportunity: number, medianRatings: Num|null, weakAppsTop10: Num|null, exactTitleMatches: Num|null, top3: AppRef[]}} TermScore */
/** The id stamp `ship ads sync` records on planned objects. */
/** @typedef {JsonObject & {id: string|null, syncedAt: string}} AppleStamp */
/** @typedef {{text: string, matchType: string, bid?: number|null, apple?: AppleStamp|null}} PlannedKeyword */
/** @typedef {{slug: string, name: Json}} ProductPageRef */
/** @typedef {{name: string, defaultBidAmount: number, automatedKeywordsOptIn: boolean, keywords: PlannedKeyword[], demand?: number|null, competition?: number|null, opportunity?: number|null, medianRatings?: Num|null, weakAppsTop10?: Num|null, exactTitleMatches?: Num|null, incumbents?: {name?: Json, id: Json, ratings: Json}[], productPage?: ProductPageRef|null, status?: string, apple?: AppleStamp|null}} PlannedAdGroup */
/** @typedef {{text: Json, matchType: Json}} PlannedNegative */
/** @typedef {{role: string, name: string, dailyBudget: number, totalBudget: number, countriesOrRegions: Array<string|null>, supplySources: string[], billingEvent: string, adChannelType: string, status?: string, startTime?: Json, endTime?: Json, adGroups: PlannedAdGroup[], negativeKeywords: PlannedNegative[], rationale: string, apple?: AppleStamp|null}} PlannedCampaign */
/** @typedef {{name: string, defaultBidAmount: number, automatedKeywordsOptIn?: boolean, endTime?: string|null, status?: string|null}} AdGroupSpec */
/** @typedef {{text: string, name: Json, id: Json, ratings: Json}} Rival */
/** @typedef {{term: string, impressions: number, taps: number, installs: number, spend: number, exact: boolean, topSpend: number, campaignId: Json|null, campaignName: Json|null, adGroupId: Json|null, adGroupName: Json|null}} TermAgg */
/** One aggregated term once its CPI is known. */
/** @typedef {TermAgg & {cpi: number|null}} ScoredTerm */
/** @typedef {{term: string, matchType: string, spend: number, taps: number, impressions: number, campaignId: Json|null, campaignName: Json|null, adGroupName: Json|null, reason: string}} TermDecision */
/** @typedef {{term: string, spend: number, taps: number, impressions: number, needTaps: number, campaignName: Json|null, adGroupName: Json|null, reason: string}} HeldTerm */
/** @typedef {{term: string, matchType: string, installs: number, spend: number, cpi: number, bid: number, servedBy: Json|null, campaignId: Json|null, reason: string}} Promotion */
/** @typedef {{targetCpi: number, wasteThreshold: number, minTaps: number, killRule: KillRule, negatives: TermDecision[], held: HeldTerm[], promotions: Promotion[]}} DecideResult */
/** @typedef {{term: string, keyword: Json|null, matchType: Json|null, source: Json|null, campaignId: Json|null, campaignName: Json|null, adGroupId: Json|null, adGroupName: Json|null, impressions: number, taps: number, installs: number, spend: number, currency: Json}} SearchTermRow */
/** @typedef {{term: string, installs: number, taps: number, spend: number, cpi: number}} ConvertingTerm */
/** @typedef {ReturnType<typeof resolveBidding>} Bidding */
/** @typedef {ReturnType<typeof resolveKillRule>} KillRule */
/** What `resolveKillRule` is resolved from; its defaults type `subPrice`/`minTaps` as null-only, so the rest travels as a Json bag. */
/** @typedef {{[k: string]: Json|undefined, retentionMonths?: number}} KillOptions */
/** @typedef {{budget: number, split: Record<string, number>, top: number, minVolume: number, subPrice: number|null, retentionMonths: number, bidding: Bidding, killRule: KillRule}} PlanParams */
/** @typedef {{available: false, reason: string}|{available: true, project: string, keySource: string|null, raw: JsonObject, customers: number, trials: number, subscriptions: number, revenue: number, mrr: number, installToPaid: number|null, trialRate: number|null, ltvPerInstall: number, modelledLtv: number|null, proven: boolean, cpiCeiling: number|null, label: string, verdict: string}} MonetisationSignal */
/** @typedef {{generatedAt: string, source: string|null, locale: string, market: string, app: {name: Json, bundleId: Json|null, appId: string|number|null}, org: string|null, currency: string, params: PlanParams|null, budget: {requested: number, daily: number, monthly: number, split: Record<string, number>, ratio: Record<string, number>, derivation: string, scope: string}, targeting: {minVolume: number, considered: number, eligible: number, dropped: number, exactTerms: Json[]}, bidding: Bidding & {distinctBids: number, range: [number|null, number|null]}, monetisation: MonetisationSignal|null, campaigns: PlannedCampaign[], killRule: KillRule, syncedAt?: string|null, syncedOrg?: string|null}} PlanDoc */
/** One mining artifact as `mine` writes it and `applyMining`/`printMining` consume it. */
/** @typedef {{generatedAt: string, locale: string, org: Json|null, source: string, window: {from: string, to: string}, params: {window: {from: string, to: string}, locale: string, killRule: KillRule, campaign: Json|null}, killRule: KillRule, targetCpi: number, wasteThreshold: number, minTaps: number, rows: number, negatives: TermDecision[], held: HeldTerm[], promotions: Promotion[], converting: ConvertingTerm[], asoGap: string[], applied: AppliedMining|null}} MiningArtifact */
/** @typedef {{at: string, org: string, dryRun: boolean, negativesAdded: number, promoted: number, skipped: string[], unplaced: string[]}} AppliedMining */
/**
 * View any JSON value as an object: objects pass through, scalars and arrays
 * read as empty — exactly what property access on them would have yielded.
 * @param {Json|undefined} v
 * @returns {JsonObject}
 */
const asObj = (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});
/**
 * `num` for values that may not be scalars: non-numbers read as missing.
 * @param {Json|undefined} v
 * @param {number} [fallback]
 * @returns {number}
 */
const numOf = (v, fallback = 0) => num(v === null || typeof v !== 'object' ? v : NaN, fallback);
/** @type {Record<string, number>} */
export const SPLIT = { exact: 0.5, discovery: 0.25, competitor: 0.15, brand: 0.1 };
const ROLES = Object.keys(SPLIT);
/**
 * Turn --split into per-role daily-budget weights.
 * @param {string|boolean|null|undefined} [value]
 * @returns {Record<string, number>}
 */
export function parseSplit(value) {
	if (value === undefined || value === null || value === '' || value === true) return { ...SPLIT };
	const parts = String(value).split(/[/,;:|\s]+/).filter(Boolean);
	/** @type {Record<string, number>} */
	const out = {};
	if (parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) {
		if (parts.length > ROLES.length)
			throw new ShipError(`--split takes at most ${ROLES.length} numbers`, { hint: `order is ${ROLES.join('/')}` });
		parts.forEach((p, i) => { out[ROLES[i]] = Number(p); });
	} else
		for (const p of parts) {
			const [key, v] = p.split('=');
			const role = ROLES.find((r) => r === String(key).trim().toLowerCase());
			if (!role || !/^\d+(?:\.\d+)?$/.test(String(v ?? '').trim()))
				throw new ShipError(`--split: cannot read "${p}"`, {
					hint: `use "50/25/15/10" or "exact=50,discovery=25" — roles: ${ROLES.join(', ')}`,
				});
			out[role] = Number(v);
		}
	for (const role of ROLES) if (out[role] === undefined) out[role] = 0;
	if (!ROLES.some((role) => out[role] > 0)) throw new ShipError('--split allocates nothing to any campaign');
	return out;
}
/**
 * Split `total` across `weights` in whole cents, remainder to the biggest weight.
 * @param {number} total
 * @param {Record<string, number>} weights
 * @returns {Record<string, number>}
 */
export function allocate(total, weights) {
	const keys = Object.keys(weights).filter((k) => num(weights[k]) > 0);
	const sum = keys.reduce((s, k) => s + num(weights[k]), 0);
	const cents = Math.max(0, Math.round(num(total) * 100));
	if (!keys.length || !sum) return {};
	const biggest = keys.reduce((a, b) => (num(weights[b]) > num(weights[a]) ? b : a));
	/** @type {Record<string, number>} */
	const out = {}; let used = 0;
	for (const k of keys) {
		if (k === biggest) continue;
		const share = Math.min(cents - used, Math.round((cents * num(weights[k])) / sum));
		out[k] = share / 100;
		used += share;
	}
	out[biggest] = Math.max(0, cents - used) / 100;
	return out;
}
/** @param {Json|undefined} [name] @returns {string} */
const keywordText = (name) =>
	String(name ?? '').split(/[:|(\-–—]/)[0].replace(/\s+/g, ' ').trim().toLocaleLowerCase();
/** @param {string} name @param {number} dailyBudget @param {string} [market] */
const campaignShell = (name, dailyBudget, market) => ({
	name,
	dailyBudget: round2(dailyBudget),
	totalBudget: round2(num(dailyBudget) * 30),
	countriesOrRegions: [market ?? null], supplySources: ['APPSTORE_SEARCH_RESULTS'],
	billingEvent: 'TAPS', adChannelType: 'SEARCH',
});
/** The plan context every role spec reads. */
/** @typedef {{app: {name: Json, bundleId?: Json, appId?: string|number|null}, market: string, daily: Record<string, number>, category: TermScore[], rivals: Rival[], brand: string, exactTerms: string[], midDemand: number, priced: (demand: Num) => number}} PlanCtx */
/** @typedef {{when: (c: PlanCtx) => boolean, shell: (c: PlanCtx) => [string, number], adGroups: (c: PlanCtx) => PlannedAdGroup[], negatives: (c: PlanCtx) => PlannedNegative[], rationale: string}} RoleSpec */
/** @type {Record<string, RoleSpec>} */
const ROLES_SPEC = {
	exact: {
		when: (c) => c.daily.exact > 0,
		shell: (c) => [`${c.app.name} · Exact · ${c.market}`, c.daily.exact],
		adGroups: (c) =>
			c.category.map((t) => {
				const amount = c.priced(t.demand);
				return {
					name: `EX · ${t.term}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
					keywords: [{ text: t.term, matchType: 'EXACT', bid: amount }],
					demand: num(t.demand, 100), competition: num(t.competition), opportunity: num(t.opportunity),
					medianRatings: t.medianRatings ?? null, weakAppsTop10: t.weakAppsTop10 ?? null, exactTitleMatches: t.exactTitleMatches ?? null,
					incumbents: (t.top3 ?? []).slice(0, 3).map((a) => ({ name: a.name, id: a.id ?? null, ratings: a.ratings ?? null })),
				};
			}),
		negatives: () => [],
		rationale:
			'One ad group per keyword, for creative control: an ad group is the smallest object that can carry its own Custom Product Page and its own bid. Budget is set on the campaign — Apple has no ad-group budget.',
	},
	discovery: {
		when: (c) => c.daily.discovery > 0,
		shell: (c) => [`${c.app.name} · Discovery · ${c.market}`, c.daily.discovery],
		adGroups: (c) => {
			const amount = c.priced(c.midDemand);
			return [{
				name: `DISC · ${c.market}`, defaultBidAmount: amount, automatedKeywordsOptIn: true,
				keywords: c.exactTerms.map((text) => ({ text, matchType: 'BROAD', bid: amount })),
				demand: c.midDemand,
			}];
		},
		negatives: (c) => {
			const negativeKeywords = c.exactTerms.map((text) => ({ text, matchType: 'EXACT' }));
			if (c.brand && !c.exactTerms.includes(c.brand)) negativeKeywords.push({ text: c.brand, matchType: 'EXACT' });
			return negativeKeywords;
		},
		rationale:
			'Broad match plus Search Match, with every Exact term negated so the two cannot cannibalise each other.',
	},
	competitor: {
		when: (c) => c.daily.competitor > 0 && c.rivals.length > 0,
		shell: (c) => [`${c.app.name} · Competitor · ${c.market}`, c.daily.competitor],
		adGroups: (c) =>
			c.rivals.map((r) => {
				const amount = c.priced(c.midDemand);
				return {
					name: `COMP · ${r.text}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
					keywords: [{ text: r.text, matchType: 'EXACT', bid: amount }],
					demand: c.midDemand,
					incumbents: [{ name: r.name, id: r.id, ratings: r.ratings }],
				};
			}),
		negatives: (c) => (c.brand ? [{ text: c.brand, matchType: 'EXACT' }] : []),
		rationale:
			'Exact match on the apps you are compared to; your own name is negated here so Brand keeps that traffic at its own price.',
	},
	brand: {
		when: (c) => c.daily.brand > 0 && Boolean(c.brand),
		shell: (c) => [`${c.app.name} · Brand · ${c.market}`, c.daily.brand],
		adGroups: (c) => {
			const amount = c.priced(100);
			return [{
				name: `BRAND · ${c.brand}`, defaultBidAmount: amount, automatedKeywordsOptIn: false,
				keywords: [
					{ text: c.brand, matchType: 'EXACT', bid: amount }, { text: c.brand, matchType: 'BROAD', bid: amount },
				],
				demand: 100,
			}];
		},
		negatives: () => [],
		rationale: 'Your own name is the cheapest tap you will ever buy, and the one a competitor buys if you do not.',
	},
};
/**
 * Rival candidates: configured competitors plus picked terms that look branded.
 * @param {{brand: string, competitors: AppRef[], picked: TermScore[], branded: (text: string) => boolean}} opts
 * @returns {Rival[]}
 */
const collectRivals = ({ brand, competitors, picked, branded }) => {
	const rivals = [], seen = new Set(brand ? [brand] : []);
	for (const rival of [...competitors, ...picked.filter((t) => branded(t.term)).map((t) => ({ name: t.term, id: null, ratings: null }))]) {
		const text = keywordText(rival?.name);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		rivals.push({ text, name: rival.name ?? text, id: rival.id ?? null, ratings: rival.ratings ?? null });
	}
	return rivals;
};
/**
 * @param {PlannedCampaign[]} campaigns
 * @param {CppEntry[]} pages
 * @returns {void}
 */
const attachProductPages = (campaigns, pages) => {
	for (const cp of campaigns)
		for (const g of cp.adGroups) {
			const entry = pageForAdGroup(pages, g.name);
			if (entry) g.productPage = { slug: entry.slug, name: entry.page?.name ?? entry.slug };
		}
};
/**
 * Build the four-campaign plan from scored terms, competitors and pages.
 * @param {{
 *   app: {name: Json, bundleId?: Json, appId?: string|number|null},
 *   locale?: string, market?: string,
 *   terms?: TermScore[], competitors?: AppRef[], pages?: CppEntry[],
 *   budget?: number, split?: Record<string, number>, top?: number,
 *   subPrice?: number|null, targetCpi?: Num,
 *   retentionMonths?: number, baselineInstallRate?: number, minTaps?: Num,
 *   bid?: Num, minBid?: Num, maxBid?: Num,
 *   observedCpt?: number|null, seedBid?: number|null,
 *   monetisation?: MonetisationSignal|null, minVolume?: number, org?: string|null,
 *   source?: string|null, params?: PlanParams|null, generatedAt?: string,
 * }} opts
 * @returns {PlanDoc}
 */
export function buildPlan({
	app, locale = 'en-US', market = 'US', terms = [], competitors = [], pages = [],
	budget = 10, split = SPLIT, top = 15, subPrice = null, targetCpi = null,
	retentionMonths = 1, baselineInstallRate = undefined, minTaps = null, bid = null,
	minBid = null, maxBid = null, observedCpt = null, seedBid = null,
	monetisation: money$ = null, minVolume = 0, org = null, source = null,
	params = null, generatedAt = new Date().toISOString(),
}) {
	const brand = keywordText(app?.name);
	const eligible = terms.filter((t) => num(t.demand, 100) >= num(minVolume));
	const picked = [...eligible]
		.sort((a, b) => num(b.opportunity) - num(a.opportunity) || String(a.term).localeCompare(String(b.term)))
		.slice(0, Math.max(1, num(top, 15)));
	if (!picked.length)
		throw new ShipError(`no scored term clears aso.minVolume ${num(minVolume)}`, {
			hint: `${terms.length} scored term(s), all under the floor — a term nobody searches is not worth bidding on, so either lower aso.minVolume or run \`ship aso volume --locale ${locale}\` so demand is measured rather than guessed`,
		});
	const bidding = resolveBidding({
		bid: num(bid) || undefined, minBid: num(minBid) || undefined, maxBid: num(maxBid) || undefined,
		observedCpt: observedCpt ?? undefined, seedBid: seedBid ?? undefined,
	});
	/** @type {KillOptions} */
	const killOpts = { targetCpi, subPrice, retentionMonths, baselineInstallRate, minTaps };
	const killRule = resolveKillRule(killOpts);
	/** @type {ReturnType<typeof bidFor>[]} */
	const bids = [];
	/** @param {Num} demand @returns {number} */
	const priced = (demand) => {
		const b = bidFor(demand, bidding);
		bids.push(b);
		return b.amount;
	};
	const brandWords = brandTokens(terms.flatMap((t) => (t.top3 ?? []).map((a) => ({ name: a.name, seller: a.seller }))), locale);
	const support = tokenSupport(terms.map((t) => t.term), locale);
	const brandFloor = Math.max(3, Math.ceil(Math.max(0, ...support.values()) / 4));
	/** @param {string} text @returns {boolean} */
	const branded = (text) => words(text, locale).some((w) => brandWords.has(w) && (support.get(w) ?? 0) < brandFloor);
	const rivals = collectRivals({ brand, competitors, picked, branded });
	const category = picked.filter((t) => !branded(t.term));
	const weights = { ...SPLIT, ...split };
	if (!rivals.length) weights.competitor = 0;
	if (!brand) weights.brand = 0;
	if (!category.length) weights.exact = 0;
	const daily = allocate(budget, weights);
	const exactTerms = [...new Set(category.map((t) => t.term))];
	const demands = category.map((t) => num(t.demand, 100)).sort((a, b) => a - b);
	const midDemand = demands.length ? demands[Math.floor(demands.length / 2)] : 100;
	const ctx = { app, market, daily, category, rivals, brand, exactTerms, midDemand, priced };
	/** @type {PlannedCampaign[]} */
	const campaigns = ROLES.map((role) => {
		const spec = ROLES_SPEC[role];
		if (!spec.when(ctx)) return null;
		return {
			role,
			...campaignShell(...spec.shell(ctx)),
			adGroups: spec.adGroups(ctx),
			negativeKeywords: spec.negatives(ctx),
			rationale: spec.rationale,
		};
	}).filter((cp) => cp !== null);
	assertBidSpread(bids, bidding);
	attachProductPages(campaigns, pages);
	const spread = [...new Set(bids.map((b) => b.amount))].sort((a, b) => a - b);
	return {
		generatedAt, source, locale, market,
		app: { name: app.name, bundleId: app.bundleId ?? null, appId: app.appId ?? null },
		org, currency: 'USD',
		params: params ?? {
			budget: round2(budget), split: weights, top: num(top, 15), minVolume: num(minVolume),
			subPrice: subPrice === null ? null : round2(subPrice), retentionMonths: killRule.retentionMonths,
			bidding, killRule,
		},
		budget: {
			requested: round2(budget),
			daily: round2(campaigns.reduce((s, cp) => s + cp.dailyBudget, 0)),
			monthly: round2(campaigns.reduce((s, cp) => s + cp.totalBudget, 0)),
			split: Object.fromEntries(campaigns.map((cp) => [cp.role, cp.dailyBudget])),
			ratio: weights,
			derivation: `default ${ROLES.map((r) => Math.round(SPLIT[r] * 100)).join('/')} ${ROLES.join('/')}, overridable with --split; a skipped campaign redistributes its share`,
			scope: 'campaign — Apple Search Ads has no ad-group budget',
		},
		targeting: {
			minVolume: num(minVolume), considered: terms.length, eligible: eligible.length,
			dropped: terms.length - eligible.length, exactTerms,
		},
		bidding: { ...bidding, distinctBids: spread.length, range: [spread[0] ?? null, spread.at(-1) ?? null] },
		monetisation: money$, campaigns, killRule,
	};
}
/**
 * Apple object ids recorded in a plan document, for the --force guard.
 * @param {PlanDoc|null|undefined} [doc]
 * @returns {{bound: boolean, objects: number, syncedAt: string|null}}
 */
export function planBindings(doc) {
	/** @type {string[]} */
	const ids = [];
	/** @type {string|null} */
	let syncedAt = null;
	/** @param {Json|undefined} node */
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) return void node.forEach(visit);
		const apple = node.apple;
		if (apple && typeof apple === 'object' && !Array.isArray(apple) && apple.id) {
			ids.push(String(apple.id));
			const t = apple.syncedAt ?? null;
			if (t && (syncedAt === null || String(t) > syncedAt)) syncedAt = String(t);
		}
		for (const v of Object.values(node)) visit(v);
	};
	visit(doc?.campaigns ?? null);
	return { bound: ids.length > 0, objects: ids.length, syncedAt };
}
/**
 * @param {PlanDoc|null|undefined} [p]
 * @returns {{daily: number, split: Record<string, number>, bids: number[], stamped: {daily: number|null, distinctBids: number|null}, drifted: boolean}}
 */
export function planTotals(p) {
	const campaigns = p?.campaigns ?? [];
	/** @type {Record<string, number>} */
	const split = {};
	let daily = 0;
	for (const cp of campaigns) {
		const b = num(cp.dailyBudget);
		daily = Math.round((daily + b) * 100) / 100;
		split[cp.role ?? cp.name] = b;
	}
	const bids = [...new Set(campaigns.flatMap((cp) => (cp.adGroups ?? []).map((g) => num(g.defaultBidAmount))).filter((n) => n > 0))].sort(
		(a, b) => a - b,
	);
	const stamped = { daily: p?.budget?.daily ?? null, distinctBids: p?.bidding?.distinctBids ?? null };
	return {
		daily, split, bids, stamped,
		drifted: stamped.daily !== null && Math.abs(num(stamped.daily) - daily) > 0.005,
	};
}
/**
 * Render a plan document to the markdown the repo keeps beside it.
 * @param {PlanDoc} p
 * @param {{renderedAt?: string|null}} [opts]
 * @returns {string}
 */
export function renderPlan(p, { renderedAt = null } = {}) {
	/** @type {string[]} */
	const L = [];
	const bound = planBindings(p);
	const t = planTotals(p);
	L.push(`# Apple Search Ads plan — ${p.app.name}`, '');
	L.push(`Generated ${p.generatedAt}${p.source ? ` from \`${p.source}\`` : ''}.`, '');
	if (renderedAt) L.push(`Re-rendered ${renderedAt} from \`campaign-plan.json\` — \`ship ads plan --render\`.`, '');
	if (bound.bound)
		L.push(
			`This plan is **bound to a live account**: ${bound.objects} Apple object id(s) recorded by ` +
				`\`ship ads sync\`${bound.syncedAt ? `, last at ${bound.syncedAt}` : ''}. Hand-set bids, pruned ad groups and keywords ` +
				'outside the ASO set exist **only** in `campaign-plan.json`, so `ship ads plan` refuses to overwrite it without ' +
				'`--force`. To refresh this document alone, use `ship ads plan --render`.',
			'',
		);
	L.push(`- **Market**: ${p.market} (locale ${p.locale})`);
	L.push(`- **Daily budget**: ${money(t.daily)} across ${p.campaigns.length} campaigns — ${p.budget.scope}`);
	L.push(
		`- **Split**: ${Object.entries(t.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}${t.drifted ? '' : ` — ${p.budget.derivation}`}`,
	);
	L.push(
		`- **Bids**: ${t.bids.length === 0 ? '—' : t.bids.length === 1 ? money(t.bids[0]) : `${money(t.bids[0])}–${money(t.bids[t.bids.length - 1])}`}` +
			` — ${t.bids.length} distinct bid(s)${t.drifted ? '' : ` · ${p.bidding.derivation}`}`,
	);
	if (t.drifted)
		L.push(
			`- **Stamped parameters are historical**: this plan was generated for ${money(t.stamped.daily)}/day ` +
				`with bids \`${p.bidding.derivation}\`, and has since been changed by hand or adopted from the account. Every ` +
				'number above and below is read from the campaigns, which is what `ship ads sync` pushes; `params` in ' +
				'`campaign-plan.json` records the run that first created them and is not re-derived.',
		);
	L.push(
		`- **Demand floor**: aso.minVolume ${p.targeting.minVolume}${p.targeting.dropped ? ` — dropped ${p.targeting.dropped} of ${p.targeting.considered} scored terms as not worth bidding on` : ''}`,
	);
	if (p.monetisation)
		L.push(`- **What an install is worth**: ${p.monetisation.available ? p.monetisation.verdict : `unknown — ${p.monetisation.reason}`}`);
	L.push('', '## Kill rule', '', `\`${p.killRule.condition}\` → **pause the keyword**.`, '');
	L.push(p.killRule.derivation, '');
	L.push(
		`Concretely: negate a keyword once it has taken at least ${p.killRule.minTaps} taps and spent more than ` +
			`${money(p.killRule.wasteThreshold)} without an install. Both conditions, not either: at ` +
			`${Math.round(p.killRule.baselineInstallRate * 100)}% tap→install, three taps produce nothing 22% of the time, so a ` +
			'spend threshold alone negates healthy keywords. `ship ads mine` applies exactly this rule from the search-term ' +
			'report and stamps these numbers into every artifact.',
		'',
	);
	for (const cp of p.campaigns) {
		L.push(`## ${cp.name}`, '', cp.rationale, '');
		L.push(
			`${money(cp.dailyBudget)}/day (${money(cp.totalBudget)} over 30 days) · ${cp.countriesOrRegions.join(', ')} · ${cp.adGroups.length} ad group(s)`,
			'',
		);
		L.push('| ad group | keywords | demand | bid | product page | incumbents |', '| --- | --- | ---: | ---: | --- | --- |');
		for (const g of cp.adGroups) {
			const inc = (g.incumbents ?? []).map((a) => `${a.name}${a.ratings == null ? '' : ` (${a.ratings})`}`).join('<br>');
			const kw = g.keywords.map((k) => `${k.text} \`${k.matchType}\` ${money(k.bid)}`).join('<br>');
			L.push(
				`| ${g.name} | ${kw} | ${g.demand ?? '—'} | ${money(g.defaultBidAmount)} | ${g.productPage?.name ?? '—'} | ${inc || '—'} |`,
			);
		}
		if (cp.negativeKeywords.length)
			L.push('', `Negatives: ${cp.negativeKeywords.map((k) => `\`${k.text}\` (${k.matchType})`).join(', ')}`);
		L.push('');
	}
	L.push('Sanity-check each bid against the incumbents: a keyword whose top 3 are 50k-rating');
	L.push('apps will not convert at any bid you can afford, however high its opportunity score.', '');
	L.push('This file is **desired state**. What is live is in `snapshot.json` (`ship ads snapshot`);');
	L.push('`ship ads sync` reconciles the two by Apple object id and prints every transition first.', '');
	L.push('Push with `ship ads sync` (dry-run first: `ship ads sync --dry-run`), then close the loop');
	L.push('with `ship ads mine`, which turns the search-term report back into keywords.', '');
	return L.join('\n');
}
/**
 * Flatten an Apple search-term report into the rows `decide`/`convertingTerms` read.
 * @param {Json|undefined} [payload]
 * @returns {SearchTermRow[]}
 */
export function searchTermRows(payload) {
	const body = asObj(payload);
	const raw =
		asObj(asObj(body.data).reportingDataResponse).row ?? asObj(body.reportingDataResponse).row ??
		(Array.isArray(body.rows) ? body.rows : rowsOf(payload, { allowSingle: false }));
	return (Array.isArray(raw) ? raw : [])
		.map((r) => {
			const row = asObj(r);
			const m = asObj(row.metadata ?? row), t = asObj(row.total ?? (Array.isArray(row.granularity) ? row.granularity[0] : undefined) ?? m);
			return {
				term: String(m.searchTermText ?? m.searchTerm ?? m.text ?? '').trim().toLocaleLowerCase(),
				keyword: m.keyword ?? null, matchType: m.matchType ?? null, source: m.searchTermSource ?? null,
				campaignId: m.campaignId ?? null, campaignName: m.campaignName ?? null,
				adGroupId: m.adGroupId ?? null, adGroupName: m.adGroupName ?? null,
				impressions: numOf(t.impressions), taps: numOf(t.taps),
				installs: numOf(t.installs ?? numOf(t.newDownloads) + numOf(t.redownloads)),
				spend: metric(t.localSpend), currency: asObj(t.localSpend).currency ?? 'USD',
			};
		})
		.filter((r) => r.term);
}
/**
 * Apply the kill rule and CPI target to aggregated search-term rows.
 * @param {SearchTermRow[]|null|undefined} [rows]
 * @param {KillOptions} [opts]
 * @returns {DecideResult}
 */
export function decide(rows, opts = {}) {
	const rule = resolveKillRule(opts);
	const { targetCpi: cpi, wasteThreshold, minTaps } = rule;
	/** @type {Map<string, TermAgg>} */
	const agg = new Map();
	for (const r of rows ?? []) {
		const term = String(r?.term ?? '').trim().toLocaleLowerCase();
		if (!term) continue;
		const e = agg.get(term) ?? {
			term, impressions: 0, taps: 0, installs: 0, spend: 0, exact: false, topSpend: -1,
			campaignId: null, campaignName: null, adGroupId: null, adGroupName: null,
		};
		e.impressions += num(r.impressions); e.taps += num(r.taps);
		e.installs += num(r.installs); e.spend += num(r.spend);
		if (String(r.matchType ?? '').toUpperCase() === 'EXACT') e.exact = true;
		if (num(r.spend) > e.topSpend) {
			e.topSpend = num(r.spend);
			e.campaignId = r.campaignId ?? null; e.campaignName = r.campaignName ?? null;
			e.adGroupId = r.adGroupId ?? null; e.adGroupName = r.adGroupName ?? null;
		}
		agg.set(term, e);
	}
	const terms = [...agg.values()].map((e) => ({
		...e, spend: round2(e.spend), cpi: e.installs ? round2(e.spend / e.installs) : null,
	}));
	/** @param {ScoredTerm} e @returns {string} */
	const evidence = (e) => `${money(e.spend)} over ${e.taps} tap(s) and ${e.impressions} impression(s) for zero installs`;
	const spent = terms.filter((e) => e.installs === 0 && e.spend > wasteThreshold);
	/** @param {{spend: number, term: string}} a @param {{spend: number, term: string}} b @returns {number} */
	const bySpend = (a, b) => b.spend - a.spend || a.term.localeCompare(b.term);
	const negatives = spent
		.filter((e) => e.taps >= minTaps)
		.sort(bySpend)
		.map((e) => ({
			term: e.term, matchType: 'EXACT', spend: e.spend, taps: e.taps, impressions: e.impressions,
			campaignId: e.campaignId, campaignName: e.campaignName, adGroupName: e.adGroupName,
			reason: `${evidence(e)} — past the ${money(wasteThreshold)} waste line and past ${minTaps} taps, so zero is a verdict`,
		}));
	const held = spent
		.filter((e) => e.taps < minTaps)
		.sort(bySpend)
		.map((e) => ({
			term: e.term, spend: e.spend, taps: e.taps, impressions: e.impressions, needTaps: minTaps,
			campaignName: e.campaignName, adGroupName: e.adGroupName,
			reason:
				`${evidence(e)}, but ${e.taps} tap(s) is under the ${minTaps} needed before zero installs means anything: ` +
				`a keyword converting at ${Math.round(rule.baselineInstallRate * 100)}% shows nothing this often by chance`,
		}));
	/**
	 * Converted under the target on broad or Search Match; installs > 0 means cpi is set.
	 * @param {ScoredTerm} e
	 * @returns {e is TermAgg & {cpi: number}}
	 */
	const promotes = (e) => e.installs > 0 && e.cpi !== null && e.cpi <= cpi && !e.exact;
	const promotions = terms
		.filter(promotes)
		.sort((a, b) => a.cpi - b.cpi || b.installs - a.installs || a.term.localeCompare(b.term))
		.map((e) => ({
			term: e.term, matchType: 'EXACT', installs: e.installs, spend: e.spend, cpi: e.cpi,
			bid: round2(Math.min(BID.ceiling, Math.max(BID.floor, e.cpi))),
			servedBy: e.adGroupName ?? e.campaignName ?? null, campaignId: e.campaignId,
			reason: `${e.installs} install(s) at ${money(e.cpi)} CPI, under the ${money(cpi)} target, on broad or Search Match — own the bid`,
		}));
	return { targetCpi: cpi, wasteThreshold, minTaps, killRule: rule, negatives, held, promotions };
}
/**
 * @param {SearchTermRow[]|null|undefined} [rows]
 * @returns {ConvertingTerm[]}
 */
export function convertingTerms(rows) {
	/** @type {Map<string, {term: string, installs: number, taps: number, spend: number}>} */
	const agg = new Map();
	for (const r of rows ?? []) {
		const term = String(r?.term ?? '').toLocaleLowerCase();
		if (!term) continue;
		const e = agg.get(term) ?? { term, installs: 0, taps: 0, spend: 0 };
		e.installs += num(r.installs);
		e.taps += num(r.taps);
		e.spend += num(r.spend);
		agg.set(term, e);
	}
	return [...agg.values()]
		.filter((e) => e.installs > 0)
		.map((e) => ({ term: e.term, installs: e.installs, taps: e.taps, spend: round2(e.spend), cpi: round2(e.spend / e.installs) }))
		.sort((a, b) => b.installs - a.installs || a.term.localeCompare(b.term));
}
/**
 * Re-render campaign-plan.md from the plan already on disk.
 * @param {{cfg: Config, flags: Flags, planFile: string, mdFile: string, onDisk: PlanDoc|null}} opts
 * @returns {Promise<number>}
 */
export async function renderOnly({ cfg, flags, planFile, mdFile, onDisk }) {
	if (!onDisk)
		throw new ShipError(`no plan to render: ${planFile}`, {
			hint: 'run `ship ads plan` first — --render re-renders campaign-plan.md from an existing campaign-plan.json, it does not build one',
		});
	const renderedAt = new Date().toISOString();
	await writeFile(mdFile, renderPlan(onDisk, { renderedAt }));
	const bound = planBindings(onDisk);
	const t = planTotals(onDisk);
	if (flags.json) return emit({ rendered: mdFile, from: planFile, generatedAt: onDisk.generatedAt, renderedAt, ...bound, totals: t });
	heading(`Render · ${cfg.name}`);
	good(`wrote ${mdFile} from ${planFile}`);
	note(`plan generated ${onDisk.generatedAt} — unchanged; only the document was rewritten`);
	info(
		`${money(t.daily)}/day across ${onDisk.campaigns.length} campaigns · ${Object.entries(t.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}`,
	);
	if (t.drifted)
		note(`stamped params say ${money(t.stamped.daily)}/day — historical, and not re-derived: the campaigns are what \`ship ads sync\` pushes`);
	if (bound.bound)
		note(`${bound.objects} Apple object id(s) in this plan${bound.syncedAt ? ` (last synced ${bound.syncedAt})` : ''} — \`ship ads sync --dry-run\` diffs it against the account`);
	return 0;
}
/**
 * @param {PlanDoc} out
 * @param {{name: string, jsonFile: string, mdFile: string, backup: string|null, bound: {bound: boolean, objects: number, syncedAt: string|null}, measured: {cpt: number|null, reason: string|null}, money$: MonetisationSignal, competitors: AppRef[], locale: string, bid?: Json}} ctx
 * @returns {void}
 */
export function printPlan(out, ctx) {
	const { name, jsonFile, mdFile, backup, bound, measured, competitors, locale } = ctx;
	heading(`Campaign plan · ${name} · ${out.market}`);
	info(
		`${money(out.budget.daily)}/day across ${out.campaigns.length} campaigns · ${Object.entries(out.budget.split).map(([role, v]) => `${role} ${money(v)}`).join(' · ')}`,
	);
	note(out.budget.scope);
	if (backup) {
		warn(`replanned over a plan bound to ${bound.objects} live Apple object(s) — every Apple id, hand-set bid and pruned ad group in it is gone from campaign-plan.json`);
		note(`previous plan kept at ${backup} · \`ship ads sync --dry-run\` before pushing, or --adopt to take the live values back`);
	}
	info(`bids: ${out.bidding.derivation}`);
	if (measured.cpt === null && !ctx.bid)
		note(`no realised cost per tap yet (${measured.reason}) — seeded at ${money(out.bidding.seed)}, override with --bid`);
	if (!competitors.length)
		note(`no aso/${locale}/competitors.json — Competitor campaign skipped, its budget went to the rest (\`ship aso competitors --locale ${locale}\`)`);
	if (out.targeting.dropped)
		note(`${out.targeting.dropped} scored term(s) under aso.minVolume ${out.targeting.minVolume} are not worth bidding on`);
	for (const cp of out.campaigns) {
		process.stdout.write('\n');
		step(`${cp.name} · ${money(cp.dailyBudget)}/day · ${cp.adGroups.length} ad group(s)${cp.negativeKeywords.length ? ` · ${cp.negativeKeywords.length} negative(s)` : ''}`);
		table(cp.adGroups, [
			{ header: 'ad group', get: (g) => g.name },
			{ header: 'keywords', get: (g) => g.keywords.map((k) => `${k.text} ${k.matchType.toLowerCase()}`).join(', ') },
			{ header: 'demand', get: (g) => (g.demand == null ? DASH : String(Math.round(g.demand))) },
			{ header: 'bid', get: (g) => money(g.defaultBidAmount) },
			{ header: 'page', get: (g) => g.productPage?.name ?? '' },
		]);
	}
	process.stdout.write('\n');
	info(`kill rule: ${out.killRule.condition} (source: ${out.killRule.source})`);
	good(`wrote ${jsonFile}`);
	good(`wrote ${mdFile}`);
	note('review it, then `ship ads sync --dry-run` once credentials exist');
}
