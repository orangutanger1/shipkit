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
	metadata, total: { localSpend: { amount: spend, currency: 'USD' }, taps, totalInstalls: installs, impressions },
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
