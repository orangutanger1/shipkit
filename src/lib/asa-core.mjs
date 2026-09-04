// Apple Search Ads decision core: bids, the kill rule, observed-state
// normalisation, and monetisation. Reconciliation lives in asa-reconcile.mjs.
//
// Everything in this file is pure. `ship ads` spends real money through it, so
// the parts that decide *how much* live apart from the parts that talk to Apple:
// a bid model you cannot test at its thresholds is a bid model you learn about
// from a billing statement.
//
// Four facts about the platform shape the whole file.
//
//  1. **There is no ad-group budget.** `dailyBudgetAmount` exists on the campaign
//     and nowhere else. Any structure justified by "each ad group owns its
//     budget" is justified by a field Apple does not have. One ad group per
//     keyword is defensible on *creative* control — an ad group is the smallest
//     unit that can carry its own Custom Product Page — and on nothing else.
//  2. **A bid is a price in an auction, not a share of a budget.** Deriving it
//     from budget ÷ assumed-taps produces a number unrelated to what a tap
//     costs, and at small budgets it lands every keyword on Apple's $0.30 floor:
//     one identical bid, an inert opportunity model, and no impressions. Bids
//     here start from an observed cost-per-tap where one exists.
//  3. **Objects are identified by id.** A name is a label a human edits. Match
//     by name and one rename orphans every object you have already paid to
//     learn about — the old ones get paused as "unplanned", the new ones start
//     from zero.
//  4. **Zero installs over three taps is not evidence.** A spend threshold alone
//     negates healthy keywords: at a 40% tap→install rate, three taps produce no
//     install 22% of the time. A kill rule needs a sample size, not just a bill.
import { ShipError } from '../log.mjs';
import { clamp100, money, num, round2 } from './fmt.mjs';
import { strOrNull } from './util.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */

/** The resolved bid model for one plan run: the numbers and where they came from. */
/** @typedef {{seed: number, min: number, max: number, source: string, observedCpt: number|null, derivation: string}} Bidding */
/** One keyword's resolved bid: what the model derived and whether the clamp fired. */
/** @typedef {{amount: number, raw: number, clamped: boolean}} PlannedBid */
/** One kill-rule threshold, stamped onto every artifact that applies it. */
/** @typedef {{targetCpi: number, source: string, wasteThreshold: number, minTaps: number, baselineInstallRate: number, confidence: number, breakeven: number|null, retentionMonths: number, condition: string, derivation: string}} KillRule */
/** Observed campaign: what `snapshot` writes and `reconcile` reads. */
/** @typedef {{id: string|null, name: string|null, status: string|null, displayStatus: string|null, dailyBudget: number|null, countriesOrRegions: Json, modificationTime: string|null, adGroups: LiveAdGroup[], negativeKeywords: LiveKeyword[]}} LiveCampaign */
/** @typedef {{id: string|null, name: string|null, status: string|null, displayStatus: string|null, defaultBidAmount: number|null, automatedKeywordsOptIn: boolean, modificationTime: string|null, keywords: LiveKeyword[]}} LiveAdGroup */
/** @typedef {{id: string|null, text: string|null, matchType: string|null, status: string|null, bidAmount: number|null, modificationTime: string|null}} LiveKeyword */

/**
 * @param {number|null|undefined} v
 * @returns {number|null}
 */
const pos = (v) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : null;
};

// ─── bids ────────────────────────────────────────────────────────────────────

/**
 * Apple's own floor is $0.30. `seed` is deliberately not that: the floor is the
 * price at which you are outbid by everybody, so seeding there is the same as
 * not running. $0.60 is a starting guess for a US search auction, to be replaced
 * by the account's realised CPT the moment there is one.
 */
export const BID = { floor: 0.3, ceiling: 2.0, seed: 0.6 };

/** A term everybody types is a term everybody bids on: demand 0 → 0.75×, 100 → 1.25×. */
/**
 * @param {string|number|boolean|null|undefined} demand
 * @returns {number}
 */
const demandFactor = (demand) => 0.75 + clamp100(demand) / 200;

/**
 * Resolve one bid model for a whole plan, from the most trustworthy source that
 * exists. Precedence is explicit human > observed market > configured seed >
 * built-in seed, and the answer carries its own provenance so the plan can say
 * where its prices came from instead of asserting a formula.
 *
 * @param {{bid?: number|null, minBid?: number|null, maxBid?: number|null, observedCpt?: number|null, seedBid?: number|null}} [opts]
 * @returns {Bidding}
 */
export function resolveBidding({ bid, minBid, maxBid, observedCpt, seedBid } = {}) {
	const explicit = pos(bid);
	const observed = pos(observedCpt);
	const configured = pos(seedBid);
	const seed = explicit ?? observed ?? configured ?? BID.seed;
	const source = explicit
		? '--bid'
		: observed
			? 'realised CPT'
			: configured
				? 'ads.seedBid'
				: 'default seed';
	const min = pos(minBid) ?? BID.floor;
	// A human who bids $3.00 means it; the ceiling exists to catch typos and
	// runaway derivations, not to override an explicit instruction.
	const max = pos(maxBid) ?? Math.max(BID.ceiling, round2(seed * 2));
	if (min > max)
		throw new ShipError(`--min-bid ${money(min)} is above the bid ceiling ${money(max)}`, {
			hint: 'raise --max-bid, or lower --min-bid',
		});
	if (min < BID.floor)
		throw new ShipError(`--min-bid ${money(min)} is under Apple's ${money(BID.floor)} minimum`, {
			hint: 'Apple rejects a bid below $0.30 outright',
		});
	return {
		seed: round2(seed),
		min: round2(min),
		max: round2(max),
		source,
		observedCpt: observed === null ? null : round2(observed),
		derivation: `${money(seed)} (${source}) × (0.75 + demand/200), clamped to [${money(min)}, ${money(max)}]`,
	};
}

/**
 * One keyword's bid. Returns whether the clamp fired, because a plan where the
 * clamp fired for *every* keyword is a plan whose model did nothing.
 *
 * @param {string|number|boolean|null|undefined} demand
 * @param {Bidding} bidding
 * @returns {PlannedBid}
 */
export function bidFor(demand, bidding) {
	const raw = round2(num(bidding.seed) * demandFactor(demand));
	const amount = round2(Math.min(bidding.max, Math.max(bidding.min, raw)));
	return { amount, raw, clamped: amount !== raw };
}

/**
 * Refuse a plan in which the opportunity model had no effect on a single price.
 * This is the exact failure that put 15 keywords on an identical $0.30 bid: the
 * derivation ran, every result was clamped, and the plan looked deliberate.
 *
 * @param {(PlannedBid|null|undefined)[]} bids
 * @param {Bidding} bidding
 * @returns {void}
 */
export function assertBidSpread(bids, bidding) {
	const list = bids.filter(/** @param {PlannedBid|null|undefined} b @returns {b is PlannedBid} */ (b) => Boolean(b));
	if (!list.length || list.some((b) => !b.clamped)) return;
	const at = list[0].amount;
	throw new ShipError(
		`every bid in this plan clamped to ${money(at)} — the demand model had no effect on any price`,
		{
			hint:
				`the ${money(bidding.seed)} seed (${bidding.source}) derives ${money(list[0].raw)} before clamping to ` +
				`[${money(bidding.min)}, ${money(bidding.max)}]. Pass --bid <n> with a bid that clears the auction ` +
				'(your realised CPT, from `ship ads report`), or widen --min-bid/--max-bid.',
		},
	);
}

// ─── the kill rule ───────────────────────────────────────────────────────────

/** Tap→install rate below which a keyword was never going to work anyway. */
const BASELINE_INSTALL_RATE = 0.4;
/** How sure we insist on being that "zero installs" means "will not convert". */
const KILL_CONFIDENCE = 0.95;

/**
 * Taps needed before zero installs is evidence rather than noise.
 * P(0 installs | n taps) = (1 - rate)^n, so n = ln(1 - confidence) / ln(1 - rate).
 * At a 40% rate and 95% confidence that is 6 taps; at 3 taps a perfectly healthy
 * keyword shows nothing 22% of the time, which is how a weekly cycle silently
 * negates two keywords out of nine.
 *
 * @param {number|null|undefined} [rate=BASELINE_INSTALL_RATE]
 * @param {number|null|undefined} [confidence=KILL_CONFIDENCE]
 * @returns {number}
 */
export function tapsForConfidence(rate = BASELINE_INSTALL_RATE, confidence = KILL_CONFIDENCE) {
	const r = Math.min(0.999, Math.max(0.001, num(rate, BASELINE_INSTALL_RATE)));
	const conf = Math.min(0.999, Math.max(0.5, num(confidence, KILL_CONFIDENCE)));
	return Math.max(1, Math.ceil(Math.log(1 - conf) / Math.log(1 - r)));
}

/**
 * One threshold, resolved once, carrying its own provenance. Every artifact that
 * applies the rule stamps this object, so a mining file can never disagree with
 * the config that produced it — the three-way disagreement between config
 * ($1.40), plan document ($2.99) and committed artifact ($29.98) was possible
 * only because each recomputed the number from a different input.
 *
 * @param {{targetCpi?: number|null, subPrice?: number|null, retentionMonths?: number, baselineInstallRate?: number|null, minTaps?: number|null, confidence?: number|null, source?: string}} [opts]
 * @returns {KillRule}
 */
export function resolveKillRule({
	targetCpi,
	subPrice = null,
	retentionMonths = 1,
	baselineInstallRate = BASELINE_INSTALL_RATE,
	minTaps = null,
	confidence = KILL_CONFIDENCE,
	source = 'ads.targetCpi',
} = {}) {
	const cpi = pos(targetCpi);
	if (!cpi)
		throw new ShipError('no target CPI to decide against', {
			hint: 'set ads.targetCpi in ship.config.json, or pass --target-cpi <n>. `ship ads report` prints the CPI you are actually paying.',
		});
	const rate = Math.min(0.999, Math.max(0.001, num(baselineInstallRate, BASELINE_INSTALL_RATE)));
	const taps = pos(minTaps) ?? tapsForConfidence(rate, confidence);
	const months = Math.max(1, num(retentionMonths, 1));
	const breakeven = pos(subPrice) === null ? null : round2(num(subPrice) * months);
	return {
		targetCpi: round2(cpi),
		source,
		wasteThreshold: round2(2 * cpi),
		minTaps: taps,
		baselineInstallRate: rate,
		confidence: Math.min(0.999, Math.max(0.5, num(confidence, KILL_CONFIDENCE))),
		breakeven,
		retentionMonths: months,
		condition: `installs === 0 AND taps >= ${taps} AND spend > ${money(2 * cpi)}`,
		derivation:
			`waste line = 2 × target CPI ${money(cpi)}; ${taps} taps is the sample size at which a ` +
			`${Math.round(rate * 100)}% tap→install keyword would have converted with ` +
			`${Math.round(num(confidence, KILL_CONFIDENCE) * 100)}% probability`,
	};
}

/**
 * Config coherence. `targetCpi` and `subPrice` are independently settable into
 * contradiction, and a target CPI above everything a subscriber will ever pay is
 * not a target — it is a decision to lose money, made by arithmetic nobody read.
 * @param {{targetCpi?: number|null, subPrice?: number|null, retentionMonths?: number|null, seedBid?: number|null}} [ads]
 * @returns {{errors: string[], warnings: string[]}}
 */
export function checkAdsConfig(ads = {}) {
	const errors = [];
	const warnings = [];
	const cpi = pos(ads.targetCpi);
	const sub = pos(ads.subPrice);
	const months = Math.max(1, num(ads.retentionMonths, 1));
	if (num(ads.targetCpi) < 0 || num(ads.subPrice) < 0) errors.push('ads.targetCpi and ads.subPrice must be positive');
	if (cpi && sub) {
		const ceiling = round2(sub * months);
		if (cpi > ceiling)
			errors.push(
				`ads.targetCpi ${money(cpi)} exceeds ${money(ceiling)}, everything a subscriber pays in ` +
					`${months} month(s) at ads.subPrice ${money(sub)} — set ads.retentionMonths if you are ` +
					'underwriting a longer payback, or lower ads.targetCpi',
			);
		else if (cpi > round2(ceiling * 0.5))
			warnings.push(
				`ads.targetCpi ${money(cpi)} is over half of ${money(ceiling)} lifetime revenue per subscriber — ` +
					'that only works at a near-100% install→paid rate',
			);
	}
	if (cpi && !sub)
		warnings.push('ads.targetCpi is set without ads.subPrice, so nothing checks it against revenue');
	const seedBid = pos(ads.seedBid);
	if (seedBid !== null && seedBid < BID.floor)
		errors.push(`ads.seedBid ${money(seedBid)} is under Apple's ${money(BID.floor)} minimum bid`);
	return { errors, warnings };
}

// ─── observed state ──────────────────────────────────────────────────────────

/**
 * Apple money arrives as `{amount, currency}` or a bare number; `round2` of
 * anything else stays NaN, so junk can never read as a real price.
 * @param {Json} v
 * @returns {number|null}
 */
const amount = (v) =>
	v === null || v === undefined
		? null
		: round2(Number(typeof v === 'object' && !Array.isArray(v) ? v.amount ?? v : v));

/**
 * Apple's payloads → the flat shape `snapshot` writes and `reconcile` reads.
 * Both directions go through here so observed state has exactly one shape.
 *
 * @param {JsonObject} [raw]
 * @returns {LiveCampaign}
 */
export function normaliseCampaign(raw = {}) {
	return {
		id: raw.id === undefined || raw.id === null ? null : String(raw.id),
		name: strOrNull(raw.name),
		status: strOrNull(raw.status) ?? strOrNull(raw.servingStatus),
		displayStatus: strOrNull(raw.displayStatus) ?? strOrNull(raw.servingStatus),
		dailyBudget: amount(raw.dailyBudgetAmount ?? raw.dailyBudget),
		countriesOrRegions: raw.countriesOrRegions ?? [],
		modificationTime: strOrNull(raw.modificationTime),
		adGroups: [],
		negativeKeywords: [],
	};
}

/**
 * @param {JsonObject} [raw]
 * @returns {LiveAdGroup}
 */
export function normaliseAdGroup(raw = {}) {
	return {
		id: raw.id === undefined || raw.id === null ? null : String(raw.id),
		name: strOrNull(raw.name),
		status: strOrNull(raw.status),
		displayStatus: strOrNull(raw.displayStatus) ?? strOrNull(raw.servingStatus),
		defaultBidAmount: amount(raw.defaultBidAmount),
		automatedKeywordsOptIn: Boolean(raw.automatedKeywordsOptIn),
		modificationTime: strOrNull(raw.modificationTime),
		keywords: [],
	};
}

/**
 * @param {JsonObject} [raw]
 * @returns {LiveKeyword}
 */
export function normaliseKeyword(raw = {}) {
	return {
		id: raw.id === undefined || raw.id === null ? null : String(raw.id),
		text: strOrNull(raw.text),
		matchType: strOrNull(raw.matchType),
		status: strOrNull(raw.status),
		bidAmount: amount(raw.bidAmount),
		modificationTime: strOrNull(raw.modificationTime),
	};
}

/**
 * Apple returns `modificationTime` as a bare date-time with no zone
 * (`2026-08-23T23:23:09.562`), which ECMAScript parses as *local* time. On a
 * machine seven hours behind UTC that reads an object modified five hours ago as
 * modified two hours from now — enough to make `sync` refuse a plan that is
 * genuinely newer. The values are UTC, so they are read as UTC.
 *
 * @param {Json|undefined} t
 * @returns {number|null}
 */
export const parseAppleTime = (t) => {
	const s = String(t ?? '').trim();
	if (!s) return null;
	const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
	return Number.isFinite(ms) ? ms : null;
};

/** Most recent `modificationTime` anywhere in an observed account, as epoch ms. */
/**
 * @param {{campaigns?: LiveCampaign[]}|null|undefined} account
 * @returns {number|null}
 */
export function lastModified(account) {
	let latest = 0;
	/** @param {Json} t */
	const visit = (t) => {
		const ms = parseAppleTime(t);
		if (ms !== null && ms > latest) latest = ms;
	};
	for (const cp of account?.campaigns ?? []) {
		visit(cp.modificationTime);
		for (const g of cp.adGroups ?? []) {
			visit(g.modificationTime);
			for (const k of g.keywords ?? []) visit(k.modificationTime);
		}
		for (const n of cp.negativeKeywords ?? []) visit(n.modificationTime);
	}
	return latest || null;
}

// ─── monetisation ────────────────────────────────────────────────────────────

/**
 * The number no ad tool prints and every ad tool should: what an install is
 * worth. A CPI target is meaningless without it — $0.70 per install against a 0%
 * install→paid rate is $0.70 per install of nothing.
 *
 * @param {{installs?: number, customers?: number, trials?: number, subscriptions?: number, revenue?: number, mrr?: number}} m
 * @param {{subPrice?: number|null, retentionMonths?: number}} opts
 */
export function monetisation(m = {}, { subPrice = null, retentionMonths = 1 } = {}) {
	const customers = num(m.customers);
	const trials = num(m.trials);
	const subscriptions = num(m.subscriptions);
	const revenue = round2(Number(m.revenue));
	const mrr = round2(Number(m.mrr));
	// New customers is the closest thing RevenueCat has to installs it saw.
	const base = pos(m.installs) ?? pos(customers);
	const installToPaid = base ? subscriptions / base : null;
	const trialRate = base ? trials / base : null;
	const proven = subscriptions > 0 || revenue > 0 || mrr > 0;
	const months = Math.max(1, num(retentionMonths, 1));
	// Measured first: revenue per customer is observed, subPrice × rate is modelled.
	const ltv = proven && base ? round2(revenue / base) : 0;
	const modelled =
		pos(subPrice) && installToPaid !== null ? round2(num(subPrice) * months * installToPaid) : null;
	const ceiling = proven ? (ltv || modelled) : null;
	return {
		customers,
		trials,
		subscriptions,
		revenue,
		mrr,
		installToPaid,
		trialRate,
		ltvPerInstall: ltv,
		modelledLtv: modelled,
		proven,
		// A cap with no revenue behind it is a research budget, not a target. Saying
		// so is the difference between a number you defend and a number you inherit.
		cpiCeiling: ceiling,
		label: proven ? 'target' : 'research cap',
		verdict: proven
			? `${subscriptions} subscription(s), ${money(revenue)} revenue → ${money(ceiling ?? 0)} per install breaks even`
			: `${customers} customer(s), ${trials} trial(s), ${subscriptions} subscription(s), ${money(revenue)} revenue, ${money(mrr)} MRR — nothing has monetised, so no CPI is profitable`,
	};
}
