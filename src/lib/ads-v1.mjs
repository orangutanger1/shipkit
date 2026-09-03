// Apple Ads Platform API v1 — the pure half: URLs, request bodies, and the
// shapes that come back. No I/O, so every rule here is unit-testable offline
// and the HTTP layer in ads-http.mjs stays thin enough to read in one sitting.
//
// Everything encoded here was verified against a live ad account rather than
// read off the preview guide, which is wrong in four places. The ones that cost
// the most time, kept as comments where they bite:
//   · the path is `adgroups`, not `ad-groups` — the hyphen 503s;
//   · a filter carries `value`, singular, and `campaignId` demands EQUALS;
//   · a campaign's geo and placement moved inside `targeting`;
//   · `dailyBudget` gained a `value` level the guide does not show.
import { num } from './fmt.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {{field: string, operator: string, value: Json}} Filter */

export const V1_BASE = 'https://api.ads.apple.com/v1/';

/** Resource paths, so a hyphen typo is one edit rather than a 503 hunt. */
export const PATHS = {
	me: 'me',
	campaigns: 'campaigns/query',
	adGroups: 'adgroups/query',
	keywords: 'keywords/query',
	negativeKeywords: 'negativekeywords/query',
	creatives: 'creatives/query',
	productPages: 'product-pages/query',
	keywordSuggestions: 'suggestions/keywords/query',
};

/**
 * The bottom of Apple's popularity axis. It is documented as 0-100 and is in
 * practice 5-100: across 426 live rows nothing came back below 5, and a term
 * Apple has no demand data for is echoed back at exactly 5. A real 5 and an
 * unknown are therefore indistinguishable, which is why callers drop the floor
 * rather than record it as measured demand.
 */
export const POPULARITY_FLOOR = 5;

/** @param {Json|undefined} v @returns {v is JsonObject} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {Json|undefined} v @returns {JsonObject} */
const asObj = (v) => (isObj(v) ? v : {});

/**
 * A filter clause. `value` is singular — `values` is rejected outright, which
 * is the single most expensive difference from the v5 selector grammar.
 * @type {(field: string, value: Json, operator?: string) => Filter}
 */
export const filter = (field, value, operator = 'EQUALS') => ({ field, operator, value });

/**
 * A `/query` request body. Parent ids are filters now, not path segments.
 * @type {(opts?: {filters?: Filter[], sorting?: {field: string, sortOrder?: string}[], pageSize?: number, offset?: number}) => JsonObject}
 */
export function queryBody({ filters = [], sorting, pageSize, offset } = {}) {
	return {
		...(filters.length ? { filters } : {}),
		...(sorting?.length ? { sorting: sorting.map((s) => ({ field: s.field, sortOrder: s.sortOrder ?? 'ASC' })) } : {}),
		...(pageSize === undefined && offset === undefined ? {} : { pagination: { pageSize: pageSize ?? 100, offset: offset ?? 0 } }),
	};
}

/**
 * Every page of a `/query`, as offset arithmetic. `fetchPage` is handed the
 * body and answers `{rows, pageSize, offset}`; injected so the paging rule is
 * testable without a network.
 * @type {(fetchPage: (body: JsonObject) => Promise<{rows: Json[], pageSize: number}>, opts?: {filters?: Filter[], pageSize?: number, max?: number}) => Promise<Json[]>}
 */
export async function queryAll(fetchPage, { filters = [], pageSize = 100, max = 10000 } = {}) {
	/** @type {Json[]} */
	const out = [];
	for (let offset = 0; out.length < max; offset += pageSize) {
		const page = await fetchPage(queryBody({ filters, pageSize, offset }));
		out.push(...page.rows);
		// A short page is the last page; Apple echoes the count it actually served.
		if (page.rows.length < pageSize) break;
	}
	return out;
}

/** The rows a v1 answer carries. `result` is a bare array on every query.
 * @type {(payload: Json|undefined) => Json[]}
 */
export function rowsOfV1(payload) {
	const result = asObj(payload).result;
	if (Array.isArray(result)) return result;
	return result === undefined || result === null ? [] : [result];
}

/** @type {(payload: Json|undefined) => {pageSize: number, offset: number}} */
export function paginationOfV1(payload) {
	const page = asObj(asObj(payload).pagination);
	return { pageSize: num(/** @type {any} */ (page.pageSize)), offset: num(/** @type {any} */ (page.offset)) };
}

/** One `details[]`/`errors[]` entry as a line. Named so c8 registers it.
 * @type {(d: Json) => string}
 */
function detailLine(d) {
	const row = asObj(d);
	const field = asObj(row.info).field ?? row.field;
	return `${row.code ?? row.messageCode ?? ''} ${row.message ?? ''}${field ? ` [${field}]` : ''}`.trim();
}

/**
 * The message behind a failed call. Two services answer on this host and they
 * disagree about the shape of an error, so both are read: `{error:{details}}`
 * is v1 rejecting a body, `{error:{errors}}` is the legacy service saying the
 * path is not a v1 path at all.
 * @type {(payload: Json|undefined, status?: number) => string}
 */
export function errorTextV1(payload, status) {
	const err = asObj(asObj(payload).error);
	const details = Array.isArray(err.details) ? err.details : Array.isArray(err.errors) ? err.errors : [];
	const lines = details.map(detailLine);
	const head = String(err.code ?? err.message ?? (status ? `HTTP ${status}` : 'request failed'));
	return lines.length ? `${head}: ${lines.join('; ')}` : head;
}

/**
 * True when the payload came from the legacy v5 service rather than v1 — its
 * error block nests `errors`, and it is how a stale path announces itself.
 * @type {(payload: Json|undefined) => boolean}
 */
export const isLegacyPayload = (payload) => Array.isArray(asObj(asObj(payload).error).errors);

/**
 * Apple's money, from either nesting: keywords answer `{amount, currency}`,
 * campaign budgets answer `{value: {amount, currency}}`.
 * @type {(v: Json|undefined) => {amount: number, currency: string}}
 */
export function moneyOfV1(v) {
	const outer = asObj(v);
	const inner = isObj(outer.value) ? outer.value : outer;
	return { amount: num(/** @type {any} */ (inner.amount)), currency: String(inner.currency ?? 'USD') };
}

/** @type {(n: Json|undefined, currency?: string) => {amount: string, currency: string}} */
export const amountV1 = (n, currency = 'USD') => ({ amount: num(/** @type {any} */ (n)).toFixed(2), currency });

/**
 * v1 timestamps come back without a zone — `2026-08-23T18:28:09.044`. Reading
 * one as local time drifts every modification-time comparison by the host's
 * offset, so the missing `Z` is added rather than assumed.
 * @type {(v: Json|undefined) => string|null}
 */
export function v1Time(v) {
	const s = String(v ?? '').trim();
	if (!s) return null;
	return /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
}

/**
 * A planned campaign as v1 wants it. Geo and placement live inside `targeting`
 * now; `promotedObjectId` replaces `adamId` and cannot be changed after create.
 * @type {(cp: any, adamId: string|number, currency: string) => JsonObject}
 */
export function campaignBodyV1(cp, adamId, currency) {
	return {
		name: cp.name,
		promotedObjectId: String(adamId),
		promotedObjectType: 'APPSTORE_APP',
		dailyBudget: { value: amountV1(cp.dailyBudget, currency) },
		targeting: {
			countryOrRegion: { include: cp.countriesOrRegions ?? [] },
			supplyPlacement: { include: cp.supplySources ?? ['APPSTORE_SEARCH_RESULTS'] },
		},
		billingEvent: cp.billingEvent ?? 'TAPS',
		...(cp.startTime ? { startTime: cp.startTime } : {}),
		...(cp.endTime ? { endTime: cp.endTime } : {}),
		status: cp.status ?? 'ENABLED',
	};
}

/** The subset of a campaign body an update may carry: the rest is immutable.
 * @type {(cp: any, adamId: string|number, currency: string) => JsonObject}
 */
export function campaignUpdateV1(cp, adamId, currency) {
	const { promotedObjectId: _p, promotedObjectType: _t, billingEvent: _b, startTime: _s, ...rest } = campaignBodyV1(cp, adamId, currency);
	return rest;
}

/**
 * `pricingModel: CPC` is gone; the bid strategy carries what it used to say.
 * @type {(spec: any, currency: string) => JsonObject}
 */
export function adGroupBodyV1(spec, currency) {
	return {
		name: spec.name,
		bidStrategy: { bid: amountV1(spec.defaultBidAmount, currency), bidStrategyGoal: 'TAP', bidStrategyType: 'MANUAL_CPT' },
		automatedKeywordsOptIn: Boolean(spec.automatedKeywordsOptIn),
		...(spec.startTime ? { startTime: spec.startTime } : {}),
		...(spec.endTime ? { endTime: spec.endTime } : {}),
		status: spec.status ?? 'ENABLED',
	};
}

/**
 * A keyword's bid is plain `bid` — `bidStrategy.bid` is the ad-group spelling
 * and is rejected here. `ACTIVE` became `ENABLED`.
 * @type {(k: any, adGroupId: Json, currency: string) => JsonObject}
 */
export function keywordBodyV1(k, adGroupId, currency) {
	const bid = k.bid ?? k.bidAmount;
	return {
		...(k.id ? { id: k.id } : { adGroupId, text: k.text, matchType: k.matchType }),
		...(bid === undefined ? {} : { bid: amountV1(bid, currency) }),
		status: k.status === 'ACTIVE' ? 'ENABLED' : (k.status ?? 'ENABLED'),
	};
}

/**
 * A creative is its own entity in v1: the ad references `creativeId` instead of
 * carrying `creativeType` and `productPageId` itself.
 * @type {(name: Json, adamId: string|number, productPageId?: Json) => JsonObject}
 */
export function creativeBodyV1(name, adamId, productPageId) {
	return {
		name,
		creativeType: productPageId ? 'CUSTOM_PRODUCT_PAGE' : 'DEFAULT_PRODUCT_PAGE',
		destination: {
			destinationType: 'APP_STORE_PRODUCT_PAGE',
			parameters: { adamId: String(adamId), ...(productPageId ? { productPageId: String(productPageId) } : {}) },
		},
	};
}

/** @type {(row: Json|undefined) => any} */
export function normaliseCampaignV1(row) {
	const r = asObj(row);
	const targeting = asObj(r.targeting);
	return {
		id: r.id === undefined || r.id === null ? null : String(r.id),
		name: r.name === undefined ? null : String(r.name),
		status: r.status ?? null,
		displayStatus: r.displayStatus ?? null,
		dailyBudget: moneyOfV1(r.dailyBudget).amount,
		countriesOrRegions: asObj(targeting.countryOrRegion).include ?? [],
		supplyPlacement: asObj(targeting.supplyPlacement).include ?? [],
		// Why a campaign is not serving — v5 never returned this. See backlog 6.
		limitingReasons: Array.isArray(r.systemStatusLimitingReasons) ? r.systemStatusLimitingReasons : [],
		modificationTime: v1Time(r.modificationTime),
		adGroups: [],
		negativeKeywords: [],
	};
}

/** @type {(row: Json|undefined) => any} */
export function normaliseAdGroupV1(row) {
	const r = asObj(row);
	return {
		id: r.id === undefined || r.id === null ? null : String(r.id),
		campaignId: r.campaignId === undefined || r.campaignId === null ? null : String(r.campaignId),
		name: r.name === undefined ? null : String(r.name),
		status: r.status ?? null,
		displayStatus: r.displayStatus ?? null,
		defaultBidAmount: moneyOfV1(asObj(r.bidStrategy).bid).amount,
		automatedKeywordsOptIn: Boolean(r.automatedKeywordsOptIn),
		modificationTime: v1Time(r.modificationTime),
		keywords: [],
	};
}

/** @type {(row: Json|undefined) => any} */
export function normaliseKeywordV1(row) {
	const r = asObj(row);
	return {
		id: r.id === undefined || r.id === null ? null : String(r.id),
		adGroupId: r.adGroupId === undefined || r.adGroupId === null ? null : String(r.adGroupId),
		text: r.text === undefined ? null : String(r.text),
		matchType: r.matchType ?? null,
		status: r.status ?? null,
		bidAmount: moneyOfV1(r.bid).amount,
		modificationTime: v1Time(r.modificationTime),
	};
}

/**
 * A keyword-suggestions request. Three things this endpoint does that no other
 * `/query` does, all found the hard way against a live account:
 *   · every filter `value` is an **array**, even under `EQUALS` — a scalar is
 *     rejected as "Request body is not readable", which names no field;
 *   · `promotedObjectId` and `promotedObjectType` are required, and the app
 *     must belong to this ad account or Apple answers "App not found";
 *   · `terms` accepts an array but honours only the **first** entry, silently.
 *     One term per call is the contract, not an optimisation choice.
 * @type {(opts: {adamId: string|number, term?: string, countries?: string[], pageSize?: number, offset?: number}) => JsonObject}
 */
export function suggestionsBody({ adamId, term, countries = [], pageSize = 100, offset = 0 }) {
	return {
		filters: [
			filter('promotedObjectId', [String(adamId)]),
			filter('promotedObjectType', ['APPSTORE_APP']),
			...(term ? [filter('terms', [term], 'IN')] : []),
			...(countries.length ? [filter('countriesOrRegions', countries, 'IN')] : []),
		],
		pagination: { pageSize, offset },
	};
}

/** One suggestion row. Named so c8's fnMap registers it — see the CRAP rule.
 * @type {(row: Json) => {text: string, popularity: number}|null}
 */
function suggestionRow(row) {
	const r = asObj(row);
	const text = String(r.text ?? '').trim();
	const popularity = Number(r.popularity);
	return text && Number.isFinite(popularity) ? { text, popularity } : null;
}

/**
 * The `{text, popularity}` pairs behind a suggestions answer. The seed term is
 * always among them; the rest are Apple's expansion of it, and they carry real
 * popularity for terms we never asked about.
 * @type {(payload: Json|undefined) => {text: string, popularity: number}[]}
 */
export function suggestionRows(payload) {
	return /** @type {{text: string, popularity: number}[]} */ (rowsOfV1(payload).map(suggestionRow).filter(Boolean));
}
