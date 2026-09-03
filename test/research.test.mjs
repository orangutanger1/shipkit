// `ship research plan` end to end over a temp repo. The plan step is offline by
// design — it ranks the competitor set ASO already wrote — so this test needs
// no network and no credentials, which is the property that makes it a gate.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/commands/research.mjs';

const quiet = async (fn) => {
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = () => true;
	try {
		return await fn();
	} finally {
		process.stdout.write = write;
	}
};

/** A repo with a config and, unless told otherwise, a competitor set. */
async function repo({ config = {}, competitors = undefined, locale = 'en-US' } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-research-'));
	await writeFile(
		join(dir, 'ship.config.json'),
		JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', ...config }),
	);
	if (competitors !== undefined) {
		await mkdir(join(dir, 'aso', locale), { recursive: true });
		await writeFile(join(dir, 'aso', locale, 'competitors.json'), JSON.stringify({ apps: competitors }));
	}
	return dir;
}

const APPS = [
	{ id: 341232718, name: 'Huge', ratings: 1_000_000, stars: 4.4 },
	{ id: 284882215, name: 'Solid', ratings: 210_433, stars: 4.7 },
	{ id: 310633997, name: 'Small', ratings: 900, stars: 4.9 },
];

/** Run a subcommand with cwd inside a temp repo, restoring cwd afterwards. */
async function inRepo(dir, args, flags = {}) {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await quiet(() => run({ args, flags }));
	} finally {
		process.chdir(cwd);
	}
}

const readPlan = async (dir, slug) => JSON.parse(await readFile(join(dir, 'research', slug, 'plan.json'), 'utf8'));
const today = () => new Date().toISOString().slice(0, 10);

test('plan writes a schema-valid plan.json ranked out of the competitor set', async () => {
	const dir = await repo({ competitors: APPS });
	assert.equal(await inRepo(dir, ['plan']), 0);
	const plan = await readPlan(dir, today());
	assert.deepEqual(plan.apps.map((a) => a.name), ['Huge', 'Solid', 'Small']);
	assert.equal(plan.country, 'US');
	assert.equal(plan.provider, 'appstore');
	assert.equal(plan.budget.requests.total, 3 + 30 + 60);
});

test('plan is the default subcommand', async () => {
	const dir = await repo({ competitors: APPS });
	assert.equal(await inRepo(dir, []), 0);
	assert.ok(await readPlan(dir, today()));
});

test('--flows narrows the run and --apps narrows the budget', async () => {
	const dir = await repo({ competitors: APPS });
	await inRepo(dir, ['plan'], { flows: 'paywall,welcome', apps: '2' });
	const plan = await readPlan(dir, today());
	assert.deepEqual(plan.flows, ['paywall', 'welcome']);
	assert.equal(plan.apps.length, 2);
	assert.equal(plan.budget.requests.total, 2 + 20 + 40);
});

test('--name separates two runs made on one day', async () => {
	const dir = await repo({ competitors: APPS });
	await inRepo(dir, ['plan'], { name: 'Paywall Sweep' });
	assert.ok(await readPlan(dir, `${today()}-paywall-sweep`));
});

test('the configured flow list is used when no flag says otherwise', async () => {
	const dir = await repo({ competitors: APPS, config: { research: { flows: ['home', 'empty'] } } });
	await inRepo(dir, ['plan']);
	assert.deepEqual((await readPlan(dir, today())).flows, ['home', 'empty']);
});

test('the budget in the config is the ceiling the plan is costed against', async () => {
	const dir = await repo({ competitors: APPS, config: { research: { budget: { apps: 2, screensPerApp: 4, reviewPages: 1 } } } });
	await inRepo(dir, ['plan']);
	const plan = await readPlan(dir, today());
	assert.equal(plan.apps.length, 2);
	assert.deepEqual(plan.budget.requests, { lookup: 2, screenshots: 8, reviews: 4, total: 14 });
});

test('a missing competitor set names the command that writes one', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['plan']), (err) => {
		assert.match(err.message, /no competitor set for en-US/);
		assert.match(err.hint, /ship aso competitors --locale en-US/);
		return true;
	});
});

test('an empty competitor set is refused rather than planned', async () => {
	const dir = await repo({ competitors: [] });
	await assert.rejects(() => inRepo(dir, ['plan']), /no competitor apps to research/);
});

test('a locale with no storefront is refused before anything is written', async () => {
	const dir = await repo({ competitors: APPS });
	await assert.rejects(() => inRepo(dir, ['plan'], { locale: 'xx-YY' }), /no storefront for locale "xx-YY"/);
});

test('--locale reads that storefront’s competitor set and plans in its country', async () => {
	const dir = await repo({ competitors: APPS, locale: 'de-DE' });
	assert.equal(await inRepo(dir, ['plan'], { locale: 'de-DE' }), 0);
	assert.equal((await readPlan(dir, today())).country, 'DE');
});

test('--json prints the plan and still writes it', async () => {
	const dir = await repo({ competitors: APPS });
	const chunks = [];
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		await run({ args: ['plan'], flags: { json: true } });
	} finally {
		process.chdir(cwd);
		process.stdout.write = write;
	}
	assert.deepEqual(JSON.parse(chunks.join('')), await readPlan(dir, today()));
});

test('an unknown subcommand lists the ones that exist', async () => {
	const dir = await repo({ competitors: APPS });
	await assert.rejects(() => inRepo(dir, ['fetchh']), /unknown subcommand "fetchh"/);
});
