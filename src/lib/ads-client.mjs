// Apple Ads Campaign Management API client: report pulling, payload-file
// mutations, and the object CRUD `sync`/`applyMining` drive. Credential
// resolution lives in ads-auth.mjs; the apply engine lives in ads-apply.mjs.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShipError, warn } from '../log.mjs';
import { ASC, asc, run as exec } from '../exec.mjs';
import { num, round2 } from './fmt.mjs';
import { metric, rowsOf } from './asc-report.mjs';
import { normaliseAdGroup, normaliseCampaign, normaliseKeyword } from './asa.mjs';
import { authState } from './ads-auth.mjs';

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
const METRIC_KEYS = ['impressions', 'taps', 'tapInstalls', 'totalInstalls', 'installs', 'newDownloads', 'redownloads'];
function totalsOf(r) {
	if (r.total) return r.total;
	const buckets = Array.isArray(r.granularity) ? r.granularity : [];
	if (!buckets.length) return r.metadata ?? {};
	const out = { localSpend: { amount: 0, currency: 'USD' } };
	for (const b of buckets) {
		out.localSpend.amount += metric(b.localSpend);
		out.localSpend.currency = b.localSpend?.currency ?? out.localSpend.currency;
		for (const k of METRIC_KEYS) if (b[k] !== undefined) out[k] = num(out[k]) + num(b[k]);
	}
	return out;
}
function metricRow(r, level) {
	const meta = r.metadata ?? {}, t = totalsOf(r);
	const spend = metric(t.localSpend), impressions = num(t.impressions), taps = num(t.taps);
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
export const adsReportRows = (res) =>
	(res?.data?.reportingDataResponse?.row ?? res?.reportingDataResponse?.row ?? rowsOf(res, { allowSingle: false })).filter(
		(r) => r?.other !== true,
	);
export async function pullReport(org, level, { from, to, campaign, adGroup }) {
	const spec = LEVELS[level];
	const base = [
		'ads', 'reports', 'preset', '--level', spec.preset, '--from', from, '--to', to,
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
export async function withPayload(name, body, fn) {
	const file = join(await mkdtemp(join(tmpdir(), 'ship-ads-')), name);
	await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
	return fn(file);
}
export async function ascMutate(args, { file } = {}) {
	const full = file ? [...args, '--file', file, '--output', 'json'] : [...args, '--output', 'json'];
	const res = await exec(ASC, full, { mutating: true, allowFail: true });
	if (res.skipped) return null;
	if (res.code !== 0)
		throw new ShipError(`asc ${args.slice(0, 4).join(' ')} exited ${res.code}`, {
			hint: (res.stderr || res.stdout).trim().split('\n').slice(-8).join('\n'),
		});
	try {
		const t = res.stdout.trim();
		return t ? JSON.parse(t.slice(Math.max(0, t.search(/[[{]/)))) : null;
	} catch {
		return null;
	}
}
const one = (payload) => (Array.isArray(payload?.data) ? payload.data[0] : (payload?.data ?? payload));
const byName = (list, name) => list.find((r) => r.name === name) ?? null;
const amountOf = (n, currency = 'USD') => ({ amount: num(n).toFixed(2), currency });
const asRows = (res) => rowsOf(res, { allowSingle: false });
export const listCampaigns = (org) => asc(['ads', 'campaigns', 'list', '--org', org, '--paginate'], { fallback: null }).then(asRows);
export const listAdGroups = (org, campaignId) =>
	asc(['ads', 'ad-groups', 'list', '--campaign', campaignId, '--org', org, '--paginate'], { fallback: null }).then(asRows);
export const listKeywords = (org, campaignId, adGroupId) =>
	asc(['ads', 'targeting-keywords', 'list', '--campaign', campaignId, '--ad-group', adGroupId, '--org', org, '--paginate'], { fallback: [] }).then(asRows);
export const listNegatives = (org, campaignId) =>
	asc(['ads', 'campaign-negative-keywords', 'list', '--campaign', campaignId, '--org', org, '--paginate'], { fallback: [] }).then(asRows);
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
export const createCampaign = async (org, cp, adamId, currency) =>
	one(await withPayload('campaign.json', campaignBody(cp, adamId, currency), (file) =>
		ascMutate(['ads', 'campaigns', 'create', '--org', org], { file })));
export function updateCampaign(org, id, cp, adamId, currency) {
	const { adamId: _a, supplySources: _s, billingEvent: _b, adChannelType: _c, startTime: _t, ...update } = campaignBody(cp, adamId, currency);
	return withPayload('campaign.json', { campaign: update, clearGeoTargetingOnCountryOrRegionChange: false }, (file) =>
		ascMutate(['ads', 'campaigns', 'update', '--campaign', String(id), '--org', org], { file }));
}
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
export const createAdGroup = async (org, campaignId, spec, currency) =>
	one(await withPayload('ad-group.json', adGroupBody(spec, currency), (file) =>
		ascMutate(['ads', 'ad-groups', 'create', '--campaign', campaignId, '--org', org], { file })));
export function updateAdGroup(org, campaignId, id, spec, currency) {
	const { startTime: _t, ...update } = adGroupBody(spec, currency);
	return withPayload('ad-group.json', update, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], { file }));
}
export const pauseAdGroup = (org, campaignId, id) =>
	withPayload('ad-group.json', { status: 'PAUSED' }, (file) =>
		ascMutate(['ads', 'ad-groups', 'update', '--campaign', campaignId, '--ad-group', String(id), '--org', org], { file }));
const keywordArgs = (verb, campaignId, adGroupId, org) =>
	['ads', 'targeting-keywords', verb, '--campaign', campaignId, '--ad-group', adGroupId, '--org', org];
export const createKeywords = async (org, campaignId, adGroupId, list, currency) =>
	asRows(await withPayload('keywords.json',
		list.map((k) => ({ text: k.text, matchType: k.matchType, bidAmount: amountOf(k.bid ?? k.bidAmount, currency) })),
		(file) => ascMutate(keywordArgs('create-bulk', campaignId, adGroupId, org), { file })));
export const updateKeywords = (org, campaignId, adGroupId, list, currency) =>
	withPayload('keywords.json',
		list.map((k) => ({
			id: k.id,
			...(k.bid === undefined && k.bidAmount === undefined ? {} : { bidAmount: amountOf(k.bid ?? k.bidAmount, currency) }),
			status: k.status ?? 'ACTIVE',
		})),
		(file) => ascMutate(keywordArgs('update-bulk', campaignId, adGroupId, org), { file }));
export const pauseKeywords = (org, campaignId, adGroupId, ids) =>
	updateKeywords(org, campaignId, adGroupId, ids.map((id) => ({ id, status: 'PAUSED' })));
export async function ensureAdGroup(org, campaignId, groups, spec, currency) {
	const found = byName(groups, spec.name);
	if (found) {
		await updateAdGroup(org, campaignId, found.id, spec, currency);
		return { group: found, created: false };
	}
	return { group: await createAdGroup(org, campaignId, spec, currency), created: true };
}
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
export async function readAccount(org, { performance = true, from, to } = {}) {
	const campaigns = [];
	for (const raw of await listCampaigns(org)) {
		const cp = normaliseCampaign(raw);
		if (!cp.id) continue;
		cp.negativeKeywords = (await listNegatives(org, cp.id)).map(normaliseKeyword);
		for (const rawGroup of await listAdGroups(org, cp.id)) {
			const g = normaliseAdGroup(rawGroup);
			if (!g.id) continue;
			g.keywords = (await listKeywords(org, cp.id, g.id)).map(normaliseKeyword);
			cp.adGroups.push(g);
		}
		campaigns.push(cp);
	}
	if (!performance) return { campaigns };
	const attach = async (level, key) => {
		const rowsOut = await pullReport(org, level, { from, to }).catch(() => []);
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
