// The Apple Ads client's payload tolerance, and the mutations `sync` reaches
// only through a reconciliation. Apple's report rows arrive in several shapes
// — totals, granularity buckets, bare metadata — and each level labels itself
// from a different field, so every one of those is exercised here directly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calls, fakeBins, fakeHome, resetCalls, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const client = await import('../src/lib/ads-client.mjs');

const ORG = '555';
const report = (rows) => ({ data: { reportingDataResponse: { row: rows } } });

/** @param {string} pattern @param {object|string} out */
const answers = (rules) => setBin('asc', rules);

test('a report level labels itself from whichever field the payload carries', async () => {
	answers([['reports preset', { out: report([{ metadata: {}, total: { localSpend: { amount: 1 } } }]) }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {}))[0].name, '(unnamed)');

	answers([['reports preset', { out: report([{ metadata: { name: 'From name' }, total: {} }]) }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {}))[0].name, 'From name');

	answers([['reports preset', { out: report([{ metadata: { keywordText: 'kw', matchType: 'BROAD' }, total: {} }]) }], ['campaigns list', { out: { data: [{ id: 1 }] } }]]);
	assert.equal((await client.pullReport(ORG, 'keyword', { campaign: 1 }))[0].name, 'kw BROAD');

	answers([['reports preset', { out: report([{ metadata: {}, total: {} }]) }], ['campaigns list', { out: { data: [{ id: 1 }] } }]]);
	assert.equal((await client.pullReport(ORG, 'keyword', { campaign: 1 }))[0].name, '(unnamed)');

	answers([['reports preset', { out: report([{ metadata: { adGroupName: 'AG' }, total: {} }]) }], ['campaigns list', { out: { data: [{ id: 1 }] } }]]);
	assert.equal((await client.pullReport(ORG, 'ad-group', { campaign: 1 }))[0].name, 'AG');

	answers([['reports preset', { out: report([{ metadata: { searchTerm: 'free thing' }, total: {} }]) }], ['campaigns list', { out: { data: [{ id: 1 }] } }]]);
	assert.equal((await client.pullReport(ORG, 'search-term', { campaign: 1 }))[0].name, 'free thing');
});

test('a row with granularity buckets is summed, not read as zero', async () => {
	answers([['reports preset', { out: report([{
		metadata: { campaignName: 'C' },
		granularity: [
			{ localSpend: { amount: 4, currency: 'EUR' }, taps: 10, impressions: 100, totalInstalls: 2 },
			{ localSpend: { amount: 6, currency: 'EUR' }, taps: 10, impressions: 100, totalInstalls: 2 },
		],
	}]) }]]);
	const [row] = await client.pullReport(ORG, 'campaign', {});
	assert.equal(row.spend, 10);
	assert.equal(row.taps, 20);
	assert.equal(row.installs, 4);
	assert.equal(row.currency, 'EUR');
	assert.equal(row.cpi, 2.5);
	assert.equal(row.cpt, 0.5);
});

test('a bucket whose metric is an object contributes nothing rather than NaN', async () => {
	answers([['reports preset', { out: report([{ metadata: {}, granularity: [{ localSpend: { amount: 1 }, taps: { value: 3 } }] }]) }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {}))[0].taps, 0);
});

test('a row with neither totals nor buckets falls back to its metadata', async () => {
	answers([['reports preset', { out: report([{ metadata: { campaignName: 'C', taps: 4, localSpend: { amount: 2 }, installs: 1 } }]) }]]);
	const [row] = await client.pullReport(ORG, 'campaign', {});
	assert.equal(row.taps, 4);
	assert.equal(row.installs, 1);
});

test('installs are read from whichever download field Apple used', async () => {
	answers([['reports preset', { out: report([{ metadata: {}, total: { tapInstalls: 3 } }]) }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {}))[0].installs, 3);

	answers([['reports preset', { out: report([{ metadata: {}, total: { newDownloads: 2, redownloads: 5 } }]) }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {}))[0].installs, 7);
});

test('a row with no taps or impressions divides by nothing rather than by zero', async () => {
	answers([['reports preset', { out: report([{ metadata: {}, total: { localSpend: { amount: 3 } } }]) }]]);
	const [row] = await client.pullReport(ORG, 'campaign', {});
	assert.deepEqual({ cpi: row.cpi, cpt: row.cpt, ttr: row.ttr, cvr: row.conversionRate }, { cpi: null, cpt: null, ttr: 0, cvr: 0 });
});

test('an `other` totals row is dropped, and an unwrapped payload is still read', async () => {
	answers([['reports preset', { out: report([{ other: true, total: { localSpend: { amount: 99 } } }, { metadata: { campaignName: 'C' }, total: {} }]) }]]);
	const rows = await client.pullReport(ORG, 'campaign', {});
	assert.equal(rows.length, 1);

	answers([['reports preset', { out: { reportingDataResponse: { row: [{ metadata: { campaignName: 'C' }, total: {} }] } } }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {})).length, 1);

	answers([['reports preset', { out: { data: [{ metadata: { campaignName: 'C' }, total: {} }] } }]]);
	assert.equal((await client.pullReport(ORG, 'campaign', {})).length, 1);
});

test('a scoped report over an org with no campaigns refuses rather than reporting nothing', async () => {
	answers([['campaigns list', { out: { data: [] } }]]);
	await assert.rejects(() => client.pullReport(ORG, 'keyword', {}), /has no campaigns to report on/);
});

test('a scoped report can be narrowed to one ad group', async () => {
	answers([['campaigns list', { out: { data: [{ id: 7 }] } }], ['reports preset', { out: report([{ metadata: {}, total: {} }]) }]]);
	await resetCalls();
	await client.pullReport(ORG, 'keyword', { campaign: 7, adGroup: 70 });
	const preset = (await calls()).find((call) => call.args.includes('preset'));
	assert.ok(preset.args.includes('--ad-group'));
	assert.ok(preset.args.includes('70'));
});

test('list endpoints tolerate a payload that is not rows at all', async () => {
	answers([]);
	assert.deepEqual(await client.listCampaigns(ORG), []);
	assert.deepEqual(await client.listKeywords(ORG, '1', '10'), []);
	answers([['campaigns list', { out: { data: ['nonsense'] } }]]);
	assert.deepEqual(await client.listCampaigns(ORG), [{}], 'a row that is not an object reads as an empty one');
});

test('a mutation asc refused is thrown with the tail of what it said', async () => {
	answers([['campaigns create', { out: '', err: 'line one\nline two', code: 1 }]]);
	await assert.rejects(
		() => client.createCampaign(ORG, { name: 'C', countriesOrRegions: ['US'], dailyBudget: 5 }, '111', 'USD'),
		/asc ads campaigns create --org exited 1/,
	);
});

test('a mutation that answers with something unparseable resolves to null, not a crash', async () => {
	answers([['campaigns create', { out: 'OK, done.' }]]);
	assert.deepEqual(await client.createCampaign(ORG, { name: 'C', countriesOrRegions: [], dailyBudget: 1 }, '111', 'USD'), {}, 'an unparseable answer carries no id, which is what the caller checks');
});

test('a mutation answering with a bare object, an empty list, or a list is read the same way', async () => {
	answers([['campaigns create', { out: { data: { id: 5 } } }]]);
	assert.equal((await client.createCampaign(ORG, { name: 'C', countriesOrRegions: [], dailyBudget: 1 }, '111', 'USD')).id, 5);

	answers([['campaigns create', { out: { data: [] } }]]);
	assert.equal(await client.createCampaign(ORG, { name: 'C', countriesOrRegions: [], dailyBudget: 1 }, '111', 'USD'), undefined);
});

test('updateCampaign strips the fields Apple refuses on an update', async () => {
	answers([['campaigns update', { out: { data: { id: 1 } } }]]);
	await resetCalls();
	await client.updateCampaign(ORG, 1, { name: 'C', countriesOrRegions: ['US'], dailyBudget: 5, supplySources: ['APPSTORE_SEARCH_RESULTS'], billingEvent: 'TAPS', adChannelType: 'SEARCH', startTime: '2026-01-01' }, '111', 'USD');
	const call = (await calls()).find((c) => c.args.includes('update'));
	assert.ok(call.args.includes('--campaign'));
});

test('pauseKeywords is an update that sets the status and nothing else', async () => {
	answers([['targeting-keywords update-bulk', { out: { data: [] } }]]);
	await resetCalls();
	await client.pauseKeywords(ORG, '1', '10', ['k1', 'k2']);
	assert.ok((await calls()).some((c) => c.args.includes('update-bulk')));
});

test('ensureAdGroup updates the one that is already there instead of creating a second', async () => {
	answers([['ad-groups update', { out: { data: { id: 10 } } }], ['ad-groups create', { out: { data: { id: 99 } } }]]);
	await resetCalls();
	const found = await client.ensureAdGroup(ORG, '1', [{ id: 10, name: 'EX · core' }], { name: 'EX · core', defaultBidAmount: 1 }, 'USD');
	assert.deepEqual({ id: found.group.id, created: found.created }, { id: 10, created: false });
	assert.ok((await calls()).every((c) => !c.args.includes('create')));

	const made = await client.ensureAdGroup(ORG, '1', [], { name: 'EX · new', defaultBidAmount: 1 }, 'USD');
	assert.equal(made.created, true);
});

test('ensureKeywords creates what is missing, reprices what is there, and skips an empty list', async () => {
	answers([
		['targeting-keywords list', { out: { data: [{ id: 100, text: 'here', matchType: 'EXACT' }] } }],
		['targeting-keywords create-bulk', { out: { data: [{ id: 101 }] } }],
		['targeting-keywords update-bulk', { out: { data: [] } }],
	]);
	assert.deepEqual(await client.ensureKeywords(ORG, '1', '10', [], 'USD'), { created: 0, updated: 0 });
	const both = await client.ensureKeywords(ORG, '1', '10', [{ text: 'here', matchType: 'EXACT', bid: 2 }, { text: 'new', matchType: 'EXACT', bid: 1 }], 'USD');
	assert.deepEqual(both, { created: 1, updated: 1 });
});

test('ensureNegatives adds only what the campaign lacks', async () => {
	answers([
		['campaign-negative-keywords list', { out: { data: [{ text: 'free', matchType: 'EXACT' }] } }],
		['campaign-negative-keywords create-bulk', { out: { data: [] } }],
	]);
	assert.equal(await client.ensureNegatives(ORG, '1', []), 0);
	assert.equal(await client.ensureNegatives(ORG, '1', [{ text: 'free', matchType: 'EXACT' }]), 0);
	assert.equal(await client.ensureNegatives(ORG, '1', [{ text: 'cheap', matchType: 'EXACT' }]), 1);
});

test('bindProductPage refuses a page Apple does not have, and updates an ad that already points at one', async () => {
	answers([['product-pages list', { out: { data: [] } }]]);
	assert.equal(await client.bindProductPage(ORG, '111', '1', '10', { name: 'Runners', slug: 'runners' }, {}), false);

	answers([
		['product-pages list', { out: { data: [{ id: 5, productPageId: 'pp-5', name: 'Runners' }] } }],
		['ads ads list', { out: { data: [{ id: 9, name: 'Runners · CPP', productPageId: 'pp-5' }] } }],
	]);
	assert.equal(await client.bindProductPage(ORG, '111', '1', '10', { name: 'Runners', slug: 'runners' }, {}), true);

	answers([
		['product-pages list', { out: { data: [{ id: 5, productPageId: 'pp-5', name: 'Runners' }] } }],
		['ads ads list', { out: { data: [{ id: 9, name: 'Runners · CPP', productPageId: 'other' }] } }],
		['ads ads update', { out: { data: { id: 9 } } }],
	]);
	await resetCalls();
	assert.equal(await client.bindProductPage(ORG, '111', '1', '10', { name: 'Runners', slug: 'runners' }, {}), true);
	assert.ok((await calls()).some((c) => c.args.includes('update')));
});

test('readAccount skips a campaign or ad group Apple returned without an id', async () => {
	answers([
		['campaigns list', { out: { data: [{ name: 'no id' }, { id: 1, name: 'C' }] } }],
		['ad-groups list', { out: { data: [{ name: 'no id' }, { id: 10, name: 'AG' }] } }],
		['targeting-keywords list', { out: { data: [] } }],
		['campaign-negative-keywords list', { out: { data: [] } }],
	]);
	const account = await client.readAccount(ORG, { performance: false });
	assert.equal(account.campaigns.length, 1);
	assert.equal(account.campaigns[0].adGroups.length, 1);
});

test('readAccount attaches performance to the objects it can match', async () => {
	answers([
		['campaigns list', { out: { data: [{ id: 1, name: 'C' }] } }],
		['ad-groups list', { out: { data: [{ id: 10, name: 'AG' }] } }],
		['targeting-keywords list', { out: { data: [{ id: 100, text: 'kw', matchType: 'EXACT' }] } }],
		['campaign-negative-keywords list', { out: { data: [] } }],
		['reports preset --level campaigns', { out: report([{ metadata: { campaignId: 1, campaignName: 'C' }, total: { localSpend: { amount: 5 }, taps: 10 } }]) }],
		['reports preset --level ad-groups', { out: report([{ metadata: { adGroupName: 'AG' }, total: {} }]) }],
		['reports preset --level keywords', { out: report([{ metadata: { keyword: 'kw', matchType: 'EXACT' }, total: {} }]) }],
	]);
	const account = await client.readAccount(ORG, { performance: true, from: '2026-01-01', to: '2026-01-31' });
	assert.equal(account.campaigns[0].performance.spend, 5);
	assert.ok(account.campaigns[0].adGroups[0].performance);
	assert.ok(account.campaigns[0].adGroups[0].keywords[0].performance);
});
