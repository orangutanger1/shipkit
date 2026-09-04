// The analytics wrapper's failure modes, against a fake `asc`.
//
// Every one of these was a real answer from a real account: an asc too old to
// know the Analytics Reports API, a key with the wrong role, a payload with a
// banner printed ahead of the JSON, an instance with no segments. They are here
// because each of them used to surface as a stack trace or an empty report
// rather than a sentence naming what to do about it.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fakeBins, setBin } from './fixtures/cmd.mjs';

await fakeBins(['asc']);

const { ascJSON, collectSegments, downloadSegments, requireCredentials, segmentsOfView, windowOf } =
	await import('../src/lib/analytics-api.mjs');

/** Collects what the command would have printed. */
const say = () => {
	const notes = [];
	const warns = [];
	return { notes, warns, note: (m) => notes.push(m), warn: (m) => warns.push(m) };
};

// ── ascJSON ─────────────────────────────────────────────────────────────────

test('an asc that does not know the subcommand is named, with the upgrade line', async () => {
	setBin('asc', [['analytics', { err: 'Error: unexpected argument \'--include-segments\'', code: 2 }]]);
	await assert.rejects(() => ascJSON(['analytics', 'view'], { what: 'list the reports' }), (err) => {
		assert.match(err.message, /the installed asc cannot list the reports/);
		assert.match(err.hint, /`asc analytics view` is not available/);
		assert.match(err.hint, /ship analytics pull --file/);
		return true;
	});
});

test('a key with the wrong role is told which roles answer this way', async () => {
	setBin('asc', [['analytics', { err: 'FORBIDDEN: not authorized for this resource', code: 1 }]]);
	await assert.rejects(() => ascJSON(['analytics', 'requests'], { what: 'list requests' }), (err) => {
		assert.match(err.message, /refused analytics access while trying to list requests/);
		assert.match(err.hint, /Customer Support or Finance-only key/);
		assert.match(err.hint, /not authorized/, 'asc\'s own words are kept');
		return true;
	});
});

test('any other non-zero exit reports the code and the last of the output', async () => {
	setBin('asc', [['analytics', { err: 'socket hang up', code: 7 }]]);
	await assert.rejects(() => ascJSON(['analytics', 'requests']), (err) => {
		assert.match(err.message, /asc analytics requests exited 7/);
		assert.match(err.hint, /socket hang up/);
		return true;
	});
});

test('an empty answer is the fallback, not a parse error', async () => {
	setBin('asc', [['analytics', { out: '' }]]);
	assert.deepEqual(await ascJSON(['analytics', 'requests']), {});
	assert.deepEqual(await ascJSON(['analytics', 'requests'], { fallback: { data: [] } }), { data: [] });
});

test('JSON printed after a banner is still read', async () => {
	setBin('asc', [['analytics', { out: 'Using credentials from ~/.asc\n{"data":[{"id":"r1"}]}' }]]);
	assert.deepEqual(await ascJSON(['analytics', 'requests']), { data: [{ id: 'r1' }] });
});

test('output that is not JSON at all is refused with what was printed', async () => {
	setBin('asc', [['analytics', { out: 'nothing here is a document' }]]);
	await assert.rejects(() => ascJSON(['analytics', 'requests']), (err) => {
		assert.match(err.message, /returned output that is not JSON/);
		assert.match(err.hint, /nothing here is a document/);
		return true;
	});
	// A brace that opens nothing is the same refusal, one level deeper.
	setBin('asc', [['analytics', { out: 'banner {not json either' }]]);
	await assert.rejects(() => ascJSON(['analytics', 'requests']), /not JSON/);
});

// ── credentials ─────────────────────────────────────────────────────────────

test('no stored credentials is said before a round trip is spent', async () => {
	setBin('asc', [['auth status', { out: { credentials: [] } }]]);
	await assert.rejects(() => requireCredentials(), (err) => {
		assert.match(err.message, /no App Store Connect API credentials are configured/);
		assert.match(err.hint, /asc auth login/);
		return true;
	});
});

test('an auth status that is not JSON counts as no credentials', async () => {
	setBin('asc', [['auth status', { out: 'asc: command not configured' }]]);
	await assert.rejects(() => requireCredentials(), /no App Store Connect API credentials/);
	setBin('asc', [['auth status', { out: '' }]]);
	await assert.rejects(() => requireCredentials(), /no App Store Connect API credentials/);
});

test('either a stored key or a complete environment counts as configured', async () => {
	setBin('asc', [['auth status', { out: { credentials: [{ name: 'ci' }] } }]]);
	await requireCredentials();
	setBin('asc', [['auth status', { out: { environmentCredentialsComplete: true } }]]);
	await requireCredentials();
});

// ── the window ──────────────────────────────────────────────────────────────

test('the window defaults to the last thirty days, ending today', () => {
	const { from, to } = windowOf({});
	assert.match(to, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(Math.round((Date.parse(to) - Date.parse(from)) / 86400000), 29);
	assert.equal(windowOf({ to: '2026-08-31' }).from, '2026-08-02', '--to alone still spans thirty days');
	assert.deepEqual(windowOf({ from: '2026-08-01', to: '2026-08-05' }), { from: '2026-08-01', to: '2026-08-05' });
});

test('a window that is not a date, or runs backwards, is refused by name', () => {
	assert.throws(() => windowOf({ from: 'yesterday', to: '2026-08-31' }), /--from must be YYYY-MM-DD, got "yesterday"/);
	assert.throws(() => windowOf({ from: '2026-08-01', to: '2026-13-45' }), /--to must be YYYY-MM-DD/);
	assert.throws(() => windowOf({ from: '2026-09-01', to: '2026-08-01' }), /--from 2026-09-01 is after --to 2026-08-01/);
});

// ── reading a view ──────────────────────────────────────────────────────────

test('a view with nothing usable in it yields no segments rather than throwing', () => {
	const opts = { requestId: 'r1' };
	assert.deepEqual(segmentsOfView(undefined, opts), []);
	assert.deepEqual(segmentsOfView({ data: 'not an array' }, opts), []);
	assert.deepEqual(segmentsOfView({ data: [{ name: 'Some Other Report', instances: [] }] }, opts), []);
	assert.deepEqual(segmentsOfView({ data: [{ instances: [{ segments: [{ id: 's1' }] }] }] }, opts), [], 'a report with no name is not one we asked for');
	assert.deepEqual(segmentsOfView({ data: [{ name: 'App Downloads Standard' }] }, opts), [], 'a report with no instances');
	assert.deepEqual(
		segmentsOfView({ data: [{ name: 'App Downloads Standard', instances: [{ granularity: 'WEEKLY', segments: [{ id: 's1' }] }] }] }, opts),
		[],
		'a weekly instance is not the daily one asked for',
	);
	assert.deepEqual(
		segmentsOfView({ data: [{ name: 'App Downloads Standard', instances: [{ id: 'i1', segments: 'nope' }] }] }, opts),
		[],
		'segments that are not a list',
	);
	assert.deepEqual(
		segmentsOfView({ data: [{ name: 'App Downloads Standard', instances: [{ id: 'i1', segments: [{ checkSum: 'x' }] }] }] }, opts),
		[],
		'a segment with no id cannot be downloaded',
	);
});

test('an instance with no processingDate still yields its segments, dateless', () => {
	const rows = segmentsOfView(
		{ data: [{ name: 'App Downloads Standard', instances: [{ id: 'i1', segments: [{ id: 's1' }] }] }] },
		{ requestId: 'r1' },
	);
	assert.deepEqual(rows, [{ report: 'App Downloads Standard', requestId: 'r1', instance: 'i1', id: 's1', date: '' }]);

	const idless = segmentsOfView(
		{ data: [{ name: 'App Downloads Standard', instances: [{ segments: [{ id: 's1' }] }] }] },
		{ requestId: 'r1' },
	);
	assert.equal(idless[0].instance, '', 'an instance with no id of its own still names its segment');
});

// ── collecting ──────────────────────────────────────────────────────────────

const REQUESTS = (rows) => ({ data: rows.map((r) => ({ type: 'analyticsReportRequests', id: r.id, attributes: r })) });

test('a request Apple stopped for inactivity is not one to read from', async () => {
	setBin('asc', [['analytics requests', { out: REQUESTS([{ id: 'r1', accessType: 'ONGOING', stoppedDueToInactivity: true }]) }]]);
	assert.deepEqual(await collectSegments('111', { from: '2026-08-01', to: '2026-08-01' }), { requestId: null, segments: [] });
});

test('the ongoing request is preferred, and a segment seen twice is kept once', async () => {
	const view = {
		data: [{
			name: 'App Downloads Standard',
			instances: [{ id: 'i1', granularity: 'DAILY', processingDate: '2026-08-01', segments: [{ id: 's1' }, { id: 's2' }] }],
		}],
	};
	setBin('asc', [
		['analytics requests', { out: REQUESTS([{ id: 'one-off', accessType: 'ONE_TIME_SNAPSHOT' }, { id: 'live', accessType: 'ONGOING' }]) }],
		['analytics view', { out: view }],
	]);
	const log = say();
	const got = await collectSegments('111', { from: '2026-08-01', to: '2026-08-03' }, log);
	assert.equal(got.requestId, 'live');
	assert.equal(got.segments.length, 2, 'the same segments answered on both days are two rows, not four');
	assert.match(log.notes[0], /2026-08-01 · 2 segments so far \(2 days left\)/);
	assert.match(log.notes[1], /2026-08-02 · 2 segments so far \(1 day left\)/);
	assert.match(log.notes[2], /2026-08-03 · 2 segments so far$/);
});

test('with no ongoing request, the first usable one is read instead', async () => {
	setBin('asc', [
		['analytics requests', { out: REQUESTS([{ id: 'snap', accessType: 'ONE_TIME_SNAPSHOT' }]) }],
		['analytics view', { out: { data: [] } }],
	]);
	const got = await collectSegments('111', { from: '2026-08-01', to: '2026-08-01' });
	assert.equal(got.requestId, 'snap');
	assert.deepEqual(got.segments, []);
});

// ── downloading ─────────────────────────────────────────────────────────────

const seg = (id, report, instance = 'i1') => ({ id, report, instance, requestId: 'r1', date: '2026-08-01' });

test('a segment that will not download is warned about, and the rest still land', async () => {
	setBin('asc', [
		['--segment-id bad', { err: 'HTTP 500 from Apple', code: 1 }],
		['analytics download', { files: { 'report.csv': 'Date\tDownloads\n2026-08-01\t7\n', 'notes.md': 'ignored' } }],
	]);
	const log = say();
	const out = await downloadSegments([seg('bad', 'Downloads'), seg('good', 'Downloads'), seg('other', 'Sessions')], log);
	assert.equal(out.downloaded, 2);
	assert.match(log.warns[0], /segment bad did not download: HTTP 500 from Apple/);
	assert.deepEqual(Object.keys(out.byReport), ['Downloads', 'Sessions'], 'rows stay grouped by report');
	assert.deepEqual(out.byReport.Downloads, [{ Date: '2026-08-01', Downloads: '7' }], 'only the delimited file is read');
});
