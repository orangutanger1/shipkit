// `ship status` ASC sections: collect (asc-backed) + render (colour/shape) for
// app identity, review, builds, TestFlight. asc() is stubbed via SHIP_ASC_BIN —
// no network, no Apple credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// exec.mjs reads SHIP_ASC_BIN once, at first import, and status-asc.mjs imports
// exec.mjs by its plain specifier — so the stub binary must live at one fixed
// path for the whole process; only its script content changes per test.
const STUB_DIR = await mkdtemp(join(tmpdir(), 'ship-status-asc-'));
const STUB_BIN = join(STUB_DIR, 'asc');
process.env.SHIP_ASC_BIN = STUB_BIN;
const statusAsc = await import('../src/lib/status-asc.mjs');

/** Route asc subcommands to canned JSON, mirroring exec.test.mjs's stub approach. */
async function withStub(routes, fn) {
	const cases = Object.entries(routes)
		.map(([key, json]) => `  *"${key}"*) echo '${json.replace(/'/g, `'\\''`)}' ;;`)
		.join('\n');
	await writeFile(
		STUB_BIN,
		`#!/bin/sh\nargs="$*"\ncase "$args" in\n${cases}\n  *) echo '{}' ;;\nesac\n`,
	);
	await chmod(STUB_BIN, 0o755);
	return fn(statusAsc);
}

test.after(async () => {
	await rm(STUB_DIR, { recursive: true, force: true });
});

function captureStdout(fn) {
	const chunks = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		chunks.push(chunk);
		return true;
	};
	try {
		const result = fn();
		return { result, output: chunks.join('') };
	} finally {
		process.stdout.write = original;
	}
}

const noDash = { dash: async () => null, expo: async () => null, version: async () => '1.0.0' };

/* ------------------------------------------------------------------ app -- */

test('collectApp falls back to dash/expo/config when there is no appId', async () => {
	await withStub({}, async ({ collectApp }) => {
		const ctx = {
			appId: null,
			cfg: { name: 'Cfg App', bundleId: 'com.cfg.app', asc: { primaryLocale: 'en-US' }, eas: { projectId: null, channel: 'prod' } },
			...noDash,
		};
		const d = await collectApp(ctx);
		assert.equal(d.name, 'Cfg App');
		assert.equal(d.bundleId, 'com.cfg.app');
		assert.equal(d.sku, null);
		assert.equal(d.appId, null);
	});
});

test('collectApp prefers ASC attributes and dash summary over config when an appId is set', async () => {
	await withStub(
		{ 'apps view': JSON.stringify({ data: { attributes: { name: 'ASC App', bundleId: 'com.asc.app', sku: 'SKU1', primaryLocale: 'en-GB' } } }) },
		async ({ collectApp }) => {
			const ctx = {
				appId: 'app1',
				cfg: { name: 'Cfg App', bundleId: 'com.cfg.app', asc: { primaryLocale: 'en-US' }, eas: { projectId: null, channel: 'prod' } },
				dash: async () => ({ summary: { health: 'green', nextAction: 'submit' }, links: { asc: 'https://x' } }),
				expo: async () => ({ extra: { eas: { projectId: 'exp1' } } }),
				version: async () => '2.0.0',
			};
			const d = await collectApp(ctx);
			assert.equal(d.name, 'ASC App');
			assert.equal(d.bundleId, 'com.asc.app');
			assert.equal(d.sku, 'SKU1');
			assert.equal(d.easProjectId, 'exp1');
			assert.equal(d.health, 'green');
			assert.equal(d.nextAction, 'submit');
		},
	);
});

test('renderApp warns on a bundle id drifted from config, and prints links', async () => {
	await withStub({}, async ({ renderApp }) => {
		const { output } = captureStdout(() =>
			renderApp({
				name: 'App', bundleId: 'com.live', configBundleId: 'com.config', appId: 'a1',
				version: '1.0', primaryLocale: 'en-US', easProjectId: null, easChannel: 'prod',
				health: null, nextAction: null, links: { asc: 'https://x' },
			}),
		);
		assert.match(output, /ASC bundle id is com\.live but ship\.config\.json says com\.config/);
		assert.match(output, /asc: https:\/\/x/);
	});
});

test('renderApp is quiet about bundle id when they match, and colours health', async () => {
	await withStub({}, async ({ renderApp }) => {
		const { output } = captureStdout(() =>
			renderApp({
				name: 'App', bundleId: 'com.a', configBundleId: 'com.a', appId: null,
				version: '1.0', primaryLocale: 'en-US', easProjectId: 'e1', easChannel: 'prod',
				health: 'red', nextAction: 'fix it', links: {},
			}),
		);
		assert.doesNotMatch(output, /ASC bundle id/);
		assert.match(output, /next/);
		assert.match(output, /fix it/);
		assert.match(output, /unset/);
	});
});

/* --------------------------------------------------------------- review -- */

test('collectReview throws a ShipError with a hint when there is no appId', async () => {
	await withStub({}, async ({ collectReview }) => {
		await assert.rejects(
			() => collectReview({ appId: null, dash: async () => null }),
			(err) => {
				assert.match(err.message, /no App Store Connect app id/);
				assert.match(err.hint, /asc\.appId/);
				return true;
			},
		);
	});
});

test('collectReview sorts versions by createdDate, newest first, capped at 3', async () => {
	const versions = {
		data: [
			{ id: '1', attributes: { versionString: '1.0', appStoreState: 'READY_FOR_SALE', createdDate: '2024-01-01T00:00:00Z' } },
			{ id: '2', attributes: { versionString: '1.1', appVersionState: 'IN_REVIEW', createdDate: '2024-03-01T00:00:00Z' } },
			{ id: '3', attributes: { versionString: '1.2', appStoreState: 'REJECTED', createdDate: '2024-02-01T00:00:00Z' } },
			{ id: '4', attributes: { versionString: '1.3', appStoreState: 'PENDING_RELEASE', createdDate: '2024-04-01T00:00:00Z' } },
		],
	};
	await withStub({ 'versions list': JSON.stringify(versions) }, async ({ collectReview }) => {
		const d = await collectReview({
			appId: 'a1',
			dash: async () => ({
				appstore: { state: 'READY_FOR_SALE', version: '1.3' },
				submission: { inFlight: false, blockingIssues: ['bad metadata'] },
				review: { state: 'IN_REVIEW', submittedDate: '2024-04-02T00:00:00Z' },
				phasedRelease: { configured: true },
			}),
		});
		assert.deepEqual(d.versions.map((v) => v.versionString), ['1.3', '1.1', '1.2']);
		assert.equal(d.current, 'READY_FOR_SALE');
		assert.equal(d.blockingIssues.length, 1);
		assert.equal(d.phasedRelease, true);
	});
});

test('collectReview falls back to the newest version when dash has nothing', async () => {
	const versions = { data: [{ id: '1', attributes: { versionString: '1.0', appVersionState: 'WAITING_FOR_REVIEW', createdDate: '2024-01-01T00:00:00Z' } }] };
	await withStub({ 'versions list': JSON.stringify(versions) }, async ({ collectReview }) => {
		const d = await collectReview({ appId: 'a1', dash: async () => null });
		assert.equal(d.current, 'WAITING_FOR_REVIEW');
		assert.equal(d.currentVersion, '1.0');
		assert.equal(d.submissionInFlight, null);
		assert.deepEqual(d.blockingIssues, []);
	});
});

test('renderReview colours states and reports blockers, submission, and phased release', async () => {
	await withStub({}, async ({ renderReview }) => {
		const { output } = captureStdout(() =>
			renderReview({
				versions: [{ versionString: '1.0', appStoreState: 'REJECTED', releaseType: 'MANUAL', createdDate: '2024-01-01T00:16:00Z' }],
				reviewState: 'WAITING_FOR_REVIEW',
				reviewSubmitted: '2024-01-02T00:16:00Z',
				submissionInFlight: false,
				blockingIssues: ['missing screenshot', { code: 'X' }],
				phasedRelease: true,
			}),
		);
		assert.match(output, /submission/);
		assert.match(output, /since 2024-01-02 00:16/);
		assert.match(output, /blocker: missing screenshot/);
		assert.match(output, /blocker: \{"code":"X"\}/);
		assert.match(output, /phased release configured/);
	});
});

test('renderReview leaves an unrecognised state uncoloured', async () => {
	await withStub({}, async ({ renderReview }) => {
		const { output } = captureStdout(() =>
			renderReview({
				versions: [{ versionString: '1.0', appStoreState: 'DEVELOPER_REMOVED_FROM_SALE', releaseType: 'MANUAL', createdDate: '2024-01-01T00:16:00Z' }],
				reviewState: null, reviewSubmitted: null, submissionInFlight: null, blockingIssues: [], phasedRelease: false,
			}),
		);
		assert.match(output, /DEVELOPER_REMOVED_FROM_SALE/);
	});
});

test('renderReview reports "no submission in flight" only when review state is absent', async () => {
	await withStub({}, async ({ renderReview }) => {
		const { output } = captureStdout(() =>
			renderReview({ versions: [], reviewState: null, reviewSubmitted: null, submissionInFlight: false, blockingIssues: [], phasedRelease: false }),
		);
		assert.match(output, /no submission in flight/);
	});
});

/* --------------------------------------------------------------- builds -- */

test('collectBuilds throws without an appId', async () => {
	await withStub({}, async ({ collectBuilds }) => {
		await assert.rejects(() => collectBuilds({ appId: null }), /no App Store Connect app id/);
	});
});

test('collectBuilds maps build number vs marketing version and sorts newest-first', async () => {
	const now = new Date();
	const future = new Date(now.getTime() + 5 * 86_400_000).toISOString();
	const list = {
		data: [
			{
				id: 'b1',
				attributes: { version: '10', processingState: 'VALID', uploadedDate: '2024-01-01T00:00:00Z', expirationDate: future },
				relationships: { preReleaseVersion: { data: { id: 'p1' } } },
			},
			{
				id: 'b2',
				attributes: { version: '11', processingState: 'FAILED', uploadedDate: '2024-06-01T00:00:00Z' },
				relationships: { preReleaseVersion: { data: { id: 'p2' } } },
			},
		],
		included: [
			{ type: 'preReleaseVersions', id: 'p1', attributes: { version: '1.0' } },
			{ type: 'preReleaseVersions', id: 'p2', attributes: { version: '1.1' } },
		],
	};
	await withStub({ 'builds list': JSON.stringify(list) }, async ({ collectBuilds }) => {
		const rows = await collectBuilds({ appId: 'a1' });
		assert.deepEqual(rows.map((r) => r.buildNumber), ['11', '10']);
		assert.deepEqual(rows.map((r) => r.version), ['1.1', '1.0']);
		assert.equal(rows[1].expiresInDays, 5);
	});
});

test('renderBuilds colours processing state and flags near-expiry builds', async () => {
	await withStub({}, async ({ renderBuilds }) => {
		const { output } = captureStdout(() =>
			renderBuilds([
				{ version: '1.0', buildNumber: '10', processingState: 'VALID', uploadedDate: '2024-01-01T00:16:00Z', expirationDate: '2024-04-01T00:16:00Z', expiresInDays: 10 },
				{ version: null, buildNumber: '11', processingState: 'PROCESSING', uploadedDate: '2024-06-01T00:16:00Z', expirationDate: null, expiresInDays: null },
			]),
		);
		assert.match(output, /\(10d\)/);
		assert.match(output, /VALID/);
		assert.match(output, /PROCESSING/);
	});
});

/* ----------------------------------------------------------- testflight -- */

test('collectTestFlight throws without an appId', async () => {
	await withStub({}, async ({ collectTestFlight }) => {
		await assert.rejects(() => collectTestFlight({ appId: null, dash: async () => null }), /no App Store Connect app id/);
	});
});

test('collectTestFlight groups testers by state and carries beta review info', async () => {
	const groups = { data: [{ attributes: { name: 'Internal', isInternalGroup: true, hasAccessToAllBuilds: true } }] };
	const testers = { data: [{ attributes: { state: 'ACCEPTED' } }, { attributes: { state: 'ACCEPTED' } }, { attributes: { state: 'INVITED' } }] };
	await withStub(
		{ 'testflight groups list': JSON.stringify(groups), 'testflight testers list': JSON.stringify(testers) },
		async ({ collectTestFlight }) => {
			const d = await collectTestFlight({
				appId: 'a1',
				dash: async () => ({ testflight: { betaReviewState: 'APPROVED', submittedDate: '2024-01-01T00:16:00Z' } }),
			});
			assert.equal(d.groups.length, 1);
			assert.equal(d.groups[0].internal, true);
			assert.equal(d.testers, 3);
			assert.deepEqual(d.byState, { ACCEPTED: 2, INVITED: 1 });
			assert.equal(d.betaReviewState, 'APPROVED');
		},
	);
});

test('renderTestFlight prints the empty-state note when there are no groups or testers', async () => {
	await withStub({}, async ({ renderTestFlight }) => {
		const { output } = captureStdout(() => renderTestFlight({ groups: [], testers: 0, byState: {}, betaReviewState: null, betaSubmittedDate: null }));
		assert.match(output, /no beta groups or testers/);
	});
});

test('renderTestFlight singularises "tester" for exactly one and reports beta review state', async () => {
	await withStub({}, async ({ renderTestFlight }) => {
		const { output } = captureStdout(() =>
			renderTestFlight({
				groups: [{ name: 'Ext', internal: false, allBuilds: false }],
				testers: 1,
				byState: { ACCEPTED: 1 },
				betaReviewState: 'WAITING_FOR_REVIEW',
				betaSubmittedDate: null,
			}),
		);
		assert.match(output, /1 tester \(1 accepted\)/);
		assert.match(output, /beta review/);
		assert.doesNotMatch(output, /testers /);
	});
});
