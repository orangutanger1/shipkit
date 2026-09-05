// The live probes behind `ship portfolio`, exercised directly rather than
// through the command: this is where "no data on a version", "two projects
// and no configured one", and "the ads report comes back in a shape nobody
// tested" live. The command-level suite (portfolio-command.test.mjs) drives
// the happy path end to end; this file drives the degenerate payloads ASC,
// RevenueCat and Apple Ads are free to send back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBins, fakeHome, json, repo, setBin, withFetch } from './fixtures/cmd.mjs';
import { collectRow, errored, liveContext, pool, sunsetReason } from '../src/lib/portfolio-probes.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
await fakeBins(['asc']);

const NOW = Date.UTC(2026, 0, 1);
const ctx = (over = {}) => liveContext({ now: NOW, ...over });

/* ------------------------------------------------------------------ pool -- */

test('the pool falls back to its default width when the limit given is unusable', async () => {
	let active = 0;
	let peak = 0;
	await pool(Array.from({ length: 10 }, (_, i) => i), 0, async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 1));
		active--;
	});
	// 0 | 0 is 0, and 0 is falsy — the guard reaches for the default (4) rather
	// than running everything at once or nothing at all.
	assert.equal(peak, 4);
});

/* -------------------------------------------------------------- sunset --- */

test('sunsetReason reads as empty when a row was never put through the gate', () => {
	assert.equal(sunsetReason({}), '');
});

/* --------------------------------------------------------------- asc ----- */

test('the ASC probe reads a completely empty versions payload as no versions at all', async () => {
	setBin('asc', [
		['^status', { out: {} }],
		['versions list', { out: {} }],
	]);
	const row = await ctx().ascFor('123');
	assert.deepEqual(row, { state: null, version: null, build: null, lastReleaseAt: null, firstReleaseAt: null });
});

test('the ASC probe falls back to nulls when a version carries none of the fields it wants', async () => {
	setBin('asc', [
		['^status', { out: {} }],
		['versions list', { out: { data: [{ attributes: {} }] } }],
	]);
	const row = await ctx().ascFor('123');
	// No versionString, no state, no createdDate: the version is unusable and
	// Date.parse('') is not finite, so it is filtered out entirely.
	assert.deepEqual(row, { state: null, version: null, build: null, lastReleaseAt: null, firstReleaseAt: null });
});

test('the ASC probe falls back to the newest version when nothing reached sale', async () => {
	setBin('asc', [
		['^status', { out: { builds: { latest: {} } } }],
		['versions list', { out: { data: [
			{ attributes: { versionString: '1.1.0', appStoreState: 'PENDING_APPLE_RELEASE', createdDate: '2025-06-01T00:00:00.000Z' } },
		] } }],
	]);
	const row = await ctx().ascFor('123');
	// Nothing is READY_FOR_SALE, so the draft itself carries the state and
	// version — an app in review is not an app with nothing to show.
	assert.equal(row.state, 'PENDING_APPLE_RELEASE');
	assert.equal(row.version, '1.1.0');
	assert.equal(row.build, null);
});

test('an app in review is described by its review state when there is no live one', async () => {
	// A first submission has no appstore block at all: the only state ASC has to
	// give is the review's, and reporting null there reads as an app doing nothing.
	setBin('asc', [
		['^status', { out: { review: { state: 'IN_REVIEW' } } }],
		['versions list', { out: { data: [
			{ attributes: { versionString: '1.0.0', appStoreState: 'WAITING_FOR_REVIEW', createdDate: '2025-06-01T00:00:00.000Z' } },
		] } }],
	]);
	const row = await ctx().ascFor('123');
	assert.equal(row.state, 'IN_REVIEW', 'the review outranks the version it is reviewing');
	assert.equal(row.version, '1.0.0');
});

/* ---------------------------------------------------------- revenue ------ */

test('the revenue probe treats a configured project id that matches nothing as absent', async () => {
	const fetchStub = async (url) => {
		if (String(url).includes('/metrics/overview')) throw new Error('should not be reached: no project resolved');
		return json({ items: [{ id: 'other', name: 'Other' }] });
	};
	const row = await withFetch(fetchStub, () => ctx().revenueFor({ revenuecat: { projectId: 'ghost' } }));
	assert.deepEqual(row, { monthly: null, skipped: 'no RevenueCat project "ghost"' });
});

test('the revenue probe falls back to the only project when none is configured', async () => {
	const fetchStub = async (url) =>
		String(url).includes('/metrics/overview') ? json({ metrics: [{ id: 'revenue', value: 77 }] }) : json({ items: [{ id: 'solo', name: 'Solo' }] });
	const row = await withFetch(fetchStub, () => ctx().revenueFor({}));
	// No MRR reported, only the 28-day figure — that is still a monthly number.
	assert.equal(row.monthly, 77);
	assert.equal(row.revenue28d, 77);
	assert.equal(row.mrr, null);
});

test('the revenue probe shows no revenue when the metrics endpoint answers with none', async () => {
	const fetchStub = async (url) =>
		String(url).includes('/metrics/overview') ? json({}) : json({ items: [{ id: 'projX', name: 'Demo' }] });
	const row = await withFetch(fetchStub, () => ctx().revenueFor({ revenuecat: { projectId: 'projX' } }));
	assert.deepEqual(row, { monthly: null, mrr: null, revenue28d: null, project: 'projX' });
});

/* ------------------------------------------------------------- ads ------- */

test('the ads probe resolves the org from the account when cfg and the environment name none', async () => {
	setBin('asc', [
		['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { orgId: 'orgB' } } }],
		['ads reports preset', { out: { data: { reportingDataResponse: { row: [] } } } }],
	]);
	const row = await ctx().adsFor({ ads: {} });
	assert.equal(row.org, 'orgB');
});

test('the ads probe skips when no org can be found anywhere', async () => {
	setBin('asc', [['ads auth status', { out: { credentials: [{ name: 'Ads' }] } }]]);
	const row = await ctx().adsFor({ ads: {} });
	assert.deepEqual(row, { spend: null, skipped: 'no ads.orgId' });
});

test('the ads probe sums spend and installs across rows with different shapes', async () => {
	setBin('asc', [
		['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { org: 'orgA' } } }],
		['ads reports preset', { out: { data: { reportingDataResponse: { row: [
			// Granularity only, no `total`; installs under `installs`, not `totalInstalls`.
			{ granularity: [{ localSpend: { amount: 5 }, installs: 3 }] },
			// Neither `total` nor `granularity`, and no spend or install field at all.
			{},
		] } } } }],
	]);
	const row = await ctx().adsFor({ ads: { orgId: 'orgA' } });
	assert.equal(row.spend, 5);
	assert.equal(row.installs, 3);
	assert.equal(row.campaigns, 2);
});

test('the ads probe throws when App Store Connect cannot produce the report', async () => {
	setBin('asc', [['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { org: 'orgA' } } }]]);
	await assert.rejects(() => ctx().adsFor({ ads: { orgId: 'orgA' } }), /Apple Ads report unavailable/);
});

/* -------------------------------------------------------- collectRow ----- */

test('a failing ads probe becomes an error cell without breaking the row', async () => {
	setBin('asc', [
		['^status', { out: { appstore: { state: 'READY_FOR_SALE', version: '1.0.0' } } }],
		['versions list', { out: { data: [] } }],
		['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { org: 'orgA' } } }],
	]);
	const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app', asc: { appId: '1' }, ads: { orgId: 'orgA' } } });
	const fetchStub = async (url) => (String(url).includes('/metrics/overview') ? json({ metrics: [] }) : json({ items: [] }));

	const row = await withFetch(fetchStub, () => collectRow({ path: dir, name: 'demo' }, ctx()));
	assert.equal(row.error, null, 'a dead probe must not kill the row');
	assert.equal(row.errors.ads, 'Apple Ads report unavailable');
	assert.equal(row.version, '1.0.0');
});

/* -------------------------------------------------------------- errored -- */

test('errored treats a row with no errors map as clean', () => {
	assert.equal(errored({ error: null }), false);
	assert.equal(errored({ error: 'boom' }), true);
});
