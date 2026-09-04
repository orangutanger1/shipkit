// `ship status` — the read-only pane. Every section is collected here against
// a fake `asc` and a stubbed RevenueCat, including the case each section has
// to survive: the data simply not being there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, json, repo, setBin, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
await fakeBins(['asc']);

const { run } = await import('../src/commands/status.mjs');

const CONFIG = {
	name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0',
	asc: { appId: '111', primaryLocale: 'en-US' },
	ads: { orgId: '555' }, revenuecat: { projectId: 'projX', entitlement: 'pro' },
	store: { locales: ['en-US'] },
};
const APP_JSON = { expo: { version: '1.2.0', ios: { bundleIdentifier: 'com.demo.app' } } };
const LISTING = { locale: 'en-US', name: 'Demo', subtitle: 'Track your car', keywords: 'car,service,log' };

const DASH = {
	app: { name: 'Demo', bundleId: 'com.demo.app', sku: 'DEMO' },
	appstore: { state: 'READY_FOR_SALE', version: '1.2.0' },
	builds: { latest: { version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' } },
	testflight: { groups: [{ name: 'Internal', testers: 3 }] },
	submission: { state: 'IN_REVIEW' },
	review: { state: 'IN_REVIEW', submittedDate: '2026-09-02' },
	phasedRelease: { state: 'ACTIVE', currentDayNumber: 2 },
	links: { appStore: 'https://apps.apple.com/app/id111' },
};

function ascOk(extra = []) {
	setBin('asc', [
		...extra,
		['^status', { out: DASH }],
		['ads auth status', { out: { credentials: [{ name: 'Ads' }], active: { org: '555' } } }],
		['ads reports', { out: { reportingDataResponse: { row: [{ total: { localSpend: { amount: 12.5 }, totalInstalls: 3, taps: 10, impressions: 100 } }] } } }],
	]);
}

const rcFetch = async (url) => {
	const href = String(url);
	if (href.includes('/metrics/overview')) return json({ metrics: [{ id: 'mrr', value: 400 }] });
	if (href.endsWith('/v2/projects')) return json({ items: [{ id: 'projX', name: 'Demo' }] });
	return json({ items: [] });
};

/** @param {{flags?: object, dir: string, args?: string[], fetch?: typeof globalThis.fetch}} opts */
async function status({ flags = {}, dir, args = [], fetch = rcFetch }) {
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const statusRepo = (files = {}, config = {}) =>
	repo({ config: { ...CONFIG, ...config }, files: { 'app.json': APP_JSON, 'store/staged/en-US.json': LISTING, 'package.json': { name: 'demo', dependencies: {} }, ...files }, prefix: 'ship-status-' });

test('status takes no arguments and only the sections it has', async () => {
	const dir = await statusRepo();
	await assert.rejects(() => status({ dir, args: ['app'] }), /unexpected argument "app"/);
	await assert.rejects(() => status({ dir, flags: { section: 'weather' } }), /unknown section "weather"/);
});

test('every section renders, and the exit code is always 0', async () => {
	ascOk();
	const dir = await statusRepo();
	const { code, out } = await status({ dir });
	assert.equal(code, 0);
	for (const title of ['App', 'Review', 'Builds', 'TestFlight', 'Revenue', 'Ads', 'Listing', 'OTA']) assert.match(out, new RegExp(title));
	assert.match(out, /submission IN_REVIEW/);
});

test('--section renders exactly one', async () => {
	ascOk();
	const dir = await statusRepo();
	const { out } = await status({ dir, flags: { section: 'builds' } });
	assert.match(out, /Builds/);
	assert.doesNotMatch(out, /TestFlight/);
});

test('--json puts every section in one object', async () => {
	ascOk();
	const dir = await statusRepo();
	const { out } = await status({ dir, flags: { json: true } });
	const doc = JSON.parse(out);
	assert.deepEqual(Object.keys(doc).sort(), ['ads', 'app', 'builds', 'listing', 'ota', 'revenue', 'review', 'testflight']);
});

test('a section that cannot be collected is reported as unavailable, not as a crash', async () => {
	setBin('asc', []);
	const dir = await statusRepo();
	const { code, out } = await status({ dir, fetch: async () => { throw new Error('rc down'); } });
	assert.equal(code, 0);
	assert.match(out, /App/);
	const { out: raw } = await status({ dir, flags: { json: true }, fetch: async () => { throw new Error('rc down'); } });
	const doc = JSON.parse(raw);
	assert.ok(Object.values(doc).some((v) => v && typeof v === 'object'));
});

test('a repo with no asc.appId still renders the local sections', async () => {
	setBin('asc', []);
	const dir = await statusRepo({}, { asc: { primaryLocale: 'en-US' } });
	const { code, out } = await status({ dir });
	assert.equal(code, 0);
	assert.match(out, /Listing/);
});
