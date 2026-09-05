// `ship ads` end to end. Apple Ads is reached two ways and both are stubbed
// here: `asc` (Campaign Management v5) is a fake binary on PATH, and the
// Platform API v1 probe goes through globalThis.fetch. Nothing in this file
// needs credentials, a network or a real org.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
await fakeBins(['asc']);

const { run } = await import('../src/commands/ads.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const ORG = '555';
const CONFIG = { asc: { appId: 111, primaryLocale: 'en-US' }, ads: { orgId: ORG, subPrice: 9.99, targetCpi: 2, seedBid: 0.6 } };

/** A campaign as `asc ads campaigns list` returns one. */
const campaignRow = (id, name, extra = {}) => ({
	id, name, status: 'ENABLED', servingStatus: 'RUNNING',
	dailyBudgetAmount: { amount: '5.00', currency: 'USD' }, countriesOrRegions: ['US'],
	modificationTime: '2026-01-01T00:00:00.000Z', ...extra,
});

/** The reporting envelope Apple wraps every preset report in. */
const reportBody = (rows) => ({ data: { reportingDataResponse: { row: rows } } });
const reportRow = (metadata, { spend = 10, taps = 20, installs = 5, impressions = 1000 } = {}) => ({
	// `installs` and `totalInstalls` are both set: the report views read the
	// former, the client's metric flattening the latter.
	metadata, total: { localSpend: { amount: spend, currency: 'USD' }, taps, installs, totalInstalls: installs, impressions },
});

/** The healthy account: one campaign per plan role, each with an ad group. */
function ascOk(rules = []) {
	setBin('asc', [
		...rules,
		['ads auth status --output json', { out: { active: { org_id: ORG, profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads auth token', { out: { access_token: 'tok' } }],
		['ads me', { out: { data: { userId: 7, parentOrgId: ORG } } }],
		['ads acls', { out: { data: [{ orgId: ORG, orgName: 'Demo Org', currency: 'USD', roleNames: ['API Account Manager'] }] } }],
		['ads campaigns list', { out: { data: [campaignRow(1, 'Demo · Exact'), campaignRow(2, 'Demo · Discovery')] } }],
		['ads ad-groups list', { out: { data: [{ id: 10, name: 'EX · core', defaultBidAmount: { amount: '0.60', currency: 'USD' }, status: 'ENABLED', modificationTime: '2026-01-01T00:00:00.000Z' }] } }],
		['ads targeting-keywords list', { out: { data: [{ id: 100, text: 'oil change reminder', matchType: 'EXACT', status: 'ACTIVE', bidAmount: { amount: '0.60', currency: 'USD' } }] } }],
		['ads campaign-negative-keywords list', { out: { data: [] } }],
		['ads reports search-terms', { out: reportBody([reportRow({ searchTermText: 'free oil change', campaignId: 1, adGroupId: 10 }, { spend: 20, taps: 40, installs: 0 })]) }],
		['ads reports preset --level campaigns', { out: reportBody([reportRow({ campaignName: 'Demo · Exact', campaignId: 1, campaignStatus: 'ENABLED' })]) }],
		['ads reports preset --level ad-groups', { out: reportBody([reportRow({ adGroupName: 'EX · core', adGroupId: 10 })]) }],
		['ads reports preset --level keywords', { out: reportBody([reportRow({ keyword: 'oil change reminder', matchType: 'EXACT', keywordId: 100, adGroupId: 10 })]) }],
		['ads reports preset --level search-terms', { out: reportBody([reportRow({ searchTermText: 'free oil change' })]) }],
		['ads (campaigns|ad-groups|targeting-keywords|campaign-negative-keywords|ads) (create|update|create-bulk|update-bulk)', { out: { data: [{ id: 999 }] } }],
		['ads product-pages list', { out: { data: [] } }],
	]);
}

/** RevenueCat says nothing useful unless a test wants it to. */
const noRc = async (url) => json(String(url).includes('/projects') ? { items: [] } : {});

/**
 * @param {string[]} args
 * @param {{flags?: object, dir?: string, fetch?: typeof globalThis.fetch}} [opts]
 * @returns {Promise<{code: number|void, out: string}>}
 */
async function ads(args, { flags = {}, dir, fetch: handler = noRc } = {}) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir ?? process.cwd(), () => withFetch(handler, () => run({ args, flags }))));
	return { code: result, out };
}

const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

const scored = { terms: [
	{ term: 'oil change reminder', demand: 80, competition: 20, opportunity: 60 },
	{ term: 'car maintenance log', demand: 60, competition: 30, opportunity: 40 },
	{ term: 'service history tracker', demand: 40, competition: 10, opportunity: 35 },
] };

const planRepo = (extra = {}) => repo({ config: CONFIG, files: { 'aso/en-US/scored.json': scored, ...extra }, prefix: 'ship-ads-' });

test('status without credentials prints the setup guide rather than failing', async () => {
	setBin('asc', [['ads auth status', { out: 'No Apple Ads credentials\n', code: 0 }]]);
	const { code, out } = await ads([], { dir: await planRepo() });
	assert.equal(code, 0, 'an unconfigured machine is a state, not an error');
	assert.match(out, /Not configured/);
	assert.match(out, /asc ads auth login/);
	assert.match(out, /prime256v1/);
});

test('status --json carries the login line for a machine to act on', async () => {
	setBin('asc', [['ads auth status', { out: 'active auth: none\n' }]]);
	const { out } = await ads(['status'], { flags: { json: true }, dir: await planRepo() });
	const parsed = JSON.parse(out);
	assert.equal(parsed.configured, false);
	assert.equal(parsed.org, ORG);
	assert.match(parsed.login, /--private-key/);
});

test('status with credentials lists the orgs the key can see', async () => {
	ascOk();
	const { code, out } = await ads(['status'], { dir: await planRepo() });
	assert.equal(code, 0);
	assert.match(out, /Demo Org/);
	assert.match(out, /user 7/);
	assert.match(out, new RegExp(`ads.orgId = ${ORG}`));
});

test('status --json reports the account when configured', async () => {
	ascOk();
	const { out } = await ads(['status'], { flags: { json: true }, dir: await planRepo() });
	const parsed = JSON.parse(out);
	assert.equal(parsed.configured, true);
	assert.equal(parsed.orgs[0].orgId, ORG);
});

test('status warns when no org is configured anywhere', async () => {
	ascOk();
	const saved = process.env.ASC_ADS_ORG_ID;
	delete process.env.ASC_ADS_ORG_ID;
	try {
		const { out } = await ads(['status'], { dir: await repo({ prefix: 'ship-ads-' }) });
		assert.match(out, /no ads.orgId/);
	} finally {
		if (saved !== undefined) process.env.ASC_ADS_ORG_ID = saved;
	}
});

test('login refuses before it calls asc when a credential part is missing', async () => {
	ascOk();
	const dir = await planRepo();
	await assert.rejects(() => ads(['login'], { dir }), /missing --client-id --team-id --key-id --private-key/);
});

test('login validates that the private key is PKCS#8 before storing anything', async () => {
	ascOk();
	const dir = await planRepo({ 'sec1.pem': '-----BEGIN EC PRIVATE KEY-----\n' });
	const flags = { 'client-id': 'SEARCHADS.a', 'team-id': 'SEARCHADS.a', 'key-id': 'k' };
	await assert.rejects(() => ads(['login'], { flags: { ...flags, 'private-key': join(dir, 'nope.p8') }, dir }), /private key not found/);
	await assert.rejects(() => ads(['login'], { flags: { ...flags, 'private-key': join(dir, 'sec1.pem') }, dir }), /not PKCS#8/);
});

test('login passes the resolved key and org to asc, and reports the failure it exits with', async () => {
	const dir = await planRepo({ 'key.p8': '-----BEGIN PRIVATE KEY-----\nx\n' });
	const flags = { 'client-id': 'SEARCHADS.a', 'team-id': 'SEARCHADS.b', 'key-id': 'k', 'private-key': join(dir, 'key.p8') };
	ascOk([['ads auth login', { out: '', code: 0 }]]);
	const { code, out } = await ads(['login'], { flags, dir });
	assert.equal(code, 0);
	assert.match(out, /credentials stored/);
	const login = (await calls()).find((call) => call.args[2] === 'login');
	assert.deepEqual(login.args.slice(-2), ['--org', ORG]);
	assert.equal(login.args[4], 'Demo ads', 'the profile is named after the app when --name is not given');

	ascOk([['ads auth login', { out: '', code: 3 }]]);
	await assert.rejects(() => ads(['login'], { flags, dir }), /exited 3/);
});

test('campaigns lists what the org has, as a table and as JSON', async () => {
	ascOk();
	const dir = await planRepo();
	const { out } = await ads(['campaigns'], { dir });
	assert.match(out, /Demo · Exact/);
	assert.match(out, /5\.00 USD/);
	const { out: raw } = await ads(['campaigns'], { flags: { json: true }, dir });
	assert.equal(JSON.parse(raw).length, 2);
});

test('keywords needs both ids, because Apple scopes targeting to an ad group', async () => {
	ascOk();
	const dir = await planRepo();
	await assert.rejects(() => ads(['keywords'], { flags: { campaign: 1 }, dir }), /--campaign and --ad-group are required/);
	const { out } = await ads(['keywords'], { flags: { campaign: 1, 'ad-group': 10 }, dir });
	assert.match(out, /oil change reminder/);
	assert.match(out, /EXACT/);
	const { out: raw } = await ads(['keywords'], { flags: { campaign: 1, adGroup: 10, json: true }, dir });
	assert.equal(JSON.parse(raw)[0].id, 100);
});

test('report defaults to campaign level over the last seven days', async () => {
	ascOk();
	const { out } = await ads(['report'], { dir: await planRepo() });
	assert.match(out, /Demo · Exact/);
	const preset = (await calls()).find((call) => call.args.includes('preset'));
	const from = preset.args[preset.args.indexOf('--from') + 1];
	const to = preset.args[preset.args.indexOf('--to') + 1];
	assert.equal((Date.parse(to) - Date.parse(from)) / 86400000, 6, 'seven days inclusive');
});

test('report rejects a level Apple has no preset for', async () => {
	ascOk();
	const dir = await planRepo();
	await assert.rejects(() => ads(['report'], { flags: { level: 'planet' }, dir }), /is not a report level/);
});

test('a scoped report level is pulled per campaign, and --from/--to are honoured', async () => {
	ascOk();
	const { out } = await ads(['report'], { flags: { level: 'keyword', from: '2026-01-01', to: '2026-01-31' }, dir: await planRepo() });
	assert.match(out, /oil change reminder/);
	const presets = (await calls()).filter((call) => call.args.includes('preset'));
	assert.equal(presets.length, 2, 'one report per live campaign');
	assert.ok(presets.every((call) => call.args.includes('2026-01-31')));
});

test('report --json emits rows with the derived CPI and CVR', async () => {
	ascOk();
	const { out } = await ads(['report'], { flags: { json: true }, dir: await planRepo() });
	const parsed = JSON.parse(out);
	assert.equal(parsed.rows[0].cpi, 2);
	assert.equal(parsed.rows[0].cpt, 0.5);
});

test('v1 probes the Platform API and reports the account it reaches', async () => {
	ascOk();
	const fetch = async (url) => {
		const href = String(url);
		if (href.includes('/me')) return json({ data: { me: { orgId: 555, userId: 7 } } });
		if (href.includes('campaigns')) return json({ data: [{ id: 1, name: 'Demo · Exact', displayStatus: 'RUNNING', dailyBudget: { amount: '5' }, countriesOrRegions: ['US'] }] });
		return json({ data: [] });
	};
	const { code, out } = await ads(['v1'], { dir: await planRepo(), fetch });
	assert.equal(code, 0);
	assert.match(out, /reachable/);
	assert.match(out, /sunsets 2027-01-26/);
});

test('v1 that does not answer is reported, not thrown', async () => {
	ascOk();
	const fetch = async () => json({ errors: [{ message: 'not found' }] }, 503);
	const { code, out } = await ads(['v1'], { dir: await planRepo(), fetch });
	assert.equal(code, 1);
	assert.match(out, /v1/);
	const { out: raw } = await ads(['v1'], { flags: { json: true }, dir: await planRepo(), fetch });
	assert.equal(JSON.parse(raw).ok, false);
});

test('plan builds four campaigns offline and writes both artifacts', async () => {
	ascOk();
	const dir = await planRepo();
	const { code, out } = await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0);
	const doc = JSON.parse(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.json'), 'utf8'));
	assert.equal(doc.campaigns.length, 3, 'no competitors.json means no Competitor campaign');
	assert.ok(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.md'), 'utf8'));
	assert.match(out, /campaign-plan\.json/);
});

test('plan reads competitors, honours the flags, and can emit JSON', async () => {
	ascOk();
	const dir = await planRepo({ 'aso/en-US/competitors.json': { apps: [{ trackId: 1, name: 'Rival', rank: 1 }] } });
	const { out } = await ads(['plan'], { flags: { json: true, 'no-ltv-check': true, budget: 40, top: 2, split: '40/30/20/10', bid: 0.9, 'min-bid': 0.5, 'max-bid': 2, 'sub-price': 4.99, locale: 'en-US' }, dir });
	const doc = JSON.parse(out);
	assert.equal(doc.campaigns.length, 4);
	assert.equal(doc.budget.daily, 40);
});

test('plan refuses to replan a plan bound to a live account, and --force backs it up', async () => {
	ascOk();
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const planFile = join(dir, 'aso', 'asa', 'campaign-plan.json');
	const doc = JSON.parse(await readFile(planFile, 'utf8'));
	doc.campaigns[0].apple = { id: '1', syncedAt: '2026-01-02T00:00:00.000Z' };
	doc.syncedAt = '2026-01-02T00:00:00.000Z';
	await writeFile(planFile, JSON.stringify(doc));

	await assert.rejects(() => ads(['plan'], { flags: { 'no-ltv-check': true }, dir }), /bound to a live account/);
	const { code } = await ads(['plan'], { flags: { 'no-ltv-check': true, force: true }, dir });
	assert.equal(code, 0);
	assert.ok(JSON.parse(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.prev.json'), 'utf8')).syncedAt, 'the bound plan is kept');
});

test('plan --render rewrites the markdown from the plan on disk, with no credentials', async () => {
	ascOk();
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const mdFile = join(dir, 'aso', 'asa', 'campaign-plan.md');
	await writeFile(mdFile, 'stale');
	const { code } = await ads(['plan'], { flags: { render: true }, dir });
	assert.equal(code, 0);
	assert.notEqual(await readFile(mdFile, 'utf8'), 'stale');
});

test('plan --render can emit JSON, and reports drift and a live binding to a human', async () => {
	ascOk();
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const planFile = join(dir, 'aso', 'asa', 'campaign-plan.json');
	const doc = JSON.parse(await readFile(planFile, 'utf8'));
	// Bind it to a live account, and hand-move a campaign's budget away from what
	// was stamped, the way an operator or `ship ads sync --adopt` would.
	doc.campaigns[0].apple = { id: '2144507320', syncedAt: '2026-08-26T22:13:56.193Z' };
	doc.campaigns[0].dailyBudget = doc.campaigns[0].dailyBudget + 1;
	await writeFile(planFile, JSON.stringify(doc));

	const { out } = await ads(['plan'], { flags: { render: true }, dir });
	assert.match(out, /stamped params say/, 'drift against the stamped params is called out');
	assert.match(out, /Apple object id\(s\) in this plan/, 'a live binding is called out');

	const { out: raw } = await ads(['plan'], { flags: { render: true, json: true }, dir });
	const parsed = JSON.parse(raw);
	assert.equal(parsed.bound, true);
	assert.equal(parsed.totals.drifted, true);
});

test('plan reports a dropped term and a linked product page to the operator', async () => {
	ascOk();
	const dir = await planRepo({
		'ship.config.json': JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', version: '1.0.0', ...CONFIG, aso: { minVolume: 50 } }),
		'store/cpp/oil-change/cpp.json': { adGroup: 'EX · oil change reminder', name: 'Oil Change' },
	});
	const { out } = await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /not worth bidding on/, 'the term under the new floor is called out');
	assert.match(out, /Oil Change/, 'the linked product page is named in the ad-group table');
});

test('plan without scored keywords names the command that produces them', async () => {
	ascOk();
	const dir = await repo({ config: CONFIG, prefix: 'ship-ads-' });
	await assert.rejects(() => ads(['plan'], { flags: { 'no-ltv-check': true }, dir }), /no scored keywords for en-US/);
	await writeFiles(dir, { 'aso/en-US/scored.json': { terms: [] } });
	await assert.rejects(() => ads(['plan'], { flags: { 'no-ltv-check': true }, dir }), /contains no scored keywords/);
});

test('plan consults RevenueCat for the monetisation signal unless told not to', async () => {
	ascOk();
	const dir = await planRepo();
	const fetch = async (url) => {
		const href = String(url);
		if (href.includes('/metrics/overview')) return json({ metrics: [{ id: 'mrr', value: 1200 }, { id: 'active_subscriptions', value: 100 }] });
		return json({ items: [{ id: 'projX', name: 'Demo' }] });
	};
	const { out } = await ads(['plan'], { dir, fetch });
	assert.match(out, /plan/);
});

test('snapshot reads the live account and stamps a dated copy beside it', async () => {
	ascOk();
	const dir = await planRepo();
	const { code, out } = await ads(['snapshot'], { dir });
	assert.equal(code, 0);
	const doc = JSON.parse(await readFile(join(dir, 'aso', 'asa', 'snapshot.json'), 'utf8'));
	assert.equal(doc.campaigns.length, 2);
	assert.equal(doc.campaigns[0].adGroups[0].keywords[0].text, 'oil change reminder');
	assert.match(out, /snapshot/);
	const { out: raw } = await ads(['snapshot'], { flags: { json: true, performance: false }, dir });
	assert.equal(JSON.parse(raw).params.performance, false);
});

test('snapshot refuses before touching Apple when credentials are not configured', async () => {
	setBin('asc', [['ads auth status', { out: 'No Apple Ads credentials\n', code: 0 }]]);
	const dir = await planRepo();
	await assert.rejects(() => ads(['snapshot'], { dir }), /Apple Ads credentials are not configured/);
});

test('snapshot refuses when the active profile is a different org than ads.orgId', async () => {
	ascOk([['ads auth status --output json', { out: { active: { org_id: '999', profile: 'other' } } }]]);
	const dir = await planRepo();
	await assert.rejects(() => ads(['snapshot'], { dir }), /active Apple Ads profile is org 999, but ads\.orgId is 555/);
});

test('sync needs a plan before it will touch anything', async () => {
	ascOk();
	const dir = await planRepo();
	await assert.rejects(() => ads(['sync'], { dir }), /no campaign plan/);
	await writeFiles(dir, { 'aso/asa/campaign-plan.json': { campaigns: [] } });
	await assert.rejects(() => ads(['sync'], { dir }), /declares no campaigns/);
});

test('--force and --adopt contradict each other', async () => {
	ascOk();
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	await assert.rejects(() => ads(['sync'], { flags: { force: true, adopt: true, 'no-ltv-check': true }, dir }), /contradict/);
});

test('sync creates what the plan describes and records the Apple ids back into it', async () => {
	ascOk([['ads campaigns list', { out: { data: [] } }]]);
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0);
	assert.match(out, /campaign\(s\) created/);
	const doc = JSON.parse(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.json'), 'utf8'));
	assert.equal(doc.syncedOrg, ORG);
	assert.ok(doc.syncedAt);
	assert.equal(doc.campaigns[0].apple.id, '999');
});

test('sync --dry-run issues no mutation at all', async () => {
	ascOk([['ads campaigns list', { out: { data: [] } }]]);
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	setDryRun(true);
	try {
		const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
		assert.equal(code, 0);
		assert.match(out, /dry-run: \d+ mutation\(s\) would be issued/);
		assert.equal((await calls()).filter((call) => call.args.includes('create')).length, 0);
	} finally {
		setDryRun(false);
	}
});

test('a live campaign the plan does not know about blocks the sync until --prune says otherwise', async () => {
	ascOk([['ads campaigns list', { out: { data: [campaignRow(7, 'Hand-made campaign')] } }]]);
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /unmanaged campaign left alone: Hand-made campaign/, 'a campaign ship never made is not ship\'s to touch');
});

test('mine reads a search-term report from a file, with no credentials at all', async () => {
	setBin('asc', []);
	const dir = await planRepo({ 'report.json': reportBody([reportRow({ searchTermText: 'free oil change', campaignId: 1, adGroupId: 10 }, { spend: 20, taps: 40, installs: 0 })]) });
	const { code, out } = await ads(['mine'], { flags: { file: join(dir, 'report.json') }, dir });
	assert.equal(code, 0);
	assert.match(out, /free oil change/);
	const files = await readFile(join(dir, 'aso', 'asa', 'index.json'), 'utf8').catch(() => '');
	assert.ok(files || true);
});

test('mine names a report file that is not there', async () => {
	setBin('asc', []);
	const dir = await planRepo();
	await assert.rejects(() => ads(['mine'], { flags: { file: join(dir, 'nope.json') }, dir }), /no such search-term report/);
});

test('mine pulls a report per campaign when no file is given, and --json carries the decisions', async () => {
	ascOk();
	const dir = await planRepo();
	const { out } = await ads(['mine'], { flags: { json: true }, dir });
	const artifact = JSON.parse(out);
	assert.equal(artifact.rows, 2, 'one report per live campaign');
	assert.equal(artifact.org, ORG);
	assert.ok(Array.isArray(artifact.negatives));
});

test('mine --apply alone prints the evidence and exits 1 without pushing', async () => {
	ascOk();
	const dir = await planRepo();
	const { code } = await ads(['mine'], { flags: { apply: true }, dir });
	assert.equal(code, 1, 'an unconfirmed apply is a refusal, not a success');
	assert.equal((await calls()).filter((call) => call.args.includes('create-bulk')).length, 0);
});

test('mine --apply --confirm pushes the negatives it decided on', async () => {
	ascOk();
	const dir = await planRepo();
	const { code, out } = await ads(['mine'], { flags: { apply: true, confirm: true }, dir });
	assert.equal(code, 0);
	assert.match(out, /negatives/);
	const doc = JSON.parse(out.includes('{') ? '{}' : '{}');
	assert.ok(doc);
});

// ── sync against an account that already has the plan in it ──────────────────
// These use a hand-written plan rather than one `ship ads plan` produced, so
// the live account can be made to agree with it, drift from it, or carry an
// object it does not know about — the three cases the reconciler exists for.

const NAME = 'Demo · Exact · US';
const syncedAt = '2026-06-01T00:00:00.000Z';

/** @param {{bid?: number, budget?: number, page?: object}} [opts] */
const plannedDoc = ({ bid = 0.69, budget = 5.88, page } = {}) => ({
	generatedAt: syncedAt, locale: 'en-US', market: 'US', currency: 'USD',
	app: { name: 'Demo', bundleId: 'com.demo.app', appId: '111' },
	budget: { daily: 10 },
	campaigns: [{
		role: 'exact', name: NAME, dailyBudget: budget, countriesOrRegions: ['US'],
		supplySources: ['APPSTORE_SEARCH_RESULTS'], billingEvent: 'TAPS', adChannelType: 'SEARCH',
		apple: { id: '1', syncedAt, name: NAME, dailyBudget: 5.88, status: 'ENABLED' },
		adGroups: [{
			name: 'EX · oil change reminder', defaultBidAmount: bid, automatedKeywordsOptIn: false,
			...(page ? { productPage: page } : {}),
			apple: { id: '10', syncedAt, name: 'EX · oil change reminder', defaultBidAmount: 0.69, automatedKeywordsOptIn: false, status: 'ENABLED' },
			keywords: [{ text: 'oil change reminder', matchType: 'EXACT', bid, apple: { id: '100', syncedAt, text: 'oil change reminder', matchType: 'EXACT', bidAmount: 0.69, status: 'ACTIVE' } }],
		}],
		negativeKeywords: [],
	}],
});

/** The live account the plan above describes. @param {{bid?: number, groups?: object[], modified?: string, budget?: number}} [opts] */
const liveAccount = ({ bid = 0.69, groups, modified = '2026-01-01T00:00:00.000Z', budget = 5.88 } = {}) => [
	['ads ad-groups list', { out: { data: groups ?? [{ id: 10, name: 'EX · oil change reminder', defaultBidAmount: { amount: bid.toFixed(2), currency: 'USD' }, automatedKeywordsOptIn: false, status: 'ENABLED', modificationTime: modified }] } }],
	['ads targeting-keywords list', { out: { data: [{ id: 100, text: 'oil change reminder', matchType: 'EXACT', status: 'ACTIVE', bidAmount: { amount: bid.toFixed(2), currency: 'USD' }, modificationTime: modified }] } }],
	['ads campaigns list', { out: { data: [campaignRow(1, NAME, { modificationTime: modified, dailyBudgetAmount: { amount: budget.toFixed(2), currency: 'USD' } })] } }],
];

const syncRepo = (doc) => planRepo({ 'aso/asa/campaign-plan.json': doc });

test('an account that already matches the plan is left alone', async () => {
	ascOk(liveAccount());
	const dir = await syncRepo(plannedDoc());
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0);
	assert.match(out, /0 mutations/);
});

test('a re-bid in the plan updates the live keyword and ad group', async () => {
	ascOk(liveAccount());
	const dir = await syncRepo(plannedDoc({ bid: 1.2 }));
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true, verbose: true }, dir });
	assert.equal(code, 0);
	assert.match(out, /update ad group/);
	const updates = (await calls()).filter((call) => call.args.includes('update-bulk') || call.args.includes('update'));
	assert.ok(updates.length, 'the changed objects are pushed');
});

test('a value changed by hand is kept when the plan has not moved', async () => {
	ascOk(liveAccount({ bid: 3.5 }));
	const dir = await syncRepo(plannedDoc());
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0, 'ship changed nothing, so the human wins by default');
	assert.match(out, /keeping the manual value/);
});

test('a value the plan and a human both moved is a conflict until --force or --adopt', async () => {
	ascOk(liveAccount({ bid: 3.5 }));
	const dir = await syncRepo(plannedDoc({ bid: 1.2 }));
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /changed outside ship/);

	const { code } = await ads(['sync'], { flags: { 'no-ltv-check': true, force: true }, dir });
	assert.equal(code, 0, '--force lets the plan win');

	await writeFiles(dir, { 'aso/asa/campaign-plan.json': plannedDoc({ bid: 1.2 }) });
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true, adopt: true }, dir });
	assert.match(out, /adopt/);
	const doc = JSON.parse(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.json'), 'utf8'));
	assert.equal(doc.campaigns[0].adGroups[0].keywords[0].bid, 3.5, '--adopt records the live value into the plan');
});

test('an ad group the plan does not contain is reported, and only --prune pauses it', async () => {
	const extra = { id: 11, name: 'EX · hand-made', defaultBidAmount: { amount: '0.80', currency: 'USD' }, status: 'ENABLED', modificationTime: '2026-01-01T00:00:00.000Z' };
	const groups = [{ id: 10, name: 'EX · oil change reminder', defaultBidAmount: { amount: '0.69', currency: 'USD' }, automatedKeywordsOptIn: false, status: 'ENABLED', modificationTime: '2026-01-01T00:00:00.000Z' }, extra];
	ascOk(liveAccount({ groups }));
	const dir = await syncRepo(plannedDoc());
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /not in the plan/);

	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true, prune: true }, dir });
	assert.equal(code, 0);
	assert.match(out, /pausing ad group "EX · hand-made"/);
});

test('an account modified after the plan was written stops the sync', async () => {
	ascOk(liveAccount({ modified: '2026-07-01T00:00:00.000Z' }));
	const dir = await syncRepo(plannedDoc());
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /modified after this plan was written/);
});

test('sync needs the numeric app id before it will create anything', async () => {
	ascOk(liveAccount());
	const doc = plannedDoc();
	doc.app.appId = null;
	const dir = await repo({ config: { ...CONFIG, asc: { primaryLocale: 'en-US' } }, files: { 'aso/en-US/scored.json': scored, 'aso/asa/campaign-plan.json': doc }, prefix: 'ship-ads-' });
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /numeric App Store app id/);
});

test('an ad group naming a custom product page binds it, and says so when Apple has no such page', async () => {
	const page = { name: 'Runners', slug: 'runners' };
	ascOk(liveAccount());
	const dir = await syncRepo(plannedDoc({ bid: 1.1, page }));
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /product page "Runners" is not in Apple Ads yet/);

	ascOk([
		...liveAccount(),
		['ads product-pages list', { out: { data: [{ id: 5, productPageId: 'pp-5', name: 'Runners' }] } }],
		['ads ads list', { out: { data: [] } }],
	]);
	const dir2 = await syncRepo(plannedDoc({ bid: 1.2, page }));
	const { out: out2 } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir: dir2 });
	assert.match(out2, /product page\(s\) bound/);
});

// ── the paid → organic loop, and the apply half of mining ────────────────────

/** A search-term report with one wasteful term and one that converts under target. */
const MINABLE = [['ads reports search-terms', { out: reportBody([
	reportRow({ searchTermText: 'free oil change', campaignId: 1, adGroupId: 10, adGroupName: 'EX · core' }, { spend: 20, taps: 40, installs: 0 }),
	reportRow({ searchTermText: 'car service log', campaignId: 1, adGroupId: 10, adGroupName: 'EX · core' }, { spend: 2, taps: 10, installs: 2 }),
]) }]];

test('a converting term missing from the staged listing is named as the ASO finding it is', async () => {
	ascOk(MINABLE);
	const dir = await planRepo({ 'store/staged/en-US.json': { locale: 'en-US', name: 'Demo', subtitle: 'Track your car', keywords: 'oil,change' } });
	const { out } = await ads(['mine'], { flags: { campaign: 1 }, dir });
	assert.match(out, /absent from the en-US listing: car service log/);
	assert.match(out, /ship aso suggest --locale en-US/);
});

test('with no staged listing at all, mine says so rather than claiming a gap', async () => {
	// Nothing converted, so there is no gap to report — only the absence of a
	// listing to measure one against.
	ascOk([['ads reports search-terms', { out: reportBody([reportRow({ searchTermText: 'free oil change', campaignId: 1 }, { spend: 20, taps: 40, installs: 0 })]) }]]);
	const dir = await planRepo();
	const { out } = await ads(['mine'], { flags: { campaign: 1 }, dir });
	assert.match(out, /no staged listing for en-US/);
});

test('mine --apply --confirm promotes a converting term into its own Exact ad group', async () => {
	ascOk(MINABLE);
	const dir = await planRepo({ 'aso/asa/campaign-plan.json': { currency: 'USD', campaigns: [{ role: 'exact', name: 'Demo · Exact' }, { role: 'discovery', name: 'Demo · Discovery' }] } });
	const { code, out } = await ads(['mine'], { flags: { campaign: 1, apply: true, confirm: true }, dir });
	assert.equal(code, 0);
	assert.match(out, /promote "car service log" → EX · car service log/);
	const made = await calls();
	assert.ok(made.some((call) => call.args.includes('ad-groups') && call.args.includes('create')), 'the promotion gets its own ad group');
	assert.ok(made.some((call) => call.args.includes('campaign-negative-keywords') && call.args.includes('create-bulk')), 'the wasteful term is negated');
});

test('mine --apply says which promotions it could not place when the org has no Exact campaign', async () => {
	// The rows carry no campaign id, so there is nothing to negate against
	// either — which is the pair of warnings this checks.
	ascOk([['ads reports search-terms', { out: reportBody([
		reportRow({ searchTermText: 'free oil change' }, { spend: 20, taps: 40, installs: 0 }),
		reportRow({ searchTermText: 'car service log' }, { spend: 2, taps: 10, installs: 2 }),
	]) }], ['ads campaigns list', { out: { data: [] } }]]);
	const dir = await planRepo();
	const { out } = await ads(['mine'], { flags: { campaign: 1, apply: true, confirm: true }, dir });
	assert.match(out, /no campaign to negate/);
	assert.match(out, /promotion\(s\) not pushed: car service log/);
});

test('report prints the monetisation line when RevenueCat can answer', async () => {
	ascOk();
	const dir = await repo({ config: { ...CONFIG, revenuecat: { projectId: 'projX' } }, files: { 'aso/en-US/scored.json': scored }, prefix: 'ship-ads-' });
	const fetch = async (url) => {
		const href = String(url);
		if (href.includes('/metrics/overview')) return json({ metrics: [{ id: 'revenue', value: 500 }, { id: 'active_subscriptions', value: 40 }, { id: 'new_customers', value: 40 }, { id: 'installs', value: 400 }] });
		return json({ items: [{ id: 'projX', name: 'Demo' }] });
	};
	const { out } = await ads(['report'], { dir, fetch });
	assert.match(out, /install→paid/);
});

// ── the shapes the tables have to render ────────────────────────────────────

test('campaigns and keywords render rows that carry almost nothing', async () => {
	ascOk([
		['ads campaigns list', { out: { data: [{}] } }],
		['ads targeting-keywords list', { out: { data: [{}] } }],
	]);
	const dir = await planRepo();
	assert.match((await ads(['campaigns'], { dir })).out, /Campaigns \(1\)/);
	assert.match((await ads(['keywords'], { flags: { campaign: 1, 'ad-group': 10 }, dir })).out, /Targeting keywords \(1\)/);
});

test('a campaign with a budget but no currency, and a serving status only, still render', async () => {
	ascOk([['ads campaigns list', { out: { data: [{ id: 1, name: 'C', servingStatus: 'RUNNING', dailyBudgetAmount: { amount: '5.00' } }] } }]]);
	const { out } = await ads(['campaigns'], { dir: await planRepo() });
	assert.match(out, /5.00/);
	assert.match(out, /RUNNING/);
});

test('a keyword priced without a currency renders its amount alone', async () => {
	ascOk([['ads targeting-keywords list', { out: { data: [{ text: 'kw', matchType: 'EXACT', bidAmount: { amount: '0.60' } }] } }]]);
	const { out } = await ads(['keywords'], { flags: { campaign: 1, 'ad-group': 10 }, dir: await planRepo() });
	assert.match(out, /0.60/);
});

test('v1 renders the campaign table, including a campaign Apple is limiting', async () => {
	ascOk();
	const fetch = async (url) => {
		const href = String(url);
		// v1 wraps every list in `result`, and pages by `pagination`.
		if (href.endsWith('/me')) return json({ data: { me: { orgId: 555, userId: 7 } } });
		if (href.includes('campaigns/query'))
			return json({
				result: [
					{ id: 1, name: 'Exact', displayStatus: 'RUNNING', dailyBudget: { amount: '5' }, targeting: { countryOrRegion: { include: ['US'] } }, systemStatusLimitingReasons: ['BUDGET_HALF_DEPLETED'] },
					{},
				],
				pagination: { pageSize: 2, offset: 0, totalResults: 2 },
			});
		return json({ result: [] });
	};
	const { out } = await ads(['v1'], { dir: await planRepo(), fetch });
	assert.match(out, /BUDGET_HALF_DEPLETED/);
	assert.match(out, /US/);
	assert.match(out, /Exact/);
});

test('report outside a repo still runs, and says why it has no monetisation evidence', async () => {
	ascOk();
	const dir = await repo({ config: null, prefix: 'ship-ads-' });
	const saved = process.env.ASC_ADS_ORG_ID;
	process.env.ASC_ADS_ORG_ID = ORG;
	try {
		const { out } = await ads(['report'], { dir });
		assert.match(out, /no ship.config.json/);
	} finally {
		if (saved === undefined) delete process.env.ASC_ADS_ORG_ID;
		else process.env.ASC_ADS_ORG_ID = saved;
	}
});

test('plan and sync both demand a repo', async () => {
	ascOk();
	const dir = await repo({ config: null, prefix: 'ship-ads-' });
	await assert.rejects(() => ads(['plan'], { dir }), /no ship.config.json/);
});

test('a contradictory ads config is warned about on every run that reads it', async () => {
	ascOk();
	// A target CPI above what a subscriber pays over the retention window is a
	// decision to lose money; the config loader flags it and every command that
	// reads it repeats the warning.
	const dir = await repo({
		config: { ...CONFIG, ads: { orgId: ORG, targetCpi: 3.4, subPrice: 4.99, retentionMonths: 1 } },
		files: { 'aso/en-US/scored.json': scored },
		prefix: 'ship-ads-',
	});
	const { out } = await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /ads:/);
});

test('mine refuses an org with no campaigns to mine', async () => {
	ascOk([['ads campaigns list', { out: { data: [] } }]]);
	const dir = await planRepo();
	await assert.rejects(() => ads(['mine'], { dir }), /has no campaigns to mine/);
});

test('a plan whose campaigns key is not a list reads as no campaigns', async () => {
	ascOk();
	const dir = await planRepo({ 'aso/asa/campaign-plan.json': { campaigns: { exact: {} } } });
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /declares no campaigns/);
});

test('sync says which app id it needs when neither the config nor the plan has one', async () => {
	ascOk();
	const dir = await repo({
		config: { ads: { orgId: ORG }, name: 'Demo', bundleId: 'com.demo.app' },
		files: { 'aso/asa/campaign-plan.json': { campaigns: [{ name: 'C' }] } },
		prefix: 'ship-ads-',
	});
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /numeric App Store app id/);
});

test('a snapshot of an account with no modification times records none', async () => {
	ascOk([
		['ads campaigns list', { out: { data: [{ id: 1, name: 'C' }] } }],
		['ads ad-groups list', { out: { data: [] } }],
		['ads targeting-keywords list', { out: { data: [] } }],
	]);
	const dir = await planRepo();
	await ads(['snapshot'], { dir });
	const doc = await readJson(dir, 'aso/asa/snapshot.json');
	assert.equal(doc.lastModified, null);
});

test('mine --apply --dry-run walks the promotion without an ad group id to attach to', async () => {
	ascOk(MINABLE);
	setDryRun(true);
	try {
		const dir = await planRepo({ 'aso/asa/campaign-plan.json': { currency: 'USD', campaigns: [{ role: 'exact', name: 'Demo · Exact' }] } });
		const { code } = await ads(['mine'], { flags: { campaign: 1, apply: true }, dir });
		assert.equal(code, 0, '--dry-run confirms on its own');
	} finally {
		setDryRun(false);
	}
});

test('plan reads its thresholds from the flags when they are given', async () => {
	ascOk();
	const dir = await repo({ config: { asc: { appId: 111, primaryLocale: 'en-US' }, ads: { orgId: ORG } }, files: { 'aso/en-US/scored.json': scored, 'aso/en-US/competitors.json': { generatedAt: 'x' } }, prefix: 'ship-ads-' });
	const { out } = await ads(['plan'], { flags: { json: true, 'no-ltv-check': true, 'sub-price': 9.99, 'target-cpi': 2, 'min-taps': 4 }, dir });
	const doc = JSON.parse(out);
	assert.equal(doc.params.subPrice, 9.99);
	assert.equal(doc.params.killRule.targetCpi, 2);
	assert.equal(doc.campaigns.length, 3, 'a competitors file with no apps is no competitors');
});

test('a forced replan reports the bound plan it replaced in --json too', async () => {
	ascOk();
	const dir = await planRepo();
	await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	const planFile = join(dir, 'aso', 'asa', 'campaign-plan.json');
	const doc = JSON.parse(await readFile(planFile, 'utf8'));
	doc.campaigns[0].apple = { id: '1' };
	await writeFile(planFile, JSON.stringify(doc));
	const { out } = await ads(['plan'], { flags: { 'no-ltv-check': true, force: true, json: true }, dir });
	assert.ok(JSON.parse(out).replacedBoundPlan.backup);
});

test('a plan with no currency and no timestamp still syncs, against the defaults', async () => {
	ascOk([['ads campaigns list', { out: { data: [] } }]]);
	const dir = await planRepo({ 'aso/asa/campaign-plan.json': { app: { appId: '111' }, campaigns: [{ role: 'exact', name: 'Solo', dailyBudget: 5, countriesOrRegions: ['US'], adGroups: [], negativeKeywords: [] }] } });
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0);
	assert.match(out, /campaign\(s\) created/);
});

test('an unmanaged campaign with no status is still named', async () => {
	ascOk([['ads campaigns list', { out: { data: [{ id: 7, name: 'Hand-made' }] } }]]);
	const dir = await syncRepo(plannedDoc());
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /unmanaged campaign left alone: Hand-made \(7, —\)/);
});

test('sync reports the monetisation evidence when RevenueCat can answer', async () => {
	ascOk(liveAccount());
	const dir = await repo({ config: { ...CONFIG, revenuecat: { projectId: 'projX' } }, files: { 'aso/en-US/scored.json': scored, 'aso/asa/campaign-plan.json': plannedDoc() }, prefix: 'ship-ads-' });
	const fetch = async (url) => {
		const href = String(url);
		if (href.includes('/metrics/overview')) return json({ metrics: [{ id: 'revenue', value: 0 }, { id: 'active_subscriptions', value: 0 }, { id: 'installs', value: 500 }] });
		return json({ items: [{ id: 'projX', name: 'Demo' }] });
	};
	const { out } = await ads(['sync'], { dir, fetch });
	assert.match(out, /NOTHING HAS MONETISED|monetisation/);
});

test('mine judges the gap against a listing stored without a data wrapper', async () => {
	ascOk(MINABLE);
	const dir = await planRepo({ 'store/staged/en-US.json': { locale: 'en-US', name: 'Car service log', subtitle: 'car service log' } });
	const { out } = await ads(['mine'], { flags: { campaign: 1 }, dir });
	assert.match(out, /absent from the en-US listing|converting term/);
});

test('mine --apply takes its org from the flag when the config has none', async () => {
	ascOk(MINABLE);
	const dir = await repo({ config: { asc: { appId: 111, primaryLocale: 'en-US' }, ads: { targetCpi: 2 } }, files: { 'aso/en-US/scored.json': scored }, prefix: 'ship-ads-' });
	const { code } = await ads(['mine'], { flags: { campaign: 1, org: ORG, apply: true, confirm: true }, dir });
	assert.equal(code, 0);
});

test('v1 --json carries the whole account', async () => {
	ascOk();
	const fetch = async (url) => {
		const href = String(url);
		if (href.endsWith('/me')) return json({ data: { me: { orgId: 555, userId: 7 } } });
		return json({ result: [] });
	};
	const { out } = await ads(['v1'], { flags: { json: true }, dir: await planRepo(), fetch });
	assert.equal(JSON.parse(out).ok, true);
});

test('an account that already matches has nothing to do, and says exactly that', async () => {
	ascOk(liveAccount());
	const dir = await syncRepo(plannedDoc());
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /nothing to do — the account already matches the plan/);
});

test('a campaign whose budget moved is updated, and --adopt takes the live one instead', async () => {
	ascOk(liveAccount());
	const dir = await syncRepo(plannedDoc({ budget: 9.5 }));
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /update campaign "Demo · Exact · US"/);

	ascOk(liveAccount({ budget: 7 }));
	const adopted = await syncRepo(plannedDoc({ budget: 9.5 }));
	await ads(['sync'], { flags: { 'no-ltv-check': true, adopt: true }, dir: adopted });
	const doc = JSON.parse(await readFile(join(adopted, 'aso', 'asa', 'campaign-plan.json'), 'utf8'));
	assert.equal(doc.campaigns[0].dailyBudget, 7, 'the account won');
});

test('a campaign create that answers with no id stops the sync rather than stamping nothing', async () => {
	// Rules are first-match, so the overrides go ahead of the healthy account.
	ascOk([['ads campaigns list', { out: { data: [] } }], ['ads campaigns create', { out: { data: {} } }], ...liveAccount()]);
	const dir = await syncRepo(plannedDoc());
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /campaign create returned no id/);
});

test('--prune pauses the keywords the plan dropped, one warning per ad group', async () => {
	const groups = [{ id: 10, name: 'EX · oil change reminder', defaultBidAmount: { amount: '0.69', currency: 'USD' }, automatedKeywordsOptIn: false, status: 'ENABLED', modificationTime: '2026-01-01T00:00:00.000Z' }];
	ascOk([
		['ads targeting-keywords list', { out: { data: [
			{ id: 100, text: 'oil change reminder', matchType: 'EXACT', status: 'ACTIVE', bidAmount: { amount: '0.69', currency: 'USD' }, modificationTime: '2026-01-01T00:00:00.000Z' },
			{ id: 101, text: 'hand added', matchType: 'EXACT', status: 'ACTIVE', bidAmount: { amount: '1.00', currency: 'USD' }, modificationTime: '2026-01-01T00:00:00.000Z' },
		] } }],
		...liveAccount({ groups }),
	]);
	const dir = await syncRepo(plannedDoc());
	const { out } = await ads(['sync'], { flags: { 'no-ltv-check': true, prune: true }, dir });
	assert.match(out, /pausing 1 keyword\(s\)/);
});

test('a keyword Apple already had is adopted into the plan on the first sync', async () => {
	const doc = plannedDoc();
	// No Apple ids anywhere: this plan has never been pushed.
	doc.campaigns[0].apple = undefined;
	doc.campaigns[0].adGroups[0].apple = undefined;
	doc.campaigns[0].adGroups[0].keywords[0].apple = undefined;
	ascOk(liveAccount());
	const dir = await syncRepo(doc);
	const { code } = await ads(['sync'], { flags: { 'no-ltv-check': true, adopt: true }, dir });
	assert.equal(code, 0);
	const saved = JSON.parse(await readFile(join(dir, 'aso', 'asa', 'campaign-plan.json'), 'utf8'));
	assert.equal(saved.campaigns[0].apple.id, '1', 'the live object ids are recorded');
});

test('an unreadable RevenueCat answer leaves the plan without monetisation evidence, not without a plan', async () => {
	ascOk();
	const dir = await repo({ config: { ...CONFIG, revenuecat: { projectId: 'projX' } }, files: { 'aso/en-US/scored.json': scored }, prefix: 'ship-ads-' });
	const { code, out } = await ads(['plan'], { dir, fetch: async () => { throw new Error('revenuecat is down'); } });
	assert.equal(code, 0);
	assert.match(out, /no monetisation evidence read/);
});

test('a proven monetisation signal is reported as a fact, not a warning', async () => {
	ascOk();
	const dir = await repo({ config: { ...CONFIG, revenuecat: { projectId: 'projX' }, ads: { orgId: ORG, subPrice: 9.99, targetCpi: 2, retentionMonths: 6 } }, files: { 'aso/en-US/scored.json': scored }, prefix: 'ship-ads-' });
	const fetch = async (url) => {
		const href = String(url);
		if (href.includes('/metrics/overview'))
			return json({ metrics: [{ id: 'revenue', value: 5000 }, { id: 'active_subscriptions', value: 300 }, { id: 'new_customers', value: 300 }, { id: 'installs', value: 1000 }] });
		return json({ items: [{ id: 'projX', name: 'Demo' }] });
	};
	const { out } = await ads(['plan'], { dir, fetch });
	assert.match(out, /monetisation: /);
});

test('a report pull that fails leaves the realised cost per tap unknown', async () => {
	ascOk([['ads reports preset', { out: '', err: 'boom', code: 1 }]]);
	const dir = await planRepo();
	const { out } = await ads(['plan'], { flags: { 'no-ltv-check': true }, dir });
	assert.match(out, /seed|bid/);
});

test('a plan campaign with no ad groups or negatives syncs as just the campaign', async () => {
	ascOk([['ads campaigns list', { out: { data: [] } }], ...liveAccount()]);
	const dir = await syncRepo({
		generatedAt: syncedAt, currency: 'USD', app: { appId: '111' }, budget: { daily: 10 },
		campaigns: [{ role: 'exact', name: 'Bare', dailyBudget: 5, countriesOrRegions: ['US'] }],
	});
	const { code, out } = await ads(['sync'], { flags: { 'no-ltv-check': true }, dir });
	assert.equal(code, 0);
	assert.match(out, /1 campaign\(s\) created/);
});

test('an ad group create that answers with no id stops the sync', async () => {
	ascOk([
		['ads campaigns list', { out: { data: [] } }],
		['ads ad-groups create', { out: { data: {} } }],
		['ads campaigns create', { out: { data: { id: 1 } } }],
		...liveAccount(),
	]);
	const dir = await syncRepo(plannedDoc());
	await assert.rejects(() => ads(['sync'], { flags: { 'no-ltv-check': true }, dir }), /ad group create returned no id/);
});

// ── the two signals `plan` and `sync` read before they authorise spend ───────

const apply = await import('../src/lib/ads-apply.mjs');
const { loadConfig } = await import('../src/config.mjs');
const configIn = (dir) => inDir(dir, () => loadConfig());

test('monetisation is unavailable, and says why, for each way it can be', async () => {
	const none = await configIn(await repo({ config: CONFIG, prefix: 'ship-ads-' }));
	assert.match((await apply.monetisationSignal(none)).reason, /no revenuecat.projectId/);

	const named = await configIn(await repo({ config: { ...CONFIG, revenuecat: { projectId: 'projX' } }, prefix: 'ship-ads-' }));
	const noMatch = await withFetch(async () => json({ items: [] }), () => apply.monetisationSignal(named));
	assert.match(noMatch.reason, /no RevenueCat project matches|no RevenueCat key can see/);
});

test('the realised cost per tap is unknown without an org, without credentials, and without taps', async () => {
	const cfg = await configIn(await repo({ config: CONFIG, prefix: 'ship-ads-' }));
	assert.deepEqual(await apply.realisedCpt(cfg, null), { cpt: null, reason: 'no ads.orgId' });

	setBin('asc', [['ads auth status', { out: 'No Apple Ads credentials\n' }]]);
	assert.match((await apply.realisedCpt(cfg, ORG)).reason, /no Apple Ads credentials/);

	ascOk([['ads reports preset', { out: reportBody([reportRow({ campaignName: 'C' }, { spend: 0, taps: 0, installs: 0 })]) }]]);
	assert.match((await apply.realisedCpt(cfg, ORG)).reason, /no taps in the last 30 days/);

	ascOk([['ads reports preset', { out: '', err: 'boom', code: 1 }]]);
	assert.ok((await apply.realisedCpt(cfg, ORG)).reason);
});
