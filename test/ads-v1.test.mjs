// Apple Ads Platform API v1. The fixtures are real responses captured from a
// live ad account, not invented ones — the preview guide is wrong in four
// places and every test below that says "verified" is pinning an observed
// shape against it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	PATHS,
	V1_BASE,
	adGroupBodyV1,
	amountV1,
	campaignBodyV1,
	campaignUpdateV1,
	creativeBodyV1,
	errorTextV1,
	filter,
	isLegacyPayload,
	keywordBodyV1,
	moneyOfV1,
	normaliseAdGroupV1,
	normaliseCampaignV1,
	normaliseKeywordV1,
	paginationOfV1,
	queryAll,
	queryBody,
	rowsOfV1,
	v1Time,
} from '../src/lib/ads-v1.mjs';
import { tokenFrom, v1Account, v1Error, v1Me, v1Query, v1Request } from '../src/lib/ads-http.mjs';

/** A campaign exactly as `POST /v1/campaigns/query` returned it. */
const CAMPAIGN = {
	adAccountId: 23259140,
	bidStrategy: { bidStrategyGoal: 'TAP', bidStrategyType: 'MANUAL_CPT' },
	billingEvent: 'TAPS',
	creationTime: '2026-08-23T18:28:09.044',
	dailyBudget: { value: { amount: '1', currency: 'USD' } },
	deleted: false,
	displayStatus: 'RUNNING',
	id: 2144514548,
	modificationTime: '2026-08-26T22:10:05.085',
	name: 'Wrenchy · Brand · US',
	promotedObjectId: '6797103341',
	promotedObjectType: 'APPSTORE_APP',
	status: 'ENABLED',
	systemStatus: 'RUNNING',
	systemStatusLimitingReasons: [],
	targeting: { countryOrRegion: { include: ['US'] }, supplyPlacement: { include: ['APPSTORE_SEARCH_RESULTS'] } },
};

/** An ad group and a keyword, likewise captured live. */
const AD_GROUP = {
	adAccountId: 23259140,
	automatedKeywordsOptIn: false,
	bidStrategy: { bid: { amount: '0.3', currency: 'USD' }, bidStrategyGoal: 'TAP', bidStrategyType: 'MANUAL_CPT' },
	campaignId: 2144514548,
	displayStatus: 'RUNNING',
	id: 2150517787,
	modificationTime: '2026-08-26T22:10:14.224',
	name: 'Brand · Exact',
	status: 'ENABLED',
};
const KEYWORD = {
	adGroupId: 2150517787,
	bid: { amount: '0.3', currency: 'USD' },
	campaignId: 2144514548,
	id: 2304141389,
	matchType: 'EXACT',
	modificationTime: '2026-08-26T22:10:14.224',
	status: 'ENABLED',
	text: 'wrenchy car service log',
};

// ── request grammar ─────────────────────────────────────────────────────────

test('a filter carries `value`, singular — `values` is what v1 rejects', () => {
	assert.deepEqual(filter('campaignId', 2144514548), { field: 'campaignId', operator: 'EQUALS', value: 2144514548 });
	assert.equal('values' in filter('campaignId', 1), false);
});

test('campaignId defaults to EQUALS, which is the only operator v1 accepts for it', () => {
	assert.equal(filter('campaignId', 1).operator, 'EQUALS');
	assert.equal(filter('text', ['a'], 'IN').operator, 'IN');
});

test('pagination is pageSize/offset — limit, size and maxResults are all refused', () => {
	assert.deepEqual(queryBody({ pageSize: 2, offset: 4 }).pagination, { pageSize: 2, offset: 4 });
	assert.equal('pagination' in queryBody(), false, 'an unpaged body carries no pagination block at all');
	assert.deepEqual(queryBody({ filters: [filter('campaignId', 7)] }), { filters: [{ field: 'campaignId', operator: 'EQUALS', value: 7 }] });
	assert.deepEqual(queryBody({ sorting: [{ field: 'name' }] }).sorting, [{ field: 'name', sortOrder: 'ASC' }]);
});

test('paging walks by offset and stops on a short page', async () => {
	const pages = [];
	const rows = await queryAll(async (body) => {
		pages.push(body.pagination);
		const offset = body.pagination.offset;
		return { rows: offset === 0 ? [1, 2] : [3], pageSize: 2 };
	}, { pageSize: 2 });
	assert.deepEqual(rows, [1, 2, 3]);
	assert.deepEqual(pages, [{ pageSize: 2, offset: 0 }, { pageSize: 2, offset: 2 }]);
});

test('paging stops at max rather than following a server that never shortens', async () => {
	const rows = await queryAll(async () => ({ rows: [1, 2], pageSize: 2 }), { pageSize: 2, max: 4 });
	assert.equal(rows.length, 4);
});

// ── response envelope ───────────────────────────────────────────────────────

test('result is a bare array on every query endpoint, not a rows wrapper', () => {
	assert.deepEqual(rowsOfV1({ result: [CAMPAIGN] }), [CAMPAIGN]);
	assert.deepEqual(rowsOfV1({ result: { orgId: 1 } }), [{ orgId: 1 }], 'a single object still reads as one row');
	assert.deepEqual(rowsOfV1({ result: null }), []);
	assert.deepEqual(rowsOfV1(undefined), []);
	assert.deepEqual(paginationOfV1({ pagination: { pageSize: 4, offset: 0 } }), { pageSize: 4, offset: 0 });
});

test('the two error envelopes are told apart, because they mean different things', () => {
	const v1 = { error: { code: 'VALIDATION_ERROR', details: [{ code: 'REQUEST_UNRECOGNIZED_PROPERTY', message: 'Unrecognized field [limit].', info: { field: 'limit' } }] } };
	assert.equal(isLegacyPayload(v1), false);
	assert.match(errorTextV1(v1), /VALIDATION_ERROR.*Unrecognized field \[limit\]\.\s*\[limit\]/);

	const legacy = { data: null, pagination: null, error: { errors: [{ messageCode: 'RESOURCE_NOT_FOUND', message: 'Resource not found', field: '' }] } };
	assert.equal(isLegacyPayload(legacy), true, 'a legacy envelope means the path is not a v1 path');
	assert.match(errorTextV1(legacy), /RESOURCE_NOT_FOUND/);
	assert.equal(errorTextV1(null, 500), 'HTTP 500');
});

test('money is read from either nesting, because campaigns and keywords disagree', () => {
	assert.deepEqual(moneyOfV1(CAMPAIGN.dailyBudget), { amount: 1, currency: 'USD' }, 'campaign budgets nest under value');
	assert.deepEqual(moneyOfV1(KEYWORD.bid), { amount: 0.3, currency: 'USD' }, 'a keyword bid does not');
	assert.deepEqual(moneyOfV1(undefined), { amount: 0, currency: 'USD' });
	assert.deepEqual(amountV1(1.5), { amount: '1.50', currency: 'USD' });
});

test('a v1 timestamp has no zone, so one is added rather than assumed local', () => {
	assert.equal(v1Time('2026-08-23T18:28:09.044'), '2026-08-23T18:28:09.044Z');
	assert.equal(v1Time('2026-08-23T18:28:09.044Z'), '2026-08-23T18:28:09.044Z', 'an existing zone is left alone');
	assert.equal(v1Time('2026-08-23T18:28:09+02:00'), '2026-08-23T18:28:09+02:00');
	assert.equal(v1Time(null), null);
});

// ── request bodies ──────────────────────────────────────────────────────────

test('a campaign body puts geo and placement inside targeting', () => {
	const body = campaignBodyV1({ name: 'X', dailyBudget: 3, countriesOrRegions: ['US', 'CA'], supplySources: ['APPSTORE_SEARCH_RESULTS'] }, 6797103341, 'USD');
	assert.deepEqual(body.targeting, { countryOrRegion: { include: ['US', 'CA'] }, supplyPlacement: { include: ['APPSTORE_SEARCH_RESULTS'] } });
	assert.equal('countriesOrRegions' in body, false, 'the v5 spelling is gone, not merely renamed');
	assert.equal('supplySources' in body, false);
});

test('a campaign body carries the extra dailyBudget.value level the guide omits', () => {
	const body = campaignBodyV1({ name: 'X', dailyBudget: 3, countriesOrRegions: ['US'] }, 1, 'USD');
	assert.deepEqual(body.dailyBudget, { value: { amount: '3.00', currency: 'USD' } });
	assert.equal('dailyBudgetAmount' in body, false);
});

test('a campaign promotes an object by id and type, and neither may be updated', () => {
	const cp = { name: 'X', dailyBudget: 3, countriesOrRegions: ['US'], startTime: '2026-09-01' };
	const body = campaignBodyV1(cp, 6797103341, 'USD');
	assert.equal(body.promotedObjectId, '6797103341');
	assert.equal(body.promotedObjectType, 'APPSTORE_APP');
	assert.equal('adamId' in body, false);
	const update = campaignUpdateV1(cp, 6797103341, 'USD');
	for (const immutable of ['promotedObjectId', 'promotedObjectType', 'billingEvent', 'startTime'])
		assert.equal(immutable in update, false, `${immutable} is immutable after create`);
	assert.deepEqual(update.dailyBudget, body.dailyBudget, 'what can change, still does');
});

test('an ad group bid moves into bidStrategy and pricingModel disappears', () => {
	const body = adGroupBodyV1({ name: 'G', defaultBidAmount: 0.6 }, 'USD');
	assert.deepEqual(body.bidStrategy, { bid: { amount: '0.60', currency: 'USD' }, bidStrategyGoal: 'TAP', bidStrategyType: 'MANUAL_CPT' });
	assert.equal('pricingModel' in body, false, 'CPC is carried by the bid strategy now');
	assert.equal('defaultBidAmount' in body, false);
});

test('a keyword bid is plain `bid`, and ACTIVE became ENABLED', () => {
	const create = keywordBodyV1({ text: 'car log', matchType: 'EXACT', bid: 0.3 }, 2150517787, 'USD');
	assert.deepEqual(create, { adGroupId: 2150517787, text: 'car log', matchType: 'EXACT', bid: { amount: '0.30', currency: 'USD' }, status: 'ENABLED' });
	assert.equal('bidStrategy' in create, false, 'bidStrategy.bid is the ad-group spelling and is rejected here');

	const update = keywordBodyV1({ id: 7, status: 'ACTIVE' }, 1, 'USD');
	assert.deepEqual(update, { id: 7, status: 'ENABLED' }, 'an update addresses by id and carries no bid it was not given');
	assert.equal(keywordBodyV1({ id: 7, status: 'PAUSED' }, 1, 'USD').status, 'PAUSED');
});

test('a creative is its own entity, and a CPP one names the product page', () => {
	const dpp = creativeBodyV1('Glovebox DPP', 6797103341);
	assert.equal(dpp.creativeType, 'DEFAULT_PRODUCT_PAGE');
	assert.deepEqual(dpp.destination.parameters, { adamId: '6797103341' });
	const cpp = creativeBodyV1('Runners · CPP', 6797103341, 998877);
	assert.equal(cpp.creativeType, 'CUSTOM_PRODUCT_PAGE');
	assert.equal(cpp.destination.parameters.productPageId, '998877');
});

// ── normalisation ───────────────────────────────────────────────────────────

test('a live campaign normalises to the shape the reconciler already speaks', () => {
	const cp = normaliseCampaignV1(CAMPAIGN);
	assert.equal(cp.id, '2144514548');
	assert.equal(cp.dailyBudget, 1);
	assert.deepEqual(cp.countriesOrRegions, ['US']);
	assert.deepEqual(cp.supplyPlacement, ['APPSTORE_SEARCH_RESULTS']);
	assert.equal(cp.modificationTime, '2026-08-26T22:10:05.085Z');
	assert.deepEqual(cp.limitingReasons, []);
});

test('a live ad group and keyword normalise off their own bid spellings', () => {
	assert.equal(normaliseAdGroupV1(AD_GROUP).defaultBidAmount, 0.3);
	assert.equal(normaliseAdGroupV1(AD_GROUP).campaignId, '2144514548');
	assert.equal(normaliseKeywordV1(KEYWORD).bidAmount, 0.3);
	assert.equal(normaliseKeywordV1(KEYWORD).text, 'wrenchy car service log');
	assert.equal(normaliseKeywordV1({}).id, null, 'a row with nothing in it normalises rather than throwing');
	assert.equal(normaliseCampaignV1(undefined).id, null);
});

// ── http ────────────────────────────────────────────────────────────────────

const okFetch = (payload, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(payload) });
const ctx = { adAccountId: 23259140, token: async () => 'tok' };

test('a request signs with the borrowed token and the ad account context', async () => {
	let seen = null;
	await v1Request(PATHS.me, {
		...ctx,
		fetch: async (url, init) => {
			seen = { url, init };
			return { ok: true, status: 200, text: async () => JSON.stringify({ result: { orgId: 1 } }) };
		},
	});
	assert.equal(seen.url, `${V1_BASE}me`);
	assert.equal(seen.init.headers.Authorization, 'Bearer tok');
	assert.equal(seen.init.headers['X-AP-Context'], 'adAccountId=23259140');
	assert.equal(seen.init.body, undefined, 'a GET carries no body and no content-type');
});

test('a query POSTs the body and pages until the rows run out', async () => {
	const bodies = [];
	const rows = await v1Query(PATHS.campaigns, {
		...ctx,
		fetch: async (_url, init) => {
			const body = JSON.parse(init.body);
			bodies.push(body);
			const first = body.pagination.offset === 0;
			return { ok: true, status: 200, text: async () => JSON.stringify({ result: first ? [CAMPAIGN, CAMPAIGN] : [CAMPAIGN], pagination: { pageSize: 2, offset: body.pagination.offset } }) };
		},
	}, { filters: [filter('campaignId', 7)], pageSize: 2 });
	assert.equal(rows.length, 3);
	assert.deepEqual(bodies[0].filters, [{ field: 'campaignId', operator: 'EQUALS', value: 7 }]);
});

test('an ad account id is required before anything is sent', async () => {
	await assert.rejects(() => v1Request(PATHS.me, { adAccountId: '', token: async () => 't', fetch: okFetch({}) }), /no Apple Ads ad account id/);
});

test('503 reads as an unrouted path, because on this host that is what it means', () => {
	const err = v1Error('ad-groups/query', 503, null, '<html>503</html>');
	assert.match(err.message, /not a routed path/);
	assert.match(err.hint, /adgroups.*not.*ad-groups/);
});

test('a legacy error envelope reads as "not a v1 path", not as a bad request', () => {
	const err = v1Error('reports/campaigns/query', 404, { data: null, error: { errors: [{ messageCode: 'RESOURCE_NOT_FOUND' }] } }, '');
	assert.match(err.message, /not a v1 path/);
	assert.match(err.hint, /legacy v5 service/);
});

test("a rejected body surfaces Apple's own field-level complaint", async () => {
	const payload = { error: { code: 'VALIDATION_ERROR', details: [{ code: 'REQUEST_UNRECOGNIZED_PROPERTY', message: 'Unrecognized field [limit]', info: { field: 'limit' } }] } };
	await assert.rejects(() => v1Request(PATHS.campaigns, { ...ctx, method: 'POST', body: {}, fetch: okFetch(payload, 400) }), (err) => {
		assert.match(err.hint, /Unrecognized field \[limit\]/);
		return true;
	});
});

test('a body that is not JSON at all still fails with the status', async () => {
	await assert.rejects(
		() => v1Request(PATHS.me, { ...ctx, fetch: async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) }),
		/failed/,
	);
});

test('v1Me answers rather than throws, so a probe can report why it failed', async () => {
	assert.deepEqual(await v1Me({ ...ctx, fetch: okFetch({ result: { orgId: 23259140, userId: 107265077 } }) }), {
		ok: true, orgId: 23259140, userId: 107265077, detail: '',
	});
	const bad = await v1Me({ ...ctx, fetch: okFetch(null, 503) });
	assert.equal(bad.ok, false);
	assert.match(bad.detail, /not a routed path/);
});

test('the token is read from whichever key asc used', () => {
	assert.equal(tokenFrom('{"access_token":"a"}'), 'a');
	assert.equal(tokenFrom('{"accessToken":"b"}'), 'b');
	assert.equal(tokenFrom('some banner\n{"token":"c"}'), 'c', 'asc occasionally prefixes a banner');
	assert.throws(() => tokenFrom('not json'), /no JSON/);
	assert.throws(() => tokenFrom('{"expires_in":3600}'), /carried no token/);
});

test('reading the account filters ad groups and keywords by campaign, not by path', async () => {
	const asked = [];
	const { campaigns, adGroups, keywords } = await v1Account({
		...ctx,
		fetch: async (url, init) => {
			const body = JSON.parse(init.body);
			asked.push({ url: String(url).replace(V1_BASE, ''), filters: body.filters });
			const rows = url.endsWith(PATHS.campaigns) ? [CAMPAIGN] : url.endsWith(PATHS.adGroups) ? [AD_GROUP] : [KEYWORD];
			return { ok: true, status: 200, text: async () => JSON.stringify({ result: rows, pagination: { pageSize: 100, offset: 0 } }) };
		},
	});
	assert.deepEqual(campaigns.map((c) => c.id), ['2144514548']);
	assert.deepEqual(adGroups.map((g) => g.id), ['2150517787']);
	assert.deepEqual(keywords.map((k) => k.text), ['wrenchy car service log']);
	assert.deepEqual(asked.map((a) => a.url), [PATHS.campaigns, PATHS.adGroups, PATHS.keywords]);
	// The v5 route carried the parent in the path; v1 carries it in the body.
	assert.deepEqual(asked[1].filters, [{ field: 'campaignId', operator: 'EQUALS', value: 2144514548 }]);
	assert.deepEqual(asked[2].filters, asked[1].filters);
});

test('a campaign with no id is skipped rather than queried with a null parent', async () => {
	const { adGroups } = await v1Account({
		...ctx,
		fetch: okFetch({ result: [{ name: 'no id here' }], pagination: { pageSize: 100, offset: 0 } }),
	});
	assert.deepEqual(adGroups, []);
});
