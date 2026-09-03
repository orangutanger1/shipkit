// `ship product brief` over a temp repo. Nothing here touches the storefront:
// the command reads a scout brief off disk, which is exactly what it does in
// anger.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/commands/product.mjs';
import { ARTIFACTS, clone, themes } from './fixtures/artifacts.mjs';

const quiet = async (fn) => {
	const saved = { out: process.stdout.write, err: process.stderr.write };
	let captured = '';
	process.stdout.write = (chunk) => {
		captured += chunk;
		return true;
	};
	process.stderr.write = () => true;
	try {
		return { code: await fn(), stdout: captured };
	} finally {
		process.stdout.write = saved.out;
		process.stderr.write = saved.err;
	}
};

const SCOUT = {
	term: 'car maintenance log',
	slug: 'car-maintenance-log',
	market: { country: 'US', lang: 'en-US' },
	viability: 41,
	incumbents: [{ name: 'AUTOsist', price: 9.99 }],
	verdict: { go: false, reasons: [{ gate: 'moat', message: 'the top three median 41,000 ratings' }] },
};

async function repo(files = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-product-'));
	await writeFile(join(dir, 'ship.config.json'), JSON.stringify({ name: 'Demo', bundleId: 'com.demo.app', version: '1.0.0' }));
	const all = { 'scout/us/car-maintenance-log-brief.json': SCOUT, ...files };
	for (const [rel, body] of Object.entries(all)) {
		if (body === null) continue;
		await mkdir(join(dir, rel, '..'), { recursive: true });
		await writeFile(join(dir, rel), JSON.stringify(body));
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

const readBrief = (dir) => readFile(join(dir, 'product', 'brief.json'), 'utf8').then(JSON.parse);

test('the first run drafts from the only scout brief and exits 1', async () => {
	const dir = await repo();
	// Exit 1 because the file it just wrote is deliberately not finished.
	assert.equal((await inRepo(dir, ['brief'])).code, 1);
	const doc = await readBrief(dir);
	assert.equal(doc.slug, 'car-maintenance-log');
	assert.equal(doc.verdict.viability, 41);
	assert.equal(doc.source, 'scout/us/car-maintenance-log-brief.json');
	assert.ok(doc._todo.length > 0);
});

test('--check refuses a draft by name before the schema does', async () => {
	const dir = await repo();
	await inRepo(dir, ['brief']);
	await assert.rejects(() => inRepo(dir, ['brief'], { check: true }), (err) => {
		assert.match(err.message, /is still a draft/);
		// "fill valueProp" beats "valueProp is required".
		assert.match(err.hint, /fill .*valueProp/);
		return true;
	});
});

test('a filled brief passes the gate and exits 0', async () => {
	const dir = await repo({ 'product/brief.json': ARTIFACTS['product-brief'] });
	assert.equal((await inRepo(dir, ['brief'], { check: true })).code, 0);
});

test('the gate reports every issue at once', async () => {
	const doc = clone(ARTIFACTS['product-brief']);
	doc.retention.flows = ['paywall'];
	doc.northStar.flow = 'error';
	const dir = await repo({ 'product/brief.json': doc });
	const { stdout } = await inRepo(dir, ['brief'], { check: true, json: true });
	const out = JSON.parse(stdout);
	assert.equal(out.ok, false);
	assert.equal(out.issues.length, 2);
});

test('a re-draft over a filled brief keeps the authored half', async () => {
	const dir = await repo({ 'product/brief.json': ARTIFACTS['product-brief'] });
	assert.equal((await inRepo(dir, ['brief'], { from: 'scout/us/car-maintenance-log-brief.json' })).code, 0);
	const doc = await readBrief(dir);
	assert.equal(doc.valueProp, ARTIFACTS['product-brief'].valueProp);
	// …and refreshes the computed half from the scout brief it was pointed at.
	assert.equal(doc.verdict.go, false);
});

test('research themes are offered as job seeds', async () => {
	const dir = await repo({
		'research/2026-09-02/plan.json': ARTIFACTS['research-plan'],
		'research/2026-09-02/themes.json': themes,
	});
	const { stdout } = await inRepo(dir, ['brief']);
	assert.match(stdout, /logging friction/);
});

test('--check on a missing brief says how to make one', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['brief'], { check: true }), (err) => {
		assert.match(err.hint, /ship product brief --from/);
		return true;
	});
});

test('an unknown subcommand lists the real ones', async () => {
	const dir = await repo();
	await assert.rejects(() => inRepo(dir, ['nope']), (err) => {
		assert.match(err.message, /product: unknown subcommand "nope"/);
		return true;
	});
});
