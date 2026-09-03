// Folding Apple's analytics reports. Every row shape below is copied from a
// real downloaded segment (org 6797103341, 2026-08-28) — these reports share no
// header, and inventing one would test the wrong thing.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	foldCrashes, foldDownloads, foldEngagement, foldInstallDelete, foldReports, foldSessions, inTerritory,
} from '../src/lib/analytics-fold.mjs';
import { REPORTS } from '../src/lib/analytics-api.mjs';

/** App Store Discovery and Engagement Standard — the long Event/Counts layout. */
const ENGAGEMENT = [
	{ Date: '2026-08-28', Event: 'Impression', 'Page Type': 'No page', Territory: 'United States', Counts: '900' },
	{ Date: '2026-08-28', Event: 'Impression', 'Page Type': 'No page', Territory: 'Canada', Counts: '373' },
	{ Date: '2026-08-28', Event: 'Page view', 'Page Type': 'Product page', Territory: 'United States', Counts: '45' },
	{ Date: '2026-08-28', Event: 'Tap', 'Page Type': 'No page', 'Engagement Type': 'Get', Territory: 'United States', Counts: '6' },
];

/** App Downloads Standard — keyed by Download Type, with no Event column. */
const DOWNLOADS = [
	{ Date: '2026-08-28', 'Download Type': 'First-time download', Territory: 'United States', Counts: '5' },
	{ Date: '2026-08-28', 'Download Type': 'Manual update', Territory: 'United States', Counts: '12' },
	{ Date: '2026-08-28', 'Download Type': 'Re-download', Territory: 'United States', Counts: '3' },
];

/** App Store Installation and Deletion Standard — Event plus the cohort day. */
const INSTALL_DELETE = [
	{ Date: '2026-08-28', Event: 'Install', 'Download Type': 'First-time download', 'App Download Date': '2026-08-27', Territory: 'United States', Counts: '2', 'Unique Devices': '2' },
	{ Date: '2026-08-28', Event: 'Install', 'Download Type': 'Manual update', 'App Download Date': '2026-08-23', Territory: 'United States', Counts: '3', 'Unique Devices': '3' },
	{ Date: '2026-08-28', Event: 'Delete', 'Download Type': 'First-time download', 'App Download Date': '2026-08-24', Territory: 'United States', Counts: '1', 'Unique Devices': '1' },
];

test('engagement reads impressions and page views, and ignores taps', () => {
	// A "Tap → Get" is not an install: it is the tap that starts one.
	assert.deepEqual(foldEngagement(ENGAGEMENT), { impressions: 1273, pageViews: 45 });
	assert.deepEqual(foldEngagement(undefined), { impressions: 0, pageViews: 0 });
});

test('only a first-time download counts as an install', () => {
	// 12 manual updates and 3 re-downloads are the same people again; counting
	// them would turn every release into an acquisition spike.
	assert.equal(foldDownloads(DOWNLOADS), 5);
	assert.equal(foldDownloads([]), 0);
});

test('install/delete gives a deletion rate', () => {
	assert.deepEqual(foldInstallDelete(INSTALL_DELETE), { installs: 5, deletions: 1, rate: 0.2 });
});

test('a deletion rate with no installs is null, not zero', () => {
	// "nobody deleted it" and "nobody had it" are different answers.
	assert.deepEqual(foldInstallDelete([{ Event: 'Delete', Counts: '0' }]), { installs: 0, deletions: 0, rate: null });
});

test('sessions per device is null until there are devices', () => {
	assert.deepEqual(foldSessions([{ Sessions: '400', 'Unique Devices': '100' }]), { sessions: 400, devices: 100, perDevice: 4 });
	assert.deepEqual(foldSessions([]), { sessions: 0, devices: 0, perDevice: null });
});

test('crashes per device needs the device count from sessions', () => {
	assert.deepEqual(foldCrashes([{ Crashes: '5' }], 100), { crashes: 5, perDevice: 0.05 });
	assert.deepEqual(foldCrashes([{ Crashes: '5' }], 0), { crashes: 5, perDevice: null });
});

test('a territory filter matches Apple long-form names', () => {
	assert.equal(inTerritory(ENGAGEMENT, 'united states').length, 3);
	assert.equal(inTerritory(ENGAGEMENT, null).length, 4);
});

test('foldReports takes each number from the report it is about', () => {
	const out = foldReports(
		{ [REPORTS.engagement]: ENGAGEMENT, [REPORTS.downloads]: DOWNLOADS, [REPORTS.installDelete]: INSTALL_DELETE },
		{ names: REPORTS },
	);
	assert.deepEqual(out.funnel, { impressions: 1273, pageViews: 45, installs: 5 });
	assert.equal(out.retention?.rate, 0.2);
	assert.equal(out.sessions, null);
	assert.equal(out.crashes, null);
});

test('foldReports reports an absent report as null rather than zero', () => {
	// An app Apple produced no sessions report for has unknown engagement. A
	// zero here would read as "nobody opened it" and diagnose would act on it.
	const out = foldReports({ [REPORTS.engagement]: ENGAGEMENT }, { names: REPORTS });
	assert.equal(out.sessions, null);
	assert.equal(out.retention, null);
	assert.equal(out.crashes, null);
	assert.equal(out.funnel.installs, 0);
});

test('foldReports honours a territory across every report', () => {
	const out = foldReports({ [REPORTS.engagement]: ENGAGEMENT }, { names: REPORTS, territory: 'canada' });
	assert.deepEqual(out.funnel, { impressions: 373, pageViews: 0, installs: 0 });
});
