// `ship design` end to end over a temp repo. Every subcommand is offline: the
// drafts are derived, the gates are arithmetic, and `review` reads sources the
// test wrote — so this is a gate rather than a smoke test.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/commands/design.mjs';
import { ARTIFACTS, clone } from './fixtures/artifacts.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const quiet = async (fn) => {
	const out = process.stdout.write.bind(process.stdout);
	process.stdout.write = () => true;
	try {
		return await fn();
	} finally {
		process.stdout.write = out;
	}
};

async function repo({ config = {}, files = {} } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-design-'));
	await writeFile(join(dir, 'ship.config.json'), JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', ...config }));
	for (const [rel, body] of Object.entries(files)) {
		await mkdir(join(dir, rel, '..'), { recursive: true });
		await writeFile(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
	}
	return dir;
}

async function inRepo(dir, args, flags = {}) {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await quiet(() => run({ args, flags }));
	} finally {
		process.chdir(cwd);
	}
}

const readJSON = async (dir, rel) => JSON.parse(await readFile(join(dir, rel), 'utf8'));

test('system drafts when there is nothing, and redrafts only on --force', async () => {
	const dir = await repo();
	assert.equal(await inRepo(dir, ['system']), 0);
	const draft = await readJSON(dir, 'design/system.json');
	assert.deepEqual(draft._todo, ['color', 'brand.direction']);
	assert.equal(draft.brand.name, 'Demo', 'the app name is the one thing the draft knows');

	await assert.rejects(() => inRepo(dir, ['system']), /still a draft/, 'a second bare run gates rather than clobbers');
	assert.equal(await inRepo(dir, ['system'], { force: true }), 0);
});

test('system is the default subcommand', async () => {
	const dir = await repo();
	assert.equal(await inRepo(dir, []), 0);
	assert.ok(await readJSON(dir, 'design/system.json'));
});

test('--check refuses a draft, and passes the finished article', async () => {
	const dir = await repo();
	await inRepo(dir, ['system']);
	await assert.rejects(() => inRepo(dir, ['system'], { check: true }), /still a draft/);

	await writeFile(join(dir, 'design', 'system.json'), JSON.stringify(ARTIFACTS['design-system']));
	assert.equal(await inRepo(dir, ['system'], { check: true }), 0);
});

test('--check on a repo with no system names the command that drafts one', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['system'], { check: true }), (err) => {
		assert.match(err.hint, /ship design system/);
		return true;
	});
});

test('a token citing a reference no research run holds fails the gate', async () => {
	const system = clone(ARTIFACTS['design-system']);
	system.radii.card.cite = 'ref_abc123';
	const dir = await repo({
		files: {
			'design/system.json': system,
			'research/2026-09-02/plan.json': ARTIFACTS['research-plan'],
			'research/2026-09-02/references/ref_other.json': { ...ARTIFACTS['research-reference'], id: 'ref_other' },
		},
	});
	await assert.rejects(() => inRepo(dir, ['system'], { check: true }), /1 issue/);
});

test('the same citation passes once the run holds that reference', async () => {
	const system = clone(ARTIFACTS['design-system']);
	const reference = clone(ARTIFACTS['research-reference']);
	system.radii.card.cite = reference.id;
	const dir = await repo({
		files: {
			'design/system.json': system,
			'research/2026-09-02/plan.json': ARTIFACTS['research-plan'],
			[`research/2026-09-02/references/${reference.id}.json`]: reference,
		},
	});
	assert.equal(await inRepo(dir, ['system'], { check: true }), 0);
});

test('a research directory with no run leaves citations unprovable, not wrong', async () => {
	const dir = await repo({
		files: { 'design/system.json': ARTIFACTS['design-system'], 'research/notes.md': 'no run here' },
	});
	assert.equal(await inRepo(dir, ['system'], { check: true }), 0);
});

test('spec drafts over the configured flows and then gates what came back', async () => {
	const dir = await repo({ config: { research: { flows: ['welcome', 'paywall'] } } });
	assert.equal(await inRepo(dir, ['spec']), 0);
	const draft = await readJSON(dir, 'design/ux.json');
	assert.deepEqual(draft.screens.map((s) => s.id), ['welcome', 'paywall']);
	await assert.rejects(() => inRepo(dir, ['spec'], { check: true }), /still a draft/);

	await writeFile(join(dir, 'design', 'ux.json'), JSON.stringify(ARTIFACTS['ux-spec']));
	assert.equal(await inRepo(dir, ['spec'], { check: true }), 0);
});

test('spec --flows overrides the config, and --check with no file says so', async () => {
	const dir = await repo();
	await inRepo(dir, ['spec'], { flows: 'home' });
	assert.deepEqual((await readJSON(dir, 'design/ux.json')).screens.map((s) => s.route), ['/']);
	assert.equal(await inRepo(dir, ['spec'], { force: true, flows: 'home,empty' }), 0);

	const empty = await repo();
	await assert.rejects(() => inRepo(empty, ['spec'], { check: true }), /does not exist/);
});

test('a component the spec names but components.json does not is a gate failure', async () => {
	const dir = await repo({
		files: {
			'design/ux.json': ARTIFACTS['ux-spec'],
			'design/components.json': { components: { other: { primitive: 'Pressable' } } },
		},
	});
	await assert.rejects(() => inRepo(dir, ['spec'], { check: true }), /1 issue/);
});

test('review reads the app sources and reports drift against the system', async () => {
	const dir = await repo({
		files: {
			'design/system.json': ARTIFACTS['design-system'],
			'app/screens/Paywall.tsx': 'const s = { borderRadius: 14, color: "#ff00ff" };\n',
			'app/theme.ts': 'export const accent = "#0a58ca";\n',
			'app/notes.md': 'a #ff0000 that is not source\n',
			'app/node_modules/lib/index.js': 'const x = "#ff0000";\n',
		},
	});
	await assert.rejects(() => inRepo(dir, ['review']), (err) => {
		assert.match(err.message, /2 violation\(s\)/);
		return true;
	});
});

test('review passes an implementation that only uses the system', async () => {
	const dir = await repo({
		files: {
			'design/system.json': ARTIFACTS['design-system'],
			'app/screens/Paywall.tsx': 'const s = { borderRadius: 12, padding: 24, fontSize: 17 };\n',
		},
	});
	assert.equal(await inRepo(dir, ['review']), 0);
});

test('review --json prints the violations and exits non-zero', async () => {
	const dir = await repo({
		files: {
			'design/system.json': ARTIFACTS['design-system'],
			'app/App.tsx': 'const c = "#ff0000";\n',
		},
	});
	assert.equal(await inRepo(dir, ['review'], { json: true }), 1);
	assert.equal(await inRepo(await repo({ files: { 'design/system.json': ARTIFACTS['design-system'] } }), ['review'], { json: true }), 0);
});

test('review refuses to run against a system that is still a draft', async () => {
	const dir = await repo();
	await inRepo(dir, ['system']);
	await assert.rejects(() => inRepo(dir, ['review']), /still a draft/);
});

// --- `ship design build` --------------------------------------------------

const buildable = () => ({
	'design/system.json': DEFAULT_SYSTEM,
	'design/ux.json': {
		screens: [{
			id: 'home', route: '/', flow: 'home', purpose: 'Land.',
			copy: { title: 'Hello' }, states: ['default', 'empty'],
			events: [{ name: 'home_viewed', flow: 'home', verb: 'viewed' }],
			elements: [{ component: 'Text', variant: 'largeTitle', copy: 'title' }],
		}],
		flows: [{ id: 'home', screens: ['home'], success: 'The first screen renders.' }],
	},
});

test('build writes the tokens, the route, the events and the contract', async () => {
	const dir = await repo({ files: buildable() });
	assert.equal(await inRepo(dir, ['build']), 0);
	for (const rel of ['src/theme/tokens.ts', 'src/theme/qa-params.ts', 'src/analytics/events.ts', 'app/index.tsx', 'design/components.json'])
		assert.ok(existsSync(join(dir, rel)), `missing ${rel}`);
	const screen = await readFile(join(dir, 'app/index.tsx'), 'utf8');
	assert.match(screen, /export default function Home\(\)/);
	assert.match(screen, /kind="empty"/);
});

test('a second build is a no-op, not a refusal', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	assert.equal(await inRepo(dir, ['build']), 0);
});

test('a hand-edited file is refused by name, and every one at once', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	for (const rel of ['app/index.tsx', 'src/theme/tokens.ts']) {
		const text = await readFile(join(dir, rel), 'utf8');
		await writeFile(join(dir, rel), `${text}\n// mine\n`);
	}
	const err = await inRepo(dir, ['build']).then(() => null, (e) => e);
	assert.ok(err, 'expected a refusal');
	assert.match(err.message + err.hint, /app\/index\.tsx/);
	assert.match(err.message + err.hint, /tokens\.ts/);
});

test('--force takes an edited file back', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	await writeFile(join(dir, 'app/index.tsx'), 'export default function X() { return null; }\n');
	assert.equal(await inRepo(dir, ['build'], { force: true }), 0);
	assert.match(await readFile(join(dir, 'app/index.tsx'), 'utf8'), /@generated/);
});

test('--check writes nothing', async () => {
	const dir = await repo({ files: buildable() });
	assert.equal(await inRepo(dir, ['build'], { check: true }), 0);
	assert.ok(!existsSync(join(dir, 'app/index.tsx')));
});

test('a spec that violates the contract is refused before a byte is written', async () => {
	const files = buildable();
	files['design/ux.json'].screens[0].elements = [{ component: 'Carousel', copy: 'title' }];
	const dir = await repo({ files });
	const err = await inRepo(dir, ['build']).then(() => null, (e) => e);
	assert.ok(err);
	assert.match(err.message + err.hint, /Carousel/);
	assert.ok(!existsSync(join(dir, 'app/index.tsx')), 'nothing may be written on a failed validation');
});

test('the generated tree passes design review', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	assert.equal(await inRepo(dir, ['review']), 0);
});
