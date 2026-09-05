// `ship submit` end to end: upload, wait for processing, readiness, submit.
// `eas` and `asc` are fake binaries; no test ever waits a poll interval,
// because every case either resolves on the first poll or runs out of budget
// before one is due.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc', 'npx']);
// Real setTimeout backs the poll loop; without this the one test that lets a
// build clear on a second poll would burn a real 30s.
process.env.SHIP_SUBMIT_POLL_MS = '5';

const { run } = await import('../src/commands/submit.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0', asc: { appId: '111' }, eas: { profile: 'production' } };

const VALID_BUILD = { data: [{ id: 'build-9', attributes: { version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' } }] };
const CLEAN_VALIDATE = { summary: { blocking: 0, errors: 0 }, checks: [], remediation: { steps: [] } };

/** @param {{builds?: object, validate?: object, review?: object, extra?: any[]}} [opts] */
function ascOk({ builds = VALID_BUILD, validate = CLEAN_VALIDATE, review = { data: { id: 'sub-1' } }, extra = [] } = {}) {
	setBin('asc', [...extra, ['builds list', { out: builds }], ['^validate', { out: validate }], ['review submit', { out: review }]]);
	setBin('npx', [['eas-cli@latest submit', { out: 'uploaded' }]]);
}

/** @param {{flags?: object, dir: string, args?: string[]}} opts */
async function submit({ flags = {}, dir, args = [] }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => run({ args, flags })));
	return { code: result, out };
}

const submitRepo = (config = {}) => repo({ config: { ...CONFIG, ...config }, files: { 'app.json': { expo: { version: '1.2.0' } } }, prefix: 'ship-submit-' });

test('submit takes no arguments, and rejects a nonsense timeout', async () => {
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, args: ['now'] }), /unexpected argument "now"/);
	await assert.rejects(() => submit({ dir, flags: { timeout: 'soon' } }), /--timeout must be a positive number/);
});

test('the happy path uploads, waits, validates and submits', async () => {
	ascOk();
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { json: true } });
	assert.equal(code, 0);
	assert.match(out, /binary uploaded to App Store Connect/);
	assert.match(out, /build 42 \(2026-09-01\) processed/);
	assert.match(out, /validate is clean/);
	assert.match(out, /submitted for review \(build build-9\)/);

	const summary = JSON.parse(out.slice(out.lastIndexOf('{')));
	assert.deepEqual(
		{ uploaded: summary.uploaded, buildId: summary.buildId, validated: summary.validated, submitted: summary.submitted },
		{ uploaded: true, buildId: 'build-9', validated: true, submitted: true },
	);
});

test('--skip-upload resumes against a build already in App Store Connect', async () => {
	ascOk();
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true } });
	assert.equal(code, 0);
	assert.match(out, /skipped — --skip-upload/);
	assert.equal((await calls()).filter((call) => call.bin === 'npx').length, 0);
});

test('a failed upload is reported with the usual cause', async () => {
	ascOk();
	setBin('npx', [['eas-cli@latest submit', { out: '', code: 1 }]]);
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir }), /eas submit failed \(exit 1\)/);
});

test('a build Apple rejected in processing stops the run', async () => {
	ascOk({ builds: { data: [{ id: 'b', attributes: { version: '42', processingState: 'INVALID' } }] } });
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /build processing invalid/);
});

test('a processing budget that runs out says what the last state was', async () => {
	ascOk({ builds: { data: [{ id: 'b', attributes: { version: '42', processingState: 'PROCESSING' } }] } });
	const dir = await submitRepo();
	await assert.rejects(
		() => submit({ dir, flags: { 'skip-upload': true, timeout: 1 } }),
		/timed out after 1s waiting for processing; last state was PROCESSING/,
	);
});

test('an app with no builds at all is reported the same way', async () => {
	ascOk({ builds: { data: [] } });
	const dir = await submitRepo();
	await assert.rejects(
		() => submit({ dir, flags: { 'skip-upload': true, timeout: 1 } }),
		/last state was no builds returned/,
	);
});

test('validate findings stop the submission, and --force pushes past them', async () => {
	const dirty = {
		summary: { blocking: 1, errors: 1 },
		checks: [{ id: 'privacy', severity: 'ERROR', message: 'privacy policy URL missing' }, { id: 'note', severity: 'info', message: 'advisory' }],
		remediation: { steps: [{ order: 1, blocking: true, message: 'add a privacy URL', remediation: 'store/app-info' }] },
	};
	ascOk({ validate: dirty });
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /validate reported problems — not submitting/);

	const { code, out } = await submit({ dir, flags: { 'skip-upload': true, force: true } });
	assert.equal(code, 0);
	assert.match(out, /privacy policy URL missing/);
	assert.match(out, /remediation plan/);
	assert.match(out, /--force: submitting a version validate says will be rejected/);
});

test('an unreadable validate is unknown, not clean', async () => {
	ascOk({ validate: null });
	setBin('asc', [['builds list', { out: VALID_BUILD }], ['review submit', { out: { data: {} } }]]);
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /cannot confirm the version is submittable/);
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true, force: true } });
	assert.equal(code, 0);
	assert.match(out, /treating readiness as unknown/);
});

test('a refused review submission surfaces asc stderr and where to check', async () => {
	ascOk();
	setBin('asc', [['builds list', { out: VALID_BUILD }], ['^validate', { out: CLEAN_VALIDATE }], ['review submit', { out: '', err: 'version not ready', code: 1 }]]);
	setBin('npx', [['eas-cli@latest submit', { out: 'uploaded' }]]);
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /asc review submit exited 1/);
});

test('a build with no reportable state yet still resolves once Apple reports one', async () => {
	// Apple's own dashboard shows builds sitting with no processingState at
	// all before the pipeline picks them up; the poll message has to say
	// something honest ("unknown") rather than crash on the missing field,
	// and has to keep polling — with the real timer — until it clears.
	await resetCalls();
	setBin('asc', [
		['builds list', { out: { data: [{ id: 'b', attributes: {} }] } }],
		['^validate', { out: CLEAN_VALIDATE }],
		['review submit', { out: { data: { id: 'sub-1' } } }],
	]);
	setBin('npx', [['eas-cli@latest submit', { out: 'uploaded' }]]);
	const dir = await submitRepo();
	const pending = capture(() => inDir(dir, () => run({ args: [], flags: { 'skip-upload': true, timeout: 5 } })));
	while ((await calls()).filter((c) => c.args.join(' ').includes('builds list')).length < 1) {
		await new Promise((r) => setTimeout(r, 5));
	}
	setBin('asc', [
		['builds list', { out: { data: [{ id: 'b', attributes: { version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' } }] } }],
		['^validate', { out: CLEAN_VALIDATE }],
		['review submit', { out: { data: { id: 'sub-1' } } }],
	]);
	const { result, out } = await pending;
	assert.equal(result, 0);
	assert.match(out, /poll 1: unknown/);
	assert.match(out, /build 42 \(2026-09-01\) processed/);
});

test('a validate response this parser has never seen still resolves clean, not crashed', async () => {
	// Not every ASC account/role returns the documented shape; an object where
	// `checks` and `remediation` are present but hold none of the recognised
	// array keys, and no `summary` at all, must read as "nothing blocking"
	// rather than throw reading .length off something that is not an array.
	ascOk({ validate: { checks: { note: 'nothing structured' }, remediation: {} } });
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true } });
	assert.equal(code, 0);
	assert.match(out, /validate is clean/);
});

test('the readiness table renders every shape a check and a plan step can arrive in', async () => {
	const odd = {
		summary: { errors: 2 }, // no `blocking` key — falls back to `errors`
		checks: [
			{ checkId: 'c1', severity: 'WARNING', message: 'needs review' }, // id via checkId, warning mark
			{ severity: 'NOTICE' }, // unrecognised level, no message, no id/checkId at all
			{ message: 'no severity given' }, // severity missing entirely
		],
		remediation: { steps: [{ order: 1, message: 'do X' }] }, // non-blocking step
	};
	ascOk({ validate: odd });
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true, force: true } });
	assert.equal(code, 0);
	assert.match(out, /needs review/);
	assert.match(out, /no severity given/);
	assert.match(out, /1\. do X/); // no "blocking" prefix on a non-blocking step
});

test('a failed build is named by whatever identifying field it has, down to none at all', async () => {
	ascOk({ builds: { data: [{ attributes: { buildNumber: '9', processingState: 'FAILED' } }] } });
	let dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /failed for 9 \(no date\)/);

	ascOk({ builds: { data: [{ attributes: { processingState: 'FAILED' } }] } });
	dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /failed for \? \(no date\)/);
});

test('a build reported without the usual attributes wrapper still resolves', async () => {
	// Not every asc version nests build fields under `attributes`.
	ascOk({ builds: { data: [{ id: 'b', version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' }] } });
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true } });
	assert.equal(code, 0);
	assert.match(out, /build 42 \(2026-09-01\) processed/);
});

test('a processed build with no id refuses to guess which one to submit', async () => {
	ascOk({ builds: { data: [{ attributes: { version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' } }] } });
	const dir = await submitRepo();
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), /no processed build id to attach/);
});

test('--build names the id explicitly when the processed build did not carry one', async () => {
	ascOk({
		builds: { data: [{ attributes: { version: '42', processingState: 'VALID', uploadedDate: '2026-09-01' } }] },
		review: { data: { id: 'sub-2' } },
	});
	const dir = await submitRepo();
	const { code, out } = await submit({ dir, flags: { 'skip-upload': true, build: '77' } });
	assert.equal(code, 0);
	assert.match(out, /submitted for review \(build 77\)/);
});

test('a refused review submission with no stderr at all still points at where to check', async () => {
	setBin('asc', [['builds list', { out: VALID_BUILD }], ['^validate', { out: CLEAN_VALIDATE }], ['review submit', { out: '', code: 1 }]]);
	setBin('npx', [['eas-cli@latest submit', { out: 'uploaded' }]]);
	const dir = await submitRepo();
	// The remediation hint reads asc's stderr; with none captured it must say
	// so plainly rather than print an empty line the operator has to guess at.
	await assert.rejects(() => submit({ dir, flags: { 'skip-upload': true } }), (err) => {
		assert.match(err.message, /asc review submit exited 1/);
		assert.match(err.hint, /no stderr/);
		return true;
	});
});

test('a builds-list call that returns unparseable output is "no builds", not a crash', async () => {
	// asc() falls back to null on empty/unparseable stdout — a different code
	// path than an empty `data` array, and it must read the same to the operator.
	setBin('asc', [['builds list', { out: '' }]]);
	const dir = await submitRepo();
	await assert.rejects(
		() => submit({ dir, flags: { 'skip-upload': true, timeout: 1 } }),
		/last state was no builds returned/,
	);
});

test('--dry-run walks every step without touching Apple', async () => {
	ascOk();
	const dir = await submitRepo();
	setDryRun(true);
	try {
		const { code, out } = await submit({ dir });
		assert.equal(code, 0);
		assert.match(out, /dry run — nothing uploaded/);
		assert.match(out, /would poll `asc builds list/);
		assert.match(out, /would run `asc review submit/);
	} finally {
		setDryRun(false);
	}
});
