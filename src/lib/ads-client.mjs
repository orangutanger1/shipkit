// Apple Ads Campaign Management API client: report pulling, payload-file
// mutations, and the object CRUD `sync`/`applyMining` drive. Credential
// resolution lives in ads-auth.mjs; the apply engine lives in ads-apply.mjs.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShipError, warn } from '../log.mjs';
import { ASC, asc, run as exec } from '../exec.mjs';
import { num, round2 } from './fmt.mjs';
import { metric, rowsOf } from './asc-report.mjs';
import { normaliseAdGroup, normaliseCampaign, normaliseKeyword } from './asa.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */
/** @typedef {import('../exec.mjs').AscPayload} AscPayload */
/** Every JSON scalar, i.e. exactly what `num` coerces. */
/** @typedef {string|number|boolean|null} Num */
/**
 * Apple's money object: `{amount, currency}` on budgets, bids and spend.
 * @typedef {JsonObject & {amount?: Json, currency?: Json}} MoneyRow
 */
/**
 * Anything asc answers with, viewed as a row: report rows, list rows and
 * mutation answers share one loose view whose fields are all optional and as
 * loose as the payload allows.
 * @typedef {JsonObject & {
 *   data?: Row,
 *   reportingDataResponse?: JsonObject & {row?: Json},
 *   row?: Json, total?: TotalsRow, granularity?: Row[], metadata?: TotalsRow,
 *   localSpend?: MoneyRow,
 *   campaignId?: Json, adGroupId?: Json, keywordId?: Json,
 *   campaignStatus?: Json, adGroupStatus?: Json, keywordStatus?: Json,
 *   status?: Json, name?: Json, id?: Json, other?: Json, text?: Json,
 *   matchType?: Json, bidAmount?: MoneyRow, dailyBudgetAmount?: MoneyRow,
 *   servingStatus?: Json, productPageId?: Json, countriesOrRegions?: JsonArray,
 *   defaultBidAmount?: Json,
 * }} Row
 */
/** The keys `totalsOf` accumulates from granularity buckets. */
/** @typedef {'impressions'|'taps'|'tapInstalls'|'totalInstalls'|'installs'|'newDownloads'|'redownloads'} MetricKey */
/**
 * The totals view of a report row: Apple's `total` block when present, else
 * the row metadata, else an accumulation over the granularity buckets.
 * @typedef {JsonObject & {
 *   localSpend?: MoneyRow,
 *   impressions?: Num, taps?: Num, installs?: Num, totalInstalls?: Num,
 *   tapInstalls?: Num, newDownloads?: Num, redownloads?: Num,
 * }} TotalsRow
 */
/**
 * One flattened performance row: what `pullReport` yields and every report
 * view, snapshot and CPT derivation consumes.
 * @typedef {{
 *   level: string, name: Json,
 *   campaignId: Json, adGroupId: Json, keywordId: Json, status: Json,
 *   impressions: number, taps: number, installs: number, spend: number,
 *   currency: Json, cpi: number|null, cpt: number|null, ttr: number,
 *   conversionRate: number,
 * }} MetricRow
 */
/**
 * A keyword as the plan lists it and as this client pushes it: `text`/`bid`
 * for creates, `id`/`status` for updates, either for both.
 * @typedef {{text?: Json, matchType?: Json, bid?: Num, bidAmount?: Num, id?: Json, status?: Json}} KeywordInput
 */
/**
 * One observed account object: what `readAccount` returns, `snapshot` writes
 * and `reconcile` reads.
 * @typedef {{
 *   id: string|null, name: string|null, status: string|null, displayStatus: string|null,
 *   dailyBudget: number|null, countriesOrRegions: Json, modificationTime: string|null,
 *   adGroups: SnapshotAdGroup[], negativeKeywords: SnapshotKeyword[],
 *   performance?: MetricRow,
 * }} SnapshotCampaign
 */
/** @typedef {{id: string|null, name: string|null, status: string|null, displayStatus: string|null, defaultBidAmount: number|null, automatedKeywordsOptIn: boolean, modificationTime: string|null, keywords: SnapshotKeyword[], performance?: MetricRow}} SnapshotAdGroup */
/** @typedef {{id: string|null, text: string|null, matchType: string|null, status: string|null, bidAmount: number|null, modificationTime: string|null, performance?: MetricRow}} SnapshotKeyword */

/**
 * Narrow an untrusted JSON value to the loose {@link Row} view.
 * @param {Json|undefined} v
 * @returns {v is Row}
 */
const isRow = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * View any JSON value as a {@link Row}: objects pass through untouched,
 * anything else reads as an empty row — exactly what property access on a
 * scalar would have yielded.
 * @param {Json|undefined} v
 * @returns {Row}
 */
const asRow = (v) => (isRow(v) ? v : {});

/**
 * List endpoints answer with rows; every element is viewed as a {@link Row}.
 * @param {AscPayload|null|undefined} res
 * @returns {Row[]}
 */
const asRows = (res) => rowsOf(res, { allowSingle: false }).map(asRow);

/** @typedef {{preset: string, scoped: boolean, fields: string, label: (m: JsonObject) => Json}} ReportLevelSpec */
/** @type {Record<string, ReportLevelSpec>} */
export const LEVELS = {
	campaign: {
		preset: 'campaigns', scoped: false, fields: 'campaignId,campaignName,campaignStatus,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.campaignName ?? m.name ?? '(unnamed)',
	},
	'ad-group': {
		preset: 'ad-groups', scoped: true, fields: 'adGroupId,adGroupName,adGroupStatus,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.adGroupName ?? m.name ?? '(unnamed)',
	},
	keyword: {
		preset: 'keywords', scoped: true, fields: 'keywordId,keyword,matchType,keywordStatus,adGroupId,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => `${m.keyword ?? m.keywordText ?? '(unnamed)'}${m.matchType ? ` ${m.matchType}` : ''}`,
	},
	'search-term': {
		preset: 'search-terms', scoped: true, fields: 'searchTermText,searchTermSource,keyword,matchType,adGroupId,impressions,taps,tapInstalls,totalInstalls,localSpend',
		label: (m) => m.searchTermText ?? m.searchTerm ?? '(unnamed)',
	},
};
/** @type {MetricKey[]} */
const METRIC_KEYS = ['impressions', 'taps', 'tapInstalls', 'totalInstalls', 'installs', 'newDownloads', 'redownloads'];

/**
 * @param {Row} r
 * @returns {TotalsRow}
 */
function totalsOf(r) {
	if (r.total) return r.total;
	const buckets = Array.isArray(r.granularity) ? r.granularity : [];
	if (!buckets.length) return r.metadata ?? {};
	/** @type {{localSpend: {amount: number, currency: Json}, impressions?: Num, taps?: Num, installs?: Num, totalInstalls?: Num, tapInstalls?: Num, newDownloads?: Num, redownloads?: Num}} */
	const out = { localSpend: { amount: 0, currency: 'USD' } };
	for (const b of buckets) {
		out.localSpend.amount += metric(b.localSpend ?? null);
		out.localSpend.currency = b.localSpend?.currency ?? out.localSpend.currency;
		for (const k of METRIC_KEYS) {
			const v = b[k];
			if (v !== undefined) out[k] = num(out[k]) + num(typeof v === 'object' && v !== null ? 0 : v);
		}
	}
	return out;
}

/**
 * Flatten one report row into the {@link MetricRow} every view consumes.
 * @param {Row} r
 * @param {string} level
 * @returns {MetricRow}
 */
function metricRow(r, level) {
	const meta = r.metadata ?? {}, t = totalsOf(r);
	const spend = metric(t.localSpend ?? null), impressions = num(t.impressions), taps = num(t.taps);
	const installs = num(t.totalInstalls ?? t.tapInstalls ?? t.installs ?? num(t.newDownloads) + num(t.redownloads));
	return {
		level, name: LEVELS[level].label(meta),
		campaignId: meta.campaignId ?? r.campaignId ?? null,
		adGroupId: meta.adGroupId ?? null, keywordId: meta.keywordId ?? null,
		status: meta.campaignStatus ?? meta.adGroupStatus ?? meta.keywordStatus ?? meta.status ?? '',
		impressions, taps, installs, spend,
		currency: t.localSpend?.currency ?? 'USD',
		cpi: installs ? round2(spend / installs) : null,
		cpt: taps ? round2(spend / taps) : null,
		ttr: impressions ? taps / impressions : 0,
		conversionRate: taps ? installs / taps : 0,
	};
}
/**
 * The report rows a payload carries, `other` totals excluded: Apple buries
 * them under `data.reportingDataResponse.row`, asc sometimes unwraps a level.
 * @param {AscPayload|null|undefined} res
 * @returns {Row[]}
 */
const adsReportRows = (res) => {
	const body = asRow(res), inner = asRow(body.data);
	const block = inner.reportingDataResponse ?? body.reportingDataResponse;
	const rows = Array.isArray(block?.row) ? block.row : rowsOf(res, { allowSingle: false });
	return rows.filter((r) => asRow(r).other !== true).map(asRow);
};

/**
 * Pull one report level and flatten each row into a {@link MetricRow}.
 * @param {string} org
 * @param {string} level
 * @param {{from?: string, to?: string, campaign?: Json|null, adGroup?: Json|null}} window
 * @returns {Promise<MetricRow[]>}
 */
export async function pullReport(org, level, { from, to, campaign, adGroup }) {
	const spec = LEVELS[level];
	const base = [
		'ads', 'reports', 'preset', '--level', spec.preset, '--from', from ?? '', '--to', to ?? '',
		'--fields', spec.fields, '--sort', '-localSpend', '--org', String(org),
		...(spec.preset === 'search-terms' ? [] : ['--return-row-totals']),
	];
	if (!spec.scoped) return adsReportRows(await asc(base)).map((r) => metricRow(r, level));
	const ids = campaign
		? [String(campaign)]
		: (await listCampaigns(org)).map((r) => String(r.id)).filter((id) => id && id !== 'undefined');
	if (!ids.length)
		throw new ShipError(`org ${org} has no campaigns to report on`, { hint: 'run `ship ads plan`, then `ship ads sync`' });
	const out = [];
	for (const id of ids) {
		const args = [...base, '--campaign', id, ...(adGroup ? ['--ad-group', String(adGroup)] : [])];
		const res = await asc(args);
		for (const r of adsReportRows(res)) out.push({ ...metricRow(r, level), campaignId: r.metadata?.campaignId ?? id });
	}
	return out;
}
/**
 * Write `body` to a temp file, hand `fn` its path, and pass the result through.
 * @template T
 * @param {string} name
 * @param {import('./ads-plan.mjs').WriteBody} body
 * @param {(file: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPayload(name, body, fn) {
	const file = join(await mkdtemp(join(tmpdir(), 'ship-ads-')), name);
	await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
	return fn(file);
}

/**
 * Every Apple Ads mutation is a payload file — the CLI takes no inline body —
 * so this always has one to pass.
 * @param {string[]} args
 * @param {{file: string}} opts
 * @returns {Promise<AscPayload|null>}
 */
async function ascMutate(args, { file }) {
	const full = [...args, '--file', file, '--output', 'json'];
	const res = await exec(ASC, full, { mutating: true, allowFail: true });
	if (res.skipped) return null;
	if (res.code !== 0)
		throw new ShipError(`asc ${args.slice(0, 4).join(' ')} exited ${res.code}`, {
			hint: (res.stderr || res.stdout).trim().split('\n').slice(-8).join('\n'),
		});
	try {
		const t = res.stdout.trim();
		return t ? /** @type {AscPayload|null} */ (JSON.parse(t.slice(Math.max(0, t.search(/[[{]/))))) : null;
	} catch {
		return null;
	}
}

/**
 * The single object a mutation answered with: `data[0]` when asc wrapped a
 * list, the data block when it did not, else the payload itself.
 * @param {AscPayload|null|undefined} payload
 * @returns {Row|null|undefined}
 */
const one = (payload) => {
	const data = isRow(payload) ? payload.data : undefined;
	return Array.isArray(data) ? (data.length ? asRow(data[0]) : undefined) : asRow(data ?? payload);
};

/**
 * @param {Row[]} list
 * @param {Json} name
 * @returns {Row|null}
 */
const byName = (list, name) => list.find((r) => r.name === name) ?? null;

/**
 * @param {Num|undefined} n
 * @param {string} [currency]
 * @returns {{amount: string, currency: string}}
 */
const amountOf = (n, currency = 'USD') => ({ amount: num(n).toFixed(2), currency });

/** @typedef {{name: Json, adamId: string|number, countriesOrRegions: Array<string|null>, dailyBudgetAmount: {amount: string, currency: string}, startTime?: Json, endTime?: Json, supplySources: Json, billingEvent: Json, adChannelType: Json, status: Json}} CampaignBody */

/**
 * @param {string} org
 * @returns {Promise<Row[]>}
 */
export const listCampaigns = (org) => asc(['ads', 'campaigns', 'list', '--org', org, '--paginate'], { fallback: null }).then(asRows);
/**
 * @param {string} org
 * @param {string} campaignId
 * @returns {Promise<Row[]>}
 */
export const listAdGroups = (org, campaignId) =>
	asc(['ads', 'ad-groups', 'list', '--campaign', campaignId, '--org', org, '--paginate'], { fallback: null }).then(asRows);
/** @param {string} org @param {string} campaignId @param {string} adGroupId @returns {Promise<Row[]>} */
export const listKeywords = (org, campaignId, adGroupId) =>
	asc(['ads', 'targeting-keywords', 'list', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org, '--paginate'], { fallback: [] }).then(asRows);
/** @param {string} org @param {string} campaignId @returns {Promise<Row[]>} */
const listNegatives = (org, campaignId) =>
	asc(['ads', 'campaign-negative-keywords', 'list', '--campaign', campaignId, '--org', org, '--paginate'], { fallback: [] }).then(asRows);
/**
 * @param {import('./ads-plan.mjs').PlannedCampaign} cp
 * @param {string|number} adamId
 * @param {string} currency
 * @returns {CampaignBody}
 */
function campaignBody(cp, adamId, currency) {
	return {
		name: cp.name, adamId, countriesOrRegions: cp.countriesOrRegions,
		dailyBudgetAmount: amountOf(cp.dailyBudget, currency),
		...(cp.startTime ? { startTime: cp.startTime } : {}),
		...(cp.endTime ? { endTime: cp.endTime } : {}),
		supplySources: cp.supplySources, billingEvent: cp.billingEvent, adChannelType: cp.adChannelType,
		status: cp.status ?? 'ENABLED',
	};
}
/**
 * @param {string} org
 * @param {import('./ads-plan.mjs').PlannedCampaign} cp
 * @param {string|number} adamId
 * @param {string} currency
 * @returns {Promise<Row|null|undefined>}
 */
export const createCampaign = async (org, cp, adamId, currency) =>
	one(await withPayload('campaign.json', campaignBody(cp, adamId, currency), (file) =>
		ascMutate(['ads', 'campaigns', 'create', '--org', org], { file })));
/**
 * @param {string} org
 * @param {Json} id
 * @param {import('./ads-plan.mjs').PlannedCampaign} cp
 * @param {string|number} adamId
 * @param {string} currency
 * @returns {Promise<AscPayload|null>}
 */
export function updateCampaign(org, id, cp, adamId, currency) {
	const { adamId: _a, supplySources: _s, billingEvent: _b, adChannelType: _c, startTime: _t, ...update } = campaignBody(cp, adamId, currency);
	return withPayload('campaign.json', { campaign: update, clearGeoTargetingOnCountryOrRegionChange: false }, (file) =>
		ascMutate(['ads', 'campaigns', 'update', '--campaign', String(id), '--org', org], { file }));
}
/**
 * @param {import('./ads-plan.mjs').AdGroupSpec} spec
 * @param {string} currency
 * @returns {{name: string, startTime: string, defaultBidAmount: {amount: string, currency: string}, pricingModel: string, automatedKeywordsOptIn: boolean, endTime?: string, status: string}}
 */
function adGroupBody(spec, currency) {
	return {
		name: spec.name,
		startTime: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
		defaultBidAmount: amountOf(spec.defaultBidAmount, currency),
		pricingModel: 'CPC', automatedKeywordsOptIn: Boolean(spec.automatedKeywordsOptIn),
		...(spec.endTime ? { endTime: spec.endTime } : {}),
		status: spec.status ?? 'ENABLED',
	};
}
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {import('./ads-plan.mjs').AdGroupSpec} spec
 * @param {string} currency
 * @returns {Promise<Row|null|undefined>}
 */
export const createAdGroup = async (org, campaignId, spec, currency) =>
	one(await withPayload('ad-group.json', adGroupBody(spec, currency), (file) =>
		ascMutate(['ads', 'ad-groups', 'create', '--campaign', campaignId, '--org', org], { file })));
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {Json} id
 * @param {import('./ads-plan.mjs').AdGroupSpec} spec
 * @param {string} currency
 * @returns {Promise<AscPayload|null>}
 */
export function updateAdGroup(org, campaignId, id, spec, currency) {
	const { startTime: _t, ...update } = adGroupBody(spec, currency);
	return withPayload('ad-group.json', update, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], { file }));
}
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {Json} id
 * @returns {Promise<AscPayload|null>}
 */
export const pauseAdGroup = (org, campaignId, id) =>
	withPayload('ad-group.json', { status: 'PAUSED' }, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], { file }));

/**
 * @param {string} verb
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {string} org
 * @returns {string[]}
 */
const keywordArgs = (verb, campaignId, adGroupId, org) =>
	['ads', 'targeting-keywords', verb, '--campaign', campaignId, '--ad-group', adGroupId, '--org', org];
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {KeywordInput[]} list
 * @param {string} currency
 * @returns {Promise<Row[]>}
 */
export const createKeywords = async (org, campaignId, adGroupId, list, currency) =>
	asRows(await withPayload('keywords.json',
		list.map((k) => ({ text: k.text, matchType: k.matchType, bidAmount: amountOf(k.bid ?? k.bidAmount, currency) })),
		(file) => ascMutate(keywordArgs('create-bulk', campaignId, adGroupId, org), { file })));
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {KeywordInput[]} list
 * @param {string} [currency]
 * @returns {Promise<AscPayload|null>}
 */
export const updateKeywords = (org, campaignId, adGroupId, list, currency) =>
	withPayload('keywords.json',
		list.map((k) => ({
			id: k.id,
			...(k.bid === undefined && k.bidAmount === undefined ? {} : { bidAmount: amountOf(k.bid ?? k.bidAmount, currency) }),
			status: k.status ?? 'ACTIVE',
		})),
		(file) => ascMutate(keywordArgs('update-bulk', campaignId, adGroupId, org), { file }));
/**
 * @param {string} org
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {Json[]} ids
 * @returns {Promise<AscPayload|null>}
 */
export const pauseKeywords = (org, campaignId, adGroupId, ids) =>
	updateKeywords(org, campaignId, adGroupId, ids.map((id) => ({ id, status: 'PAUSED' })));

/**
 * Update an ad group in place or create it, and say which happened.
 * @param {string} org
 * @param {string} campaignId
 * @param {Row[]} groups
 * @param {import('./ads-plan.mjs').AdGroupSpec} spec
 * @param {string} currency
 * @returns {Promise<{group: Row|null|undefined, created: boolean}>}
 */
export async function ensureAdGroup(org, campaignId, groups, spec, currency) {
	const found = byName(groups, spec.name);
	if (found) {
		await updateAdGroup(org, campaignId, String(found.id), spec, currency);
		return { group: found, created: false };
	}
	return { group: await createAdGroup(org, campaignId, spec, currency), created: true };
}
/**
 * Create the keywords the plan wants that the ad group lacks, reprice the rest.
 * @param {string} org
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {KeywordInput[]} wanted
 * @param {string} currency
 * @returns {Promise<{created: number, updated: number}>}
 */
export async function ensureKeywords(org, campaignId, adGroupId, wanted, currency) {
	if (!wanted.length) return { created: 0, updated: 0 };
	const have = await listKeywords(org, campaignId, adGroupId);
	const missing = [], present = [];
	for (const k of wanted) {
		const hit = have.find((h) => h.text === k.text && h.matchType === k.matchType);
		if (hit) present.push({ id: hit.id, bid: k.bid });
		else missing.push(k);
	}
	if (missing.length) await createKeywords(org, campaignId, adGroupId, missing, currency);
	if (present.length) await updateKeywords(org, campaignId, adGroupId, present, currency);
	return { created: missing.length, updated: present.length };
}
/**
 * Negate every wanted keyword the campaign does not already have.
 * @param {string} org
 * @param {string} campaignId
 * @param {{text: Json, matchType: Json}[]} wanted
 * @returns {Promise<number>}
 */
export async function ensureNegatives(org, campaignId, wanted) {
	if (!wanted.length) return 0;
	const have = await listNegatives(org, campaignId);
	const missing = wanted.filter((k) => !have.some((h) => h.text === k.text && h.matchType === k.matchType));
	if (!missing.length) return 0;
	await withPayload('negative-keywords.json',
		missing.map((k) => ({ text: k.text, matchType: k.matchType })),
		(file) => ascMutate(['ads', 'campaign-negative-keywords', 'create-bulk', '--campaign', campaignId, '--org', org], { file }));
	return missing.length;
}
/**
 * Point an ad group's single CPP-backed ad at the product page `page` names.
 * @param {string} org
 * @param {string|number} adamId
 * @param {string} campaignId
 * @param {string} adGroupId
 * @param {{name: Json, slug: string}} page
 * @param {{pages?: Row[]}} cache
 * @returns {Promise<boolean>}
 */
export async function bindProductPage(org, adamId, campaignId, adGroupId, page, cache) {
	cache.pages ??= asRows(await asc(['ads', 'product-pages', 'list', '--adam-id', String(adamId), '--org', org], { fallback: [] }));
	const live = cache.pages.find((p) => p.name === page.name);
	if (!live) {
		warn(`product page "${page.name}" is not in Apple Ads yet — \`ship meta cpp apply ${page.slug}\`, then re-run sync`);
		return false;
	}
	const productPageId = live.productPageId ?? live.id ?? null;
	const name = `${page.name} · CPP`;
	const body = { name, productPageId, creativeType: 'CUSTOM_PRODUCT_PAGE', status: 'ENABLED' };
	const have = asRows(await asc(['ads', 'ads', 'list', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org], { fallback: [] }));
	const found = byName(have, name);
	if (found && String(found.productPageId ?? '') === String(productPageId)) return true;
	const args = found
		? ['ads', 'ads', 'update', '--campaign', campaignId, '--ad-group', adGroupId, '--ad', String(found.id), '--org', org]
		: ['ads', 'ads', 'create', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org];
	await withPayload('ad.json', body, (file) => ascMutate(args, { file }));
	return true;
}
/**
 * Read the whole account: campaigns with their ad groups, keywords, negatives
 * and, when `performance`, the flattened metrics for each level.
 * @param {string} org
 * @param {{performance?: boolean, from?: string, to?: string}} [opts]
 * @returns {Promise<{campaigns: SnapshotCampaign[]}>}
 */
export async function readAccount(org, { performance = true, from, to } = {}) {
	/** @type {SnapshotCampaign[]} */
	const campaigns = [];
	for (const raw of await listCampaigns(org)) {
		/** @type {SnapshotCampaign} */
		const cp = normaliseCampaign(raw);
		if (!cp.id) continue;
		cp.negativeKeywords = (await listNegatives(org, cp.id)).map(normaliseKeyword);
		for (const rawGroup of await listAdGroups(org, cp.id)) {
			/** @type {SnapshotAdGroup} */
			const g = normaliseAdGroup(rawGroup);
			if (!g.id) continue;
			g.keywords = (await listKeywords(org, cp.id, g.id)).map(normaliseKeyword);
			cp.adGroups.push(g);
		}
		campaigns.push(cp);
	}
	if (!performance) return { campaigns };
	/**
	 * @param {string} level
	 * @param {string} [key]
	 */
	const attach = async (level, key) => {
		const rowsOut = await pullReport(org, level, { from: from ?? '', to: to ?? '' }).catch(() => []);
		for (const r of rowsOut) {
			for (const cp of campaigns) {
				if (level === 'campaign') {
					if (String(cp.id) === String(r.campaignId ?? '')) cp.performance = r;
					continue;
				}
				for (const g of cp.adGroups) {
					if (level === 'ad-group' && g.name === r.name) g.performance = r;
					if (level === 'keyword')
						for (const k of g.keywords)
							if (`${k.text} ${k.matchType}` === r.name) k.performance = r;
				}
			}
		}
		return key;
	};
	await attach('campaign');
	await attach('ad-group');
	await attach('keyword');
	return { campaigns };
}
