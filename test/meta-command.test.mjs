// `ship meta` end to end: the listing lifecycle. staged/<locale>.json is the
// only file a human edits, and everything under app-info/ and version/ is
// generated from it — so these tests assert on that split as much as on the
// asc calls, which go through a fake binary.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, repo, resetCalls, setBin, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/meta.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const CONFIG = { name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0', asc: { appId: '111', primaryLocale: 'en-US', platform: 'IOS' }, store: { locales: ['en-US'] } };
const LISTING = {
	locale: 'en-US', name: 'Glovebox', subtitle: 'Car maintenance log',
	keywords: 'oil change,service log,mileage,repair history,garage notes,fuel economy,car care',
	description: 'Glovebox keeps every service, repair and fill-up for your car in one place, so the next mechanic can see exactly what was done.',
	promotionalText: 'Now with reminders', whatsNew: 'Reminders for every service interval.',
	supportUrl: 'https://demo.example/support', privacyPolicyUrl: 'https://demo.example/privacy',
};

// asc has changed the plan's shape twice; what the counter keys off is a node
// carrying an `action`, wherever it sits.
const PLAN = { plan: { localizations: [{ action: 'create', locale: 'en-US' }, { action: 'update', locale: 'de-DE' }, { action: 'delete', locale: 'fr-FR' }] } };

function ascOk(extra = []) {
	setBin('asc', [
		...extra,
		['versions list', { out: { data: [{ id: 'v1', attributes: { versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION' } }] } }],
		['metadata apply .*--dry-run', { out: PLAN }],
		['metadata apply', { out: { applied: [{ locale: 'en-US', ok: true }] } }],
		['metadata pull', { out: { pulled: 1 } }],
	]);
}

/** @param {string[]} args @param {{flags?: object, dir: string}} opts */
async function meta(args, { flags = {}, dir }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => run({ args, flags })));
	return { code: result, out };
}

const metaRepo = (files = {}, config = {}) =>
	repo({ config: { ...CONFIG, ...config }, files: { 'store/staged/en-US.json': LISTING, ...files }, prefix: 'ship-meta-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

test('lint is the default subcommand, and passes a clean listing', async () => {
	ascOk();
	const dir = await metaRepo();
	const { code, out } = await meta([], { dir });
	assert.equal(code, 0);
	assert.match(out, /en-US/);
	assert.match(out, /no failures/);
});

test('lint reports warnings and failures separately, and --json emits them', async () => {
	ascOk();
	const warned = await metaRepo({ 'store/staged/en-US.json': { ...LISTING, keywords: 'oil change' } });
	const { code, out } = await meta(['lint'], { dir: warned });
	assert.equal(code, 0, 'a warning is not a failure');
	assert.match(out, /warning/);

	const failed = await metaRepo({ 'store/staged/en-US.json': { ...LISTING, name: 'x'.repeat(40) } });
	const { code: bad, out: badOut } = await meta(['lint'], { dir: failed });
	assert.equal(bad, 1);
	assert.match(badOut, /failure/);

	const { out: raw } = await meta(['lint'], { dir: failed, flags: { json: true } });
	assert.ok(JSON.parse(raw).locales[0].problems.length);
});

test('lint refuses a repo with no staged listings at all', async () => {
	ascOk();
	const dir = await repo({ config: CONFIG, prefix: 'ship-meta-' });
	await assert.rejects(() => meta(['lint'], { dir }), /no staged listings|nothing to lint/i);
});

test('stage expands the staged file into the tree asc consumes', async () => {
	ascOk();
	const dir = await metaRepo();
	const { code, out } = await meta(['stage'], { dir });
	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, 'store', 'app-info', 'en-US.json')));
	assert.ok(existsSync(join(dir, 'store', 'version', '1.2.0', 'en-US.json')));
	assert.match(out, /wrote 2 files for 1 locales/);
});

test('apply lints, stages, checks the version state and pushes twice', async () => {
	ascOk();
	const dir = await metaRepo();
	const { code, out } = await meta(['apply'], { dir });
	assert.equal(code, 0);
	assert.match(out, /\+1 add/);
	assert.match(out, /apply pass 1\/2/);
	assert.match(out, /apply pass 2\/2/);
	assert.match(out, /metadata applied to Demo 1.2.0/);
	assert.equal((await calls()).filter((call) => call.args.includes('apply') && !call.args.includes('--dry-run')).length, 2);
});

test('apply stops before the push under --dry-run', async () => {
	ascOk();
	const dir = await metaRepo();
	setDryRun(true);
	try {
		const { code, out } = await meta(['apply'], { dir });
		assert.equal(code, 0);
		assert.match(out, /stopping before the real apply/);
	} finally {
		setDryRun(false);
	}
});

test('apply refuses a version App Store Connect will not take metadata for', async () => {
	ascOk([['versions list', { out: { data: [{ attributes: { versionString: '1.2.0', appStoreState: 'IN_REVIEW' } }] } }]]);
	const dir = await metaRepo();
	await assert.rejects(() => meta(['apply'], { dir }), /is IN_REVIEW — metadata is locked/);

	const { code, out } = await meta(['apply'], { dir, flags: { force: true } });
	assert.equal(code, 0, '--force is the operator saying they know');
	assert.match(out, /applying anyway against IN_REVIEW/);
});

test('apply refuses a version that does not exist, unless forced', async () => {
	ascOk([['versions list', { out: { data: [] } }]]);
	const dir = await metaRepo();
	await assert.rejects(() => meta(['apply'], { dir }), /no IOS version 1.2.0 in App Store Connect/);
	const { out } = await meta(['apply'], { dir, flags: { force: true } });
	assert.match(out, /could not read app store state/);
});

test('a lint failure stops apply before anything is pushed', async () => {
	ascOk();
	const dir = await metaRepo({ 'store/staged/en-US.json': { ...LISTING, name: 'x'.repeat(40) } });
	await assert.rejects(() => meta(['apply'], { dir }), /lint failure/);
	const { out } = await meta(['apply'], { dir, flags: { force: true } });
	assert.match(out, /--force: continuing past 1 lint failure/);
});

test('apply reports the localizations asc said it could not write', async () => {
	ascOk([['metadata apply --app', { out: { results: [{ locale: 'de-DE', ok: false, error: 'too long' }] } }]]);
	const dir = await metaRepo();
	await assert.rejects(() => meta(['apply'], { dir }), /failed to apply|exited/);
});

test('apply says so when asc reports nothing to change', async () => {
	ascOk([['metadata apply .*--dry-run', { out: { changes: [] } }]]);
	const dir = await metaRepo();
	const { out } = await meta(['apply'], { dir });
	assert.match(out, /asc reported no changes/);
});

test('--no-stage pushes the tree exactly as it is on disk', async () => {
	ascOk();
	const dir = await metaRepo();
	const { out } = await meta(['apply'], { dir, flags: { 'no-stage': true } });
	assert.match(out, /pushing store\/app-info \+ store\/version as they are/);
});

test('pull folds the canonical tree back into one authored file per locale', async () => {
	ascOk();
	const dir = await metaRepo({
		'store/app-info/en-US.json': { name: 'Glovebox', subtitle: 'From Apple' },
		'store/version/1.2.0/en-US.json': { description: 'Live description', keywords: 'live,keywords' },
		'store/staged/en-US.json': { ...LISTING, notes: 'why these keywords' },
	});
	const { code, out } = await meta(['pull'], { dir });
	assert.equal(code, 0);
	const folded = await readJson(dir, 'store/staged/en-US.json');
	assert.equal(folded.subtitle, 'From Apple');
	assert.equal(folded.notes, 'why these keywords', 'research prose only ever lived locally — a pull must not eat it');
	assert.match(out, /folded 1 locales/);
	assert.match(out, /review the diff/);
});

test('pull refuses when asc pulled nothing, and says so under --dry-run', async () => {
	ascOk();
	const dir = await metaRepo();
	await assert.rejects(() => meta(['pull'], { dir }), /pulled no localizations/);
	setDryRun(true);
	try {
		const { code, out } = await meta(['pull'], { dir });
		assert.equal(code, 0);
		assert.match(out, /nothing pulled/);
	} finally {
		setDryRun(false);
	}
});

test('a pull asc refused is reported with its own last lines', async () => {
	ascOk([['metadata pull', { out: '', err: 'not authorised', code: 1 }]]);
	const dir = await metaRepo();
	await assert.rejects(() => meta(['pull'], { dir }), /asc metadata pull exited 1/);
});

test('migrate converts legacy .strings into staged files, and keeps what is already authored', async () => {
	ascOk();
	const dir = await metaRepo({
		'localizations/de-DE.strings': '"name" = "Glovebox";\n"subtitle" = "Wartungsheft";\n',
		'app-info-localizations/de-DE.strings': '"promotional_text" = "Neu";\n',
	});
	const { code, out } = await meta(['migrate'], { dir });
	assert.equal(code, 0);
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.equal(de.subtitle, 'Wartungsheft');
	assert.equal(de.promotionalText, 'Neu');
	assert.match(out, /created/);

	const { out: again } = await meta(['migrate'], { dir });
	assert.match(again, /skipped|already/i, 'an authored file is not overwritten without --force');

	const { out: forced } = await meta(['migrate'], { dir, flags: { force: true } });
	assert.match(forced, /overwrote/);
});

test('migrate needs something to convert', async () => {
	ascOk();
	const dir = await metaRepo();
	await assert.rejects(() => meta(['migrate'], { dir }), /nothing to convert/);
});

test('keywords accounts for every term, and names the ones the title already indexes', async () => {
	ascOk();
	const dir = await metaRepo({ 'store/staged/en-US.json': { ...LISTING, keywords: 'glovebox,oil change' } });
	const { code, out } = await meta(['keywords'], { dir });
	assert.equal(code, 0);
	assert.match(out, /already in name\/subtitle/);

	const { out: raw } = await meta(['keywords', 'en-US'], { dir, flags: { json: true } });
	const doc = JSON.parse(raw);
	assert.equal(doc.terms[0].term, 'glovebox');
	assert.equal(doc.terms[0].wasted, true);
});

test('keywords --set rewrites the field, and refuses one that will not fit', async () => {
	ascOk();
	const dir = await metaRepo();
	const { code } = await meta(['keywords'], { dir, flags: { set: 'brake pads,winter tyres' } });
	assert.equal(code, 0);
	assert.equal((await readJson(dir, 'store/staged/en-US.json')).keywords, 'brake pads,winter tyres');

	await assert.rejects(() => meta(['keywords'], { dir, flags: { set: 'x'.repeat(120) } }), /100/);
});

test('keywords names the locales it does have', async () => {
	ascOk();
	const dir = await metaRepo();
	await assert.rejects(() => meta(['keywords', 'fr-FR'], { dir }), /no staged listing for fr-FR/);
});

test('an unknown subcommand names the ones that exist', async () => {
	ascOk();
	const dir = await metaRepo();
	await assert.rejects(() => meta(['sniff'], { dir }), /unknown subcommand "sniff"|try:/);
});
