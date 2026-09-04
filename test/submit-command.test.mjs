// `ship submit` end to end: upload, wait for processing, readiness, submit.
// `eas` and `asc` are fake binaries; no test ever waits a poll interval,
// because every case either resolves on the first poll or runs out of budget
// before one is due.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc', 'npx']);

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
