// `ship analytics` end to end: pull (from a file and from App Store Connect),
// terms, funnel, onboarding and diagnose. The Analytics Reports API is reached
// only through `asc`, so a fake binary answers the request/view/download chain
// — including writing the CSV that `asc analytics download` would have left in
// its working directory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/analytics.mjs');
const { REPORTS } = await import('../src/lib/analytics-api.mjs');

const CONFIG = { asc: { appId: 111, primaryLocale: 'en-US' }, store: { locales: ['en-US'] } };

/** @param {string[]} args @param {{flags?: object, dir: string}} opts */
async function analytics(args, { flags = {}, dir }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => run({ args, flags })));
	return { code: result, out };
}

const analyticsRepo = (files = {}, config = {}) => repo({ config: { ...CONFIG, ...config }, files, prefix: 'ship-analytics-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

const TERMS_CSV = 'Search Term,Impressions,Product Page Views,Installs\nperiod tracker,1000,200,50\ncycle log,400,40,2\n';

/** The credential probe every network path starts with. */
const authOk = ['^auth status', { out: { credentials: [{ name: 'Team' }] } }];

test('an unknown subcommand names the ones that exist', async () => {
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['sniff'], { dir }), /unknown subcommand "sniff"/);
});

test('pull --file imports an export and writes both artifacts', async () => {
	const dir = await analyticsRepo({ 'export.csv': TERMS_CSV });
	const { code, out } = await analytics(['pull'], { dir, flags: { file: join(dir, 'export.csv') } });
	assert.equal(code, 0);
	const terms = await readJson(dir, '.asc/analytics/en-US-terms.json');
	assert.equal(terms.rows.length, 2);
	assert.equal(terms.source, 'file');
	const funnel = await readJson(dir, '.asc/analytics/en-US-funnel.json');
	assert.equal(funnel.impressions, 1400);
	assert.match(out, /next: ship analytics terms/);
});

test('pull --file refuses a missing file, bad JSON, and columns it cannot read', async () => {
	const dir = await analyticsRepo({ 'bad.json': '{oops', 'wrong.csv': 'a,b\n1,2\n', 'notrows.json': { rows: 5 } });
	await assert.rejects(() => analytics(['pull'], { dir, flags: { file: join(dir, 'nope.csv') } }), /no such file/);
	await assert.rejects(() => analytics(['pull'], { dir, flags: { file: join(dir, 'bad.json') } }), /is not valid JSON/);
	await assert.rejects(() => analytics(['pull'], { dir, flags: { file: join(dir, 'notrows.json') } }), /expected an array of rows/);
	await assert.rejects(() => analytics(['pull'], { dir, flags: { file: join(dir, 'wrong.csv') } }), /no columns this can read/);
});

test('pull --file --dry-run writes nothing, and --json says so', async () => {
	const dir = await analyticsRepo({ 'export.csv': TERMS_CSV });
	const { out } = await analytics(['pull'], { dir, flags: { file: join(dir, 'export.csv'), 'dry-run': true, json: true } });
	assert.deepEqual(JSON.parse(out).written, []);
	await assert.rejects(() => readJson(dir, '.asc/analytics/en-US-terms.json'), /ENOENT/);
});

test('pull without credentials says how to configure them', async () => {
	setBin('asc', []);
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['pull'], { dir }), /no App Store Connect API credentials/);
});

test('pull creates the ONGOING request when the app has none, and stops there', async () => {
	setBin('asc', [authOk, ['analytics requests', { out: { data: [] } }], ['analytics request ', { out: { data: { id: 'req-1' } } }]]);
	const dir = await analyticsRepo();
	const { code, out } = await analytics(['pull'], { dir });
	assert.equal(code, 0);
	assert.match(out, /created an ONGOING analytics report request/);
	assert.match(out, /up to 48 h/);
});

test('pull --dry-run does not create the request', async () => {
	setBin('asc', [authOk, ['analytics requests', { out: { data: [] } }]]);
	const dir = await analyticsRepo();
	const { code, out } = await analytics(['pull'], { dir, flags: { 'dry-run': true } });
	assert.equal(code, 0);
	assert.match(out, /would create an ONGOING analytics report request/);
});

/**
 * A request that exists, with one downloadable segment per report. The two
 * halves of the funnel come from different reports and different column
 * layouts — engagement is an Event/Counts long table, downloads is keyed by
 * Download Type — which is why they are downloaded separately.
 */
const ENGAGEMENT_CSV = 'Event,Counts\nImpression,1000\nProduct Page View,200\n';
const DOWNLOADS_CSV = 'Download Type,Counts\nFirst-time download,50\nRe-download,900\n';

const reportView = (reports) => ({ data: reports.map(([name, id]) => ({ name, instances: [{ id: `inst-${id}`, granularity: 'DAILY', processingDate: '2026-08-01', segments: [{ id }] }] })) });

const liveReports = (view, downloads) => [
	authOk,
	['analytics requests', { out: { data: [{ type: 'analyticsReportRequests', id: 'req-1', attributes: { accessType: 'ONGOING' }, accessType: 'ONGOING' }] } }],
	['analytics view', { out: view }],
	...downloads,
];

const FUNNEL_REPORTS = liveReports(reportView([[REPORTS.engagement, 'seg-eng'], [REPORTS.downloads, 'seg-dl']]), [
	['analytics download .*--segment-id seg-eng', { out: '', files: { 'report.csv': ENGAGEMENT_CSV } }],
	['analytics download .*--segment-id seg-dl', { out: '', files: { 'report.csv': DOWNLOADS_CSV } }],
]);

test('pull downloads the segments Apple produced and folds them into the funnel', async () => {
	setBin('asc', FUNNEL_REPORTS);
	const dir = await analyticsRepo();
	const { code, out } = await analytics(['pull'], { dir, flags: { from: '2026-08-01', to: '2026-08-01' } });
	assert.equal(code, 0);
	const funnel = await readJson(dir, '.asc/analytics/en-US-funnel.json');
	assert.equal(funnel.source, 'asc');
	assert.equal(funnel.impressions, 1000);
	assert.equal(funnel.installs, 50, 'a re-download is the same person again, and is not an install');
	assert.match(out, /no search-term dimension/, 'the API reports carry no terms — the web export is the only source');
});

test('pull says which reports Apple produced when none of them is the funnel', async () => {
	setBin('asc', liveReports(reportView([[REPORTS.crashes, 'seg-crash']]), [['analytics download', { out: '', files: { 'report.csv': 'Crashes\n3\n' } }]]));
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['pull'], { dir, flags: { from: '2026-08-01', to: '2026-08-01' } }), /none of the reports the funnel is built from/);
});

test('pull reports a request with no instances in the window', async () => {
	setBin('asc', [authOk, ['analytics requests', { out: { data: [{ type: 'analyticsReportRequests', id: 'req-1', accessType: 'ONGOING' }] } }], ['analytics view', { out: { data: [] } }]]);
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['pull'], { dir, flags: { from: '2026-08-01', to: '2026-08-01' } }), /has no report instances/);
});

test('pull reports every segment failing to download as the failure it is', async () => {
	setBin('asc', [...FUNNEL_REPORTS.slice(0, 3), ['analytics download', { out: '', err: 'gone', code: 1 }]]);
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['pull'], { dir, flags: { from: '2026-08-01', to: '2026-08-01' } }), /every analytics segment download failed/);
});

test('terms ranks what converts and names what the keyword field is missing', async () => {
	const dir = await analyticsRepo({
		'.asc/analytics/en-US-terms.json': { locale: 'en-US', rows: [{ term: 'period tracker', impressions: 1000, pageViews: 200, installs: 50 }, { term: 'cycle log', impressions: 400, pageViews: 40, installs: 2 }] },
		'store/staged/en-US.json': { locale: 'en-US', name: 'Demo', keywords: 'calendar,ovulation' },
	});
	const { code, out } = await analytics(['terms'], { dir });
	assert.equal(code, 0);
	assert.match(out, /period tracker/);
	assert.match(out, /Highest-value listing edit available/);
	assert.match(out, /ship loc draft --locale en-US/);
	const { out: raw } = await analytics(['terms'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).locales[0].missingFromKeywords.length, 2);
});

test('terms warns when there is no staged keyword field to judge coverage against', async () => {
	const dir = await analyticsRepo({ '.asc/analytics/en-US-terms.json': { locale: 'en-US', rows: [{ term: 'period tracker', impressions: 10, pageViews: 5, installs: 1 }] } });
	const { out } = await analytics(['terms'], { dir });
	assert.match(out, /no staged keyword field/);
});

test('terms and funnel both refuse before anything has been pulled', async () => {
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['terms'], { dir }), /no analytics have been pulled/);
	await assert.rejects(() => analytics(['funnel'], { dir }), /no analytics have been pulled/);
	await assert.rejects(() => analytics(['terms'], { dir, flags: { locale: 'de-DE' } }), /no terms file for de-DE/);
	await assert.rejects(() => analytics(['funnel'], { dir, flags: { locale: 'de-DE' } }), /no funnel file for de-DE/);
});

test('funnel names the stage that leaks, and is quiet when neither does', async () => {
	const leaky = await analyticsRepo({ '.asc/analytics/en-US-funnel.json': { locale: 'en-US', impressions: 10000, pageViews: 100, installs: 5 } });
	const { code, out } = await analytics(['funnel'], { dir: leaky });
	assert.equal(code, 0);
	assert.match(out, /bottleneck/);
	assert.match(out, /is the bottleneck/);

	const healthy = await analyticsRepo({ '.asc/analytics/en-US-funnel.json': { locale: 'en-US', impressions: 1000, pageViews: 500, installs: 300 } });
	const { out: fine } = await analytics(['funnel'], { dir: healthy });
	assert.match(fine, /both stages above benchmark/);
});

test('funnel totals the terms file when there is no funnel sibling, and --json emits rows', async () => {
	const dir = await analyticsRepo({ '.asc/analytics/en-US-terms.json': { locale: 'en-US', rows: [{ term: 'a', impressions: 100, pageViews: 20, installs: 5 }] } });
	const { out } = await analytics(['funnel'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(out).locales[0].impressions, 100);
});

test('onboarding imports a funnel export, gates it, and rates install→paid', async () => {
	const csv = 'Step,Users\nwelcome,1000\nquiz,800\npaywall,600\n';
	const dir = await analyticsRepo({ 'funnel.csv': csv, '.asc/analytics/en-US-funnel.json': { locale: 'en-US', impressions: 5000, pageViews: 2000, installs: 1000 } });
	const { code, out } = await analytics(['onboarding'], { dir, flags: { file: join(dir, 'funnel.csv'), paid: 40 } });
	assert.ok(code === 0 || code === 1, 'the gates decide the exit code');
	assert.match(out, /Onboarding: en-US/);
	assert.match(out, /install→paid/);
	const saved = await readJson(dir, '.asc/analytics/en-US-onboarding.json');
	assert.equal(saved.steps.length, 3);
	assert.equal(saved.installs, 1000, 'the App Store funnel supplies the install count');
});

test('onboarding without an install count anywhere skips the conversion gate', async () => {
	const dir = await analyticsRepo({ '.asc/analytics/en-US-onboarding.json': { locale: 'en-US', steps: [{ name: 'welcome', users: 100 }, { name: 'paywall', users: 60 }] } });
	const { out } = await analytics(['onboarding'], { dir });
	assert.match(out, /no install count/);
});

test('onboarding refuses when there is no export and nothing saved', async () => {
	const dir = await analyticsRepo();
	await assert.rejects(() => analytics(['onboarding'], { dir }), /no onboarding funnel for en-US/);
	await assert.rejects(() => analytics(['onboarding'], { dir, flags: { file: join(dir, 'nope.csv') } }), /no such export/);
});

test('onboarding --json carries the analysis', async () => {
	const dir = await analyticsRepo({ '.asc/analytics/en-US-onboarding.json': { locale: 'en-US', steps: [{ name: 'welcome', users: 100 }, { name: 'paywall', users: 60 }], installs: 100, paid: 3 } });
	const { out } = await analytics(['onboarding'], { dir, flags: { json: true, installs: 100, paid: 3 } });
	assert.equal(JSON.parse(out).locale, 'en-US');
});

test('diagnose names one stage to work on, and where it lives in the design', async () => {
	const dir = await analyticsRepo({
		'.asc/analytics/en-US-funnel.json': { locale: 'en-US', impressions: 10000, pageViews: 100, installs: 5 },
		'.asc/analytics/en-US-onboarding.json': { locale: 'en-US', steps: [{ name: 'welcome', users: 100 }, { name: 'paywall', users: 10 }], installs: 100, paid: 1 },
		'design/ux.json': { screens: [{ id: 'paywall', route: '/paywall', flow: 'paywall' }] },
	});
	const { code, out } = await analytics(['diagnose'], { dir });
	assert.equal(code, 1, 'a stage under benchmark is a finding, not a pass');
	assert.match(out, /Diagnosis: en-US/);
	assert.match(out, /Work on:/);
	const { out: raw } = await analytics(['diagnose'], { dir, flags: { json: true } });
	assert.ok(JSON.parse(raw).culprit);
});

test('diagnose is quiet when every stage is healthy, and refuses with nothing pulled', async () => {
	const empty = await analyticsRepo();
	await assert.rejects(() => analytics(['diagnose'], { dir: empty }), /nothing to diagnose for en-US/);

	const dir = await analyticsRepo({ '.asc/analytics/en-US-funnel.json': { locale: 'en-US', impressions: 1000, pageViews: 600, installs: 400 } });
	const { code, out } = await analytics(['diagnose'], { dir });
	assert.equal(code, 0);
	assert.match(out, /no stage is under its benchmark|unmeasured/);
});
