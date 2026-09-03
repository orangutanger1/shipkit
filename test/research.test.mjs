// `ship research plan` end to end over a temp repo. The plan step is offline by
// design — it ranks the competitor set ASO already wrote — so this test needs
// no network and no credentials, which is the property that makes it a gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gateFor } from '../src/lib/appstore-client.mjs';
import { run } from '../src/commands/research.mjs';

// The client spaces requests a second apart per storefront, which is the right
// thing against Apple and the wrong thing in a suite that serves every byte
// from memory. Pinning the gate's clock to zero disables only the waiting.
Object.defineProperty(gateFor('US'), 'last', { get: () => 0, set: () => {} });

const quiet = async (fn) => {
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	process.stdout.write = () => true;
	process.stderr.write = () => true;
	try {
		return await fn();
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
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

/* ------------------------------------------------ fetch · capture · gates -- */

/** A PNG whose IHDR says what we want it to say. */
function png(width, height) {
	const buf = Buffer.alloc(33);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0x0d0a1a0a, 4);
	buf.writeUInt32BE(13, 8);
	buf.write('IHDR', 12);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

const reviewEntry = (id, rating) => ({
	id: { label: id },
	'im:rating': { label: String(rating) },
	'im:version': { label: '3.1.0' },
	updated: { label: '2026-08-01T12:00:00-07:00' },
	title: { label: `t ${id}` },
	content: { label: `b ${id}` },
});

/**
 * The storefront, as `fetch` itself sees it. Installed over globalThis.fetch so
 * the command's own HTTP layer — throttle, retry and all — is what runs.
 */
function stubStorefront() {
	const real = globalThis.fetch;
	const urls = [];
	globalThis.fetch = async (url) => {
		urls.push(String(url));
		const body = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
		if (String(url).includes('/lookup')) {
			return body({
				results: [{
					trackName: 'Huge',
					trackId: 341232718,
					averageUserRating: 4.4,
					userRatingCount: 1_000_000,
					screenshotUrls: ['https://is1.mzstatic.com/image/thumb/a/320x480bb.jpg'],
				}],
			});
		}
		if (String(url).includes('customerreviews')) {
			return String(url).includes('page=1')
				? body({ feed: { entry: [reviewEntry('rev-1', 5), reviewEntry('rev-2', 2)] } })
				: body({ feed: {} });
		}
		const bytes = png(1290, 2796);
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
	};
	return { urls, restore: () => { globalThis.fetch = real; } };
}

const TINY = { research: { budget: { apps: 1, screensPerApp: 1, reviewPages: 1 } } };
const runDir = (dir, slug = today()) => join(dir, 'research', slug);
const readRunJSON = async (dir, ...parts) => JSON.parse(await readFile(join(runDir(dir), ...parts), 'utf8'));

/** A run with one fetched app in it, which is what every gate test starts from. */
async function fetched() {
	const dir = await repo({ competitors: APPS, config: TINY });
	await inRepo(dir, ['plan']);
	const stub = stubStorefront();
	try {
		assert.equal(await inRepo(dir, ['fetch']), 0);
	} finally {
		stub.restore();
	}
	const [file] = await readdir(join(runDir(dir), 'references'));
	return { dir, stub, refFile: join(runDir(dir), 'references', file) };
}

/** Fill in the agent's half of a reference, which is what `verify` is asking for. */
async function fillReference(file, over = {}) {
	const ref = JSON.parse(await readFile(file, 'utf8'));
	delete ref._todo;
	Object.assign(ref, {
		flow: 'paywall',
		doNotCopy: 'the wordmark and the illustration style',
		observations: { summary: 'price ladder above the fold' },
		...over,
	});
	await writeFile(file, JSON.stringify(ref));
	return ref;
}

test('fetch writes a reference, its asset and the review corpus, all schema-shaped', async () => {
	const { dir, refFile } = await fetched();
	const ref = JSON.parse(await readFile(refFile, 'utf8'));
	assert.equal(ref.provider, 'appstore');
	assert.equal(ref.providerId, '341232718#screen-1');
	assert.equal(ref.position, 1);
	assert.deepEqual(ref._todo, ['flow', 'observations', 'doNotCopy']);
	assert.equal(ref.image.w, 1290);
	assert.equal(ref.app.ratingCount, 1_000_000);

	const asset = await readFile(join(runDir(dir), ref.image.path));
	assert.equal(createHash('sha256').update(asset).digest('hex'), ref.image.sha256);

	const corpus = await readRunJSON(dir, 'reviews', '341232718.json');
	assert.equal(corpus.count, 2);
	assert.equal(corpus.appMeanRating, 4.4);
	assert.deepEqual(corpus.sorts, ['mostrecent', 'mosthelpful']);
});

test('fetch asks for the full-resolution image, not the thumbnail it was handed', async () => {
	const dir = await repo({ competitors: APPS, config: TINY });
	await inRepo(dir, ['plan']);
	const stub = stubStorefront();
	try {
		await inRepo(dir, ['fetch']);
	} finally {
		stub.restore();
	}
	assert.ok(stub.urls.some((u) => u.endsWith('/1290x0w.png')));
	assert.equal(stub.urls.filter((u) => u.includes('320x480bb')).length, 0);
});

test('fetch holds an app it already has unless --refresh says otherwise', async () => {
	const { dir } = await fetched();
	const stub = stubStorefront();
	try {
		await inRepo(dir, ['fetch']);
		assert.deepEqual(stub.urls, []);
		await inRepo(dir, ['fetch'], { refresh: true });
		assert.ok(stub.urls.length > 0);
	} finally {
		stub.restore();
	}
});

test('verify refuses a run whose references are still fetch drafts', async () => {
	const { dir } = await fetched();
	await assert.rejects(() => inRepo(dir, ['verify']), (err) => {
		assert.match(err.message, /research verify: \d+ issue\(s\)/);
		assert.match(err.hint, /non-empty doNotCopy/);
		return true;
	});
});

test('verify passes once the agent has filled every reference', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	assert.equal(await inRepo(dir, ['verify']), 0);
});

test('verify catches an asset edited out from under its reference', async () => {
	const { dir, refFile } = await fetched();
	const ref = await fillReference(refFile);
	await writeFile(join(runDir(dir), ref.image.path), png(640, 1136));
	await assert.rejects(() => inRepo(dir, ['verify']), /issue\(s\)/);
});

test('verify fails an evidence claim that cites fewer than three references', async () => {
	const { dir, refFile } = await fetched();
	const ref = await fillReference(refFile);
	await writeFile(
		join(runDir(dir), 'patterns.json'),
		JSON.stringify({ claims: [{ claim: 'paywalls lead with the annual price', kind: 'evidence', refs: [ref.id], counterexamples: [] }] }),
	);
	await assert.rejects(() => inRepo(dir, ['verify']), /issue\(s\)/);
});

test('verify fails a theme whose ratingSkew the corpus does not support', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	await writeFile(
		join(runDir(dir), 'themes.json'),
		JSON.stringify({ themes: [{ label: 'sync breaks', kind: 'pain', trackId: 341232718, support: 1, reviewIds: ['rev-2'], ratingSkew: 4 }] }),
	);
	await assert.rejects(() => inRepo(dir, ['verify']), /issue\(s\)/);
});

test('verify refuses a run that was never fetched', async () => {
	const dir = await repo({ competitors: APPS, config: TINY });
	await inRepo(dir, ['plan']);
	await assert.rejects(() => inRepo(dir, ['verify']), /issue\(s\)/);
});

test('capture ingests device screenshots as manual references', async () => {
	const { dir } = await fetched();
	const shots = join(dir, 'device');
	await mkdir(shots, { recursive: true });
	await writeFile(join(shots, '01-welcome.png'), png(1179, 2556));
	await writeFile(join(shots, 'notes.txt'), 'ignored');
	assert.equal(await inRepo(dir, ['capture', shots], { app: 'Rival' }), 0);

	const files = await readdir(join(runDir(dir), 'references'));
	assert.equal(files.length, 2);
	const refs = await Promise.all(files.map((f) => readRunJSON(dir, 'references', f)));
	const manual = refs.find((r) => r.provider === 'manual');
	assert.equal(manual.app.name, 'Rival');
	assert.equal(manual.position, null);
	assert.equal(manual.providerId, 'Rival#01-welcome.png');
	assert.equal(manual.image.w, 1179);
});

test('capture says which directory it wanted when there is nothing to ingest', async () => {
	const { dir } = await fetched();
	await assert.rejects(() => inRepo(dir, ['capture']), /no directory/);
	await assert.rejects(() => inRepo(dir, ['capture', join(dir, 'nope')]), /does not exist/);
	await mkdir(join(dir, 'empty'), { recursive: true });
	await assert.rejects(() => inRepo(dir, ['capture', join(dir, 'empty')]), /no png or jpg files/);
});

test('index ranks the run and reports the flows it has nothing for', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	assert.equal(await inRepo(dir, ['index']), 0);
	const index = await readRunJSON(dir, 'index.json');
	assert.equal(index.apps[0].trackId, 341232718);
	assert.equal(index.apps[0].ratingVelocity, null);
	assert.equal(index.references[0].rank, 1);
	assert.equal(index.coverage.paywall.references, 1);
	assert.equal(index.coverage.welcome.references, 0);
	assert.equal(index.reviews.total, 2);
});

test('index joins review velocity off the previous run’s own numbers', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	await mkdir(join(dir, 'research', '2026-01-01'), { recursive: true });
	await writeFile(join(dir, 'research', '2026-01-01', 'plan.json'), JSON.stringify({ slug: '2026-01-01' }));
	const tenDaysBack = new Date(Date.now() - 10 * 86_400_000).toISOString();
	await writeFile(
		join(dir, 'research', '2026-01-01', 'index.json'),
		JSON.stringify({ generatedAt: tenDaysBack, apps: [{ trackId: 341232718, ratingCount: 999_000 }] }),
	);
	await inRepo(dir, ['index']);
	assert.equal((await readRunJSON(dir, 'index.json')).apps[0].ratingVelocity, 100);
});

test('--slug picks a run, and an unknown one names the file it looked for', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	assert.equal(await inRepo(dir, ['index'], { slug: today() }), 0);
	await assert.rejects(() => inRepo(dir, ['index'], { slug: '1999-01-01' }), /no run "1999-01-01"/);
});

test('a command that needs a run says to plan one first', async () => {
	const dir = await repo({ competitors: APPS });
	await assert.rejects(() => inRepo(dir, ['fetch']), /no run to read/);
});

test('fetch treats a malformed storefront response as an absent one', async () => {
	const dir = await repo({ competitors: APPS, config: TINY });
	await inRepo(dir, ['plan']);
	const real = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not json at all' });
	try {
		assert.equal(await inRepo(dir, ['fetch']), 0);
	} finally {
		globalThis.fetch = real;
	}
	assert.equal(existsSync(join(runDir(dir), 'references')), false);
});

test('capture skips a file that is named like an image but is not one', async () => {
	const { dir } = await fetched();
	const shots = join(dir, 'device');
	await mkdir(shots, { recursive: true });
	await writeFile(join(shots, 'broken.png'), 'not really a png');
	assert.equal(await inRepo(dir, ['capture', shots]), 0);
	assert.equal((await readdir(join(runDir(dir), 'references'))).length, 1);
});

test('index --json prints the index and still writes it', async () => {
	const { dir, refFile } = await fetched();
	await fillReference(refFile);
	const chunks = [];
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		await run({ args: ['index'], flags: { json: true } });
	} finally {
		process.chdir(cwd);
		process.stdout.write = write;
	}
	assert.deepEqual(JSON.parse(chunks.join('')), await readRunJSON(dir, 'index.json'));
});
