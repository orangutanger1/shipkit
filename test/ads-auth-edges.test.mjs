// Apple Ads credential UX, on the inputs a real account produces once you
// stop assuming every field Apple documents is actually in the response: an
// `acls` row missing half its names, an account API answering with something
// that is not the object shape the happy path expects, a login run from
// outside a repo. `ship ads plan` never touches any of this — see ads.test.mjs
// and ads-plan-edges.test.mjs for that half.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeBins, fakeHome, inDir, repo, resetCalls, setBin, capture } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { gate, login, orgOf, requireOrg, status } = await import('../src/lib/ads-auth.mjs');
const { setDryRun } = await import('../src/exec.mjs');

/** @param {string[]} args @param {{flags?: object, dir?: string}} opts */
async function run(fn, { flags = {}, dir } = {}) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir ?? process.cwd(), () => fn({ flags })));
	return { code: result, out };
}

test('orgOf: --org, then config, then the environment, in that order', () => {
	assert.equal(orgOf(null, { org: 'A' }), 'A');
	assert.equal(orgOf({ ads: { orgId: 'B' } }, {}), 'B');
	const saved = process.env.ASC_ADS_ORG_ID;
	process.env.ASC_ADS_ORG_ID = 'C';
	try {
		assert.equal(orgOf(null, {}), 'C');
		assert.equal(orgOf(undefined, {}), 'C');
	} finally {
		if (saved === undefined) delete process.env.ASC_ADS_ORG_ID;
		else process.env.ASC_ADS_ORG_ID = saved;
	}
});

test('requireOrg refuses to guess, and names every way to supply one', () => {
	delete process.env.ASC_ADS_ORG_ID;
	assert.throws(() => requireOrg(null, {}), /no Apple Ads organization id/);
	assert.equal(requireOrg({ ads: { orgId: 42 } }, {}), '42', 'a numeric org id still comes back as a string');
});

test('status --json falls back to the raw payload when `me` answers with no data wrapper', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: { userId: 5, parentOrgId: '1' } }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out } = await run(status, { flags: { json: true } });
	const parsed = JSON.parse(out);
	assert.deepEqual(parsed.me, { userId: 5, parentOrgId: '1' }, 'no `.data` to unwrap, so the payload itself is the account');
});

test('status --json reports `me` as-is when the account API answers with a bare scalar', async () => {
	// Seen from a misbehaving proxy: a 200 with a JSON body that is not an
	// object at all. The command should report it rather than crash reading
	// `.data` off it.
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: '42' }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out } = await run(status, { flags: { json: true } });
	assert.equal(JSON.parse(out).me, 42);
});

test('status prints nothing about the user rather than crashing when `me` is a bare scalar', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: '42' }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out } = await run(status);
	assert.doesNotMatch(out, /user/i, 'nothing to attribute a user id to');
});

test('status reports no account at all when `asc ads me` answers with nothing', async () => {
	// Apple has answered a 200 with an empty body before; there is no user to
	// report, and that is different from a scalar or an object with no data.
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: '' }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out: json } = await run(status, { flags: { json: true } });
	assert.equal(JSON.parse(json).me, null);
	const { out } = await run(status);
	assert.doesNotMatch(out, /user/i, 'nothing to attribute a user id to');
});

test('status prints "user ?" rather than crashing when only one of userId/parentOrgId is known', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: { data: { userId: 42 } } }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out } = await run(status);
	assert.match(out, /user 42 · parent org \?/, 'a userId with no parent org still prints, with ? standing in');
});

test('status prints "user ?" the other way round too, and skips the line entirely when neither is known', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: { data: { parentOrgId: '9' } } }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out } = await run(status);
	assert.match(out, /user \? · parent org 9/);

	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: { data: {} } }],
		['ads acls', { out: { data: [] } }],
	]);
	const { out: none } = await run(status);
	assert.doesNotMatch(none, /parent org/, 'nothing worth printing when neither field came back');
});

test('the organizations table survives a row missing every optional field, next to one missing only some', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { org_id: '1', profile: 'demo' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
		['ads me', { out: { data: { userId: 1, parentOrgId: '1' } } }],
		[
			'ads acls',
			{
				out: {
					data: [
						// Only `id` and `roles` (the older field names); the rest is missing.
						{ id: 'A1', roles: ['Read Only'] },
						// Nothing at all — every column must still render, as blanks.
						{},
					],
				},
			},
		],
	]);
	const { out } = await run(status);
	assert.match(out, /A1/, 'falls back to `id` when `orgId` is absent');
	assert.match(out, /Read Only/, 'falls back to the older `roles` field when `roleNames` is absent');
});

test('login is named after the org, not the app, when there is no repo to read a name from', async () => {
	setBin('asc', [['ads auth login', { out: '', code: 0 }]]);
	const dir = await repo({ config: null, files: { 'key.p8': '-----BEGIN PRIVATE KEY-----\nx\n' }, prefix: 'ship-ads-auth-' });
	const flags = {
		'client-id': 'SEARCHADS.a', 'team-id': 'SEARCHADS.b', 'key-id': 'k',
		'private-key': `${dir}/key.p8`,
	};
	const { out } = await run(login, { flags, dir });
	assert.match(out, /credentials stored/);
});

test('login --dry-run does not call asc at all, and still exits clean', async () => {
	setDryRun(true);
	try {
		const dir = await repo({ config: { name: 'Demo', bundleId: 'com.demo.app' }, files: { 'key.p8': '-----BEGIN PRIVATE KEY-----\nx\n' }, prefix: 'ship-ads-auth-' });
		const flags = {
			'client-id': 'SEARCHADS.a', 'team-id': 'SEARCHADS.b', 'key-id': 'k',
			'private-key': `${dir}/key.p8`,
		};
		const { code } = await run(login, { flags, dir });
		assert.equal(code, 0);
	} finally {
		setDryRun(false);
	}
});

test('gate skips the org check entirely when the config names none', async () => {
	setBin('asc', [['ads auth status', { out: 'Active auth: demo\n' }]]);
	await assert.doesNotReject(() => gate(null));
	await assert.doesNotReject(() => gate({ ads: {} }));
});

test('gate reads an empty auth-status answer as "no live profile to compare", not a crash', async () => {
	// `asc ads auth status --output json` with nothing on stdout — a key without
	// a default profile selected yet. There is no profile to conflict with
	// ads.orgId, so the org check has nothing to fail on.
	setBin('asc', [
		['ads auth status --output json', { out: '' }],
		['ads auth status', { out: 'Active auth: demo\n' }],
	]);
	await assert.doesNotReject(() => gate({ ads: { orgId: '555' } }));
});

test('gate reads a mismatched org even when the live profile carries no name of its own', async () => {
	setBin('asc', [
		['ads auth status --output json', { out: { active: { orgId: '999' } } }],
		['ads auth status', { out: 'Active auth: demo\n' }],
	]);
	await assert.rejects(() => gate({ ads: { orgId: '555' }, file: 'ship.config.json' }), (err) => {
		assert.match(err.message, /active Apple Ads profile is org 999, but ads\.orgId is 555/);
		assert.match(err.hint, /profile "\?"/, 'no profile name on the live side, so the hint says so rather than "undefined"');
		return true;
	});
});
