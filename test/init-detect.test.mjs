// The detection helpers `ship init` builds its guess from, exercised directly
// rather than only through the command: several of these arms are edge shapes
// (a flat asc row, a stray file next to a version directory, a monorepo with
// thousands of source files) that are easier to construct precisely here than
// to thread through init's full flow.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fakeBins, fakeHome, repo, setBin, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { ascAppIdFor, ascAppRecord, detectLegal, findAppDir, findDynamicConfig, scanSources, sourceFiles } = await import(
	'../src/lib/init-detect.mjs'
);

const detectRepo = (files = {}) => repo({ config: null, files, prefix: 'ship-detect-' });

// ── findAppDir ────────────────────────────────────────────────────────────

test('findAppDir skips a plain file and a dotfile directory at the root, not just app dirs', async () => {
	const dir = await detectRepo({
		'README.md': 'hi',
		'.hidden/app.json': { expo: {} },
		'mobile/app.json': { expo: {} },
	});
	assert.equal(await findAppDir(dir), 'mobile', 'a file cannot be mistaken for a candidate, and dotdirs are never guessed at');
});

test('findAppDir credits a devDependency on expo, not only a direct one', async () => {
	const dir = await detectRepo({
		'alpha/app.json': { expo: {} },
		'alpha/package.json': { name: 'alpha', devDependencies: { expo: '^52.0.0' } },
		'beta/app.json': { expo: {} },
	});
	assert.equal(await findAppDir(dir), 'alpha', 'a devDependency still marks the real app, e.g. an expo module authored in-repo');
});

test('findAppDir falls back to the first candidate alphabetically when none depends on expo at all', async () => {
	const dir = await detectRepo({
		'beta/app.json': { expo: {} },
		'alpha/app.json': { expo: {} },
	});
	assert.equal(await findAppDir(dir), 'alpha', 'neither candidate names expo, so the tie is broken by name rather than guessed');
});

// ── findDynamicConfig ─────────────────────────────────────────────────────

test('a directory that shadows app.config.ts reads as empty text rather than crashing detection', async () => {
	// Not a real scenario an operator sets up on purpose, but a case-insensitive
	// checkout or a bad merge can leave a directory where a file used to be —
	// existsSync says yes, and the read has to fail safely, not throw.
	const dir = await detectRepo();
	await mkdir(join(dir, 'app.config.ts'));
	const cfg = await findDynamicConfig(dir);
	assert.equal(cfg?.text, '');
});

// ── sourceFiles ───────────────────────────────────────────────────────────

test('sourceFiles does not descend past 6 levels, so a vendored monorepo cannot make init scan forever', async () => {
	const dir = await detectRepo();
	await mkdir(join(dir, 'l1/l2/l3/l4/l5/l6/l7/l8'), { recursive: true });
	await writeFile(join(dir, 'l1/l2/l3/l4/l5/l6/l7/l8/deep.ts'), 'x');
	await writeFile(join(dir, 'shallow.ts'), 'x');
	const files = await sourceFiles(dir);
	assert.ok(files.some((f) => f.endsWith('shallow.ts')));
	assert.ok(!files.some((f) => f.endsWith('deep.ts')), 'a file 7 directories deep is out of bounds');
});

test('sourceFiles picks up a committed .env sample alongside real source', async () => {
	const dir = await detectRepo({ '.env.example': 'EXPO_PUBLIC_X=1', 'src/index.ts': 'x' });
	const files = await sourceFiles(dir);
	assert.ok(files.some((f) => f.endsWith('.env.example')));
});

test('sourceFiles stops at its file-count ceiling instead of hanging init on a huge tree', async () => {
	const dir = await detectRepo();
	const many = join(dir, 'many');
	await mkdir(many);
	await Promise.all(Array.from({ length: 3001 }, (_, i) => writeFile(join(many, `f${i}.ts`), '')));
	const files = await sourceFiles(dir);
	assert.equal(files.length, 3000);
});

// ── scanSources ───────────────────────────────────────────────────────────

test('scanSources skips a file that disappeared or cannot be read, without failing the scan', async () => {
	const hit = await scanSources([join('/definitely/not/a/real/path', 'gone.ts')]);
	assert.deepEqual(hit, { entitlement: { value: null, ambiguous: false }, keyEnv: { value: null, ambiguous: false } });
});

test('scanSources ignores a source file over its size ceiling, rather than scanning megabytes for a constant', async () => {
	const dir = await detectRepo();
	await writeFile(join(dir, 'big.ts'), `// ${'x'.repeat(256 * 1024 + 1)}`);
	const hit = await scanSources([join(dir, 'big.ts')]);
	assert.equal(hit.entitlement.value, null);
	assert.equal(hit.keyEnv.value, null);
});

test('scanSources refuses an entitlement match that is really just the property name itself', async () => {
	const dir = await detectRepo({
		'src/paywall.ts': "import { Purchases } from 'react-native-purchases';\nconst x = entitlements.active.entitlements;\n",
	});
	const hit = await scanSources([join(dir, 'src/paywall.ts')]);
	assert.equal(hit.entitlement.value, null, 'the literal "entitlements" is the accessor, never a real entitlement id');
});

test('two different entitlement identifiers across the repo are reported ambiguous, never guessed', async () => {
	const dir = await detectRepo({
		'src/a.ts': "import { Purchases } from 'react-native-purchases';\nconst ENTITLEMENT_ID = 'pro';\n",
		'src/b.ts': "import { Purchases } from 'react-native-purchases';\nconst ENTITLEMENT_ID = 'premium';\n",
	});
	const hit = await scanSources([join(dir, 'src/a.ts'), join(dir, 'src/b.ts')]);
	assert.equal(hit.entitlement.value, null);
	assert.equal(hit.entitlement.ambiguous, true);
	assert.deepEqual(new Set(hit.entitlement.all), new Set(['pro', 'premium']));
});

// ── detectLegal ───────────────────────────────────────────────────────────

test('a stray file next to the version subdirectories is skipped, not mistaken for a locale directory', async () => {
	const dir = await detectRepo({
		'store/version/README.md': 'not a directory',
		'store/version/1.0.0/en-US.json': { privacyPolicyUrl: 'https://demo.example/privacy' },
	});
	const { legal } = await detectLegal(dir, join(dir, 'store'), 'en-US');
	assert.equal(legal.privacyUrl, 'https://demo.example/privacy');
});

test('a legal listing file that parsed to something other than an object is skipped, not crashed on', async () => {
	const dir = await detectRepo({ 'store/app-info/en-US.json': ['oops'] });
	const { legal } = await detectLegal(dir, join(dir, 'store'), 'en-US');
	assert.equal(legal.privacyUrl, null);
});

test('legal URLs are also read out of a .strings localization, the form some repos keep instead of JSON', async () => {
	const dir = await detectRepo({
		'app-info-localizations/en-US.strings': '"privacyPolicyUrl" = "https://demo.example/privacy";\n"supportUrl" = "https://demo.example/support";\n',
	});
	const { legal, from } = await detectLegal(dir, join(dir, 'store'), 'en-US');
	assert.equal(legal.privacyUrl, 'https://demo.example/privacy');
	assert.equal(legal.supportUrl, 'https://demo.example/support');
	assert.equal(from.privacyUrl, 'app-info-localizations/en-US.strings');
});

// ── ascAppIdFor ───────────────────────────────────────────────────────────

test('ascAppIdFor matches a flat row with no JSON:API wrapper, and skips a row it cannot read at all', async () => {
	setBin('asc', [
		[
			'apps list',
			{
				out: [
					'not a row', // e.g. a malformed asc response — attrsOf must not throw on it
					{ bundleId: 'com.other', id: '1' },
					{ bundleId: 'com.demo.app', id: '42' },
				],
			},
		],
	]);
	assert.equal(await ascAppIdFor('com.demo.app'), '42');
});

test('ascAppIdFor falls back to an id nested in attributes, and to no id when neither place has one', async () => {
	setBin('asc', [['apps list', { out: [{ attributes: { bundleId: 'com.demo.app', id: '77' } }] }]]);
	assert.equal(await ascAppIdFor('com.demo.app'), '77', 'the row has no id of its own, only one inside attributes');

	setBin('asc', [['apps list', { out: [{ attributes: { bundleId: 'com.demo.app' } }] }]]);
	assert.equal(await ascAppIdFor('com.demo.app'), null, 'a matching row with no id anywhere is the same as no record');
});

// ── ascAppRecord ──────────────────────────────────────────────────────────

test('ascAppRecord reads a flat attributes payload with no "data" wrapper', async () => {
	setBin('asc', [['apps view', { out: { attributes: { name: 'Glovebox', bundleId: 'com.demo.app' } } }]]);
	const rec = await ascAppRecord('42');
	assert.equal(rec?.name, 'Glovebox');
});

test('ascAppRecord returns null, not a throw, when apps view fails outright', async () => {
	setBin('asc', [['apps view', { out: '', code: 1 }]]);
	assert.equal(await ascAppRecord('42'), null);
});
