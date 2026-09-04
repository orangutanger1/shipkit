// `ship price` end to end: the offline plan, the live read, applying prices to
// a subscription or to the app itself, and the ladder audit. Everything live
// goes through `asc`, including the `--help` probe the command uses to check
// the installed asc is new enough — so the fake binary answers that too.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, json, repo, resetCalls, setBin, withFetch } from './fixtures/cmd.mjs';

await fakeHome();
process.env.REVENUECAT_V2_KEY = 'test-key';
await fakeBins(['asc']);

const { run } = await import('../src/commands/price.mjs');
const { setDryRun } = await import('../src/exec.mjs');

const CONFIG = { asc: { appId: '111', primaryLocale: 'en-US' }, price: { basePriceUsd: 4.99 } };

/** asc's own help output, which is how the command decides asc is new enough. */
const HELP = ['^pricing --help', { out: '  current:  read prices\n  schedule:  price schedules\n' }];
const HELP_SCHEDULE = ['^pricing schedule --help', { out: '  create:  create a schedule\n  view:  view the schedule\n' }];
const HELP_SUBS = ['^subscriptions pricing --help', { out: '  prices:  per-territory prices\n' }];

const priceRow = (territory, price, currency) => ({ id: `${territory}-p`, attributes: { customerPrice: price, currency, territory: { id: territory } } });

/** @param {{app?: object, subs?: object, subPrices?: object, extra?: any[]}} [opts] */
function ascOk({ app = { data: [priceRow('US', 4.99, 'USD'), priceRow('DE', 5.99, 'EUR')] }, subs = { data: [{ id: 'sub1', attributes: { productId: 'com.demo.monthly', name: 'Monthly', subscriptionPeriod: 'ONE_MONTH' } }] }, subPrices = { data: [priceRow('US', 4.99, 'USD')] }, extra = [] } = {}) {
	setBin('asc', [
		...extra,
		HELP, HELP_SCHEDULE, HELP_SUBS,
		['auth status', { out: { credentials: [{ name: 'Team' }] } }],
		['pricing current', { out: app }],
		['pricing schedule view', { out: { data: [{ id: 'sched-1', attributes: { startDate: '2026-09-01' } }] } }],
		['pricing schedule create', { out: { data: { id: 'sched-2' } } }],
		['subscriptions list', { out: subs }],
		['subscriptions pricing prices list', { out: subPrices }],
		['subscriptions pricing prices set', { out: { data: { id: 'p' } } }],
	]);
}

/** @param {string[]} args @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function price(args, { flags = {}, dir, fetch = async () => json({ items: [] }) }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const priceRepo = (files = {}, config = {}) => repo({ config: { ...CONFIG, ...config }, files, prefix: 'ship-price-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

test('plan derives a territory table offline and writes both artifacts', async () => {
	const dir = await priceRepo();
	const { code, out } = await price(['plan'], { dir });
	assert.equal(code, 0);
	const doc = await readJson(dir, 'store/pricing/plan.json');
	assert.equal(doc.baseUsd, 4.99);
	assert.ok(doc.rows.length > 10, 'every storefront gets a row');
	assert.match(await readFile(join(dir, 'store/pricing/plan.md'), 'utf8'), /Territory pricing/);
	assert.match(out, /Price plan/);
	assert.match(out, /ship price apply --dry-run/);
});

test('plan needs a usable base price', async () => {
	const dir = await repo({ config: { asc: { appId: '111' } }, prefix: 'ship-price-' });
	await assert.rejects(() => price(['plan'], { dir }), /base price must be a positive number/);
	await assert.rejects(() => price(['plan'], { dir, flags: { base: 'free' } }), /no base price to derive from/);
});

test('plan narrows to the territories asked for, and --json emits the doc', async () => {
	const dir = await priceRepo();
	const { out } = await price(['plan'], { dir, flags: { base: 9.99, territories: 'US,DE,JP', floor: 2, json: true } });
	const doc = JSON.parse(out);
	assert.deepEqual(doc.rows.map((r) => r.territory).sort(), ['DE', 'JP', 'US']);
	assert.equal(doc.baseUsd, 9.99);
});

test('show reads the live prices and diffs them against the plan', async () => {
	ascOk();
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	const { code, out } = await price(['show'], { dir });
	assert.equal(code, 0);
	assert.match(out, /subscription com.demo.monthly/);
	assert.match(out, /price schedule sched-1/);
	assert.match(out, /plan vs live/);
});

test('show --app-price reads the app prices instead, and --json carries both', async () => {
	ascOk();
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir, flags: { 'app-price': true, json: true } });
	const doc = JSON.parse(out);
	assert.equal(doc.target, 'app');
	assert.equal(doc.appPrices.length, 2);
	assert.equal(doc.plan, null, 'no plan on disk is reported as none, not as a match');
});

test('show says so when there is no schedule and no readable price', async () => {
	ascOk({ app: { data: [] }, subPrices: { data: [] } });
	setBin('asc', [HELP, HELP_SCHEDULE, HELP_SUBS, ['auth status', { out: { credentials: [] } }], ['subscriptions list', { out: { data: [] } }]]);
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /no app price schedule/);
	assert.match(out, /no live prices readable/);
	assert.match(out, /run `ship price plan`/);
});

test('show names the subscription to pick when the app has several', async () => {
	ascOk({ subs: { data: [{ id: 'a', attributes: { productId: 'com.a' } }, { id: 'b', attributes: { productId: 'com.b' } }] } });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /2 subscriptions; --subscription/);
});

test('apply pushes the planned prices to the subscription', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	const { code, out } = await price(['apply'], { dir, flags: { 'max-delta': 100, 'start-date': '2026-10-01' } });
	assert.equal(code, 0);
	assert.match(out, /applied/);
	const set = (await calls()).filter((call) => call.args.includes('set'));
	assert.ok(set.length, 'a price was pushed');
	assert.ok(set[0].args.includes('2026-10-01'), '--start-date rides along');
});

test('apply refuses a move larger than --max-delta unless forced', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 0.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(() => price(['apply'], { dir, flags: { 'max-delta': 10 } }), /exceed --max-delta/);
	const { code } = await price(['apply'], { dir, flags: { 'max-delta': 10, force: true } });
	assert.equal(code, 0);
});

test('apply is a no-op when the store already matches the plan', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 4.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { code, out } = await price(['apply'], { dir });
	assert.equal(code, 0);
	assert.match(out, /already live; nothing to do/);
});

test('apply --dry-run pushes nothing', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	setDryRun(true);
	try {
		const { out } = await price(['apply'], { dir, flags: { 'max-delta': 100 } });
		assert.match(out, /skipped by --dry-run/);
	} finally {
		setDryRun(false);
	}
});

test('apply needs a plan, and a subscription it can name', async () => {
	ascOk({ subs: { data: [] } });
	const dir = await priceRepo();
	await assert.rejects(() => price(['apply'], { dir }), /no price plan at/);
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(() => price(['apply'], { dir }), /this app has no subscriptions/);

	ascOk({ subs: { data: [{ id: 'a', attributes: { productId: 'com.a' } }, { id: 'b', attributes: { productId: 'com.b' } }] } });
	await assert.rejects(() => price(['apply'], { dir }), /name the one to price/);
});

test('apply --app-price creates one schedule and says the rest was left to Apple', async () => {
	ascOk({ app: { data: [priceRow('US', 2.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	const { code, out } = await price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 100 } });
	assert.equal(code, 0);
	assert.match(out, /app price schedule created/);
	assert.match(out, /were NOT applied/);
	const { out: raw } = await price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 100, json: true } });
	assert.deepEqual(JSON.parse(raw).equalizedByApple, ['DE']);
});

test('apply --app-price refuses an over-delta move and a base territory the plan lacks', async () => {
	ascOk({ app: { data: [priceRow('US', 0.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(() => price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 10 } }), /over --max-delta/);
	await assert.rejects(() => price(['apply'], { dir, flags: { 'app-price': true, 'base-territory': 'JP' } }), /no row for base territory JP/);
});

test('apply --app-price is quiet when the price is already right', async () => {
	ascOk({ app: { data: [priceRow('US', 4.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['apply'], { dir, flags: { 'app-price': true } });
	assert.match(out, /already/);
});

test('audit judges the shape of the ladder, and skips what it cannot read', async () => {
	ascOk();
	const dir = await priceRepo();
	const { code, out } = await price(['audit'], { dir });
	assert.ok(code === 0 || code === 1);
	assert.match(out, /Price ladder/);
	assert.match(out, /offerings/);
});

test('audit without credentials skips the ladder rather than inventing one', async () => {
	setBin('asc', [['auth status', { out: { credentials: [] } }]]);
	const dir = await priceRepo();
	const { out } = await price(['audit'], { dir, flags: { json: true } });
	const rows = JSON.parse(out).rows;
	assert.ok(rows.some((r) => r.level === 'skip'));
});

test('audit needs a repo', async () => {
	const dir = await repo({ config: null, prefix: 'ship-price-' });
	await assert.rejects(() => price(['audit'], { dir }), /no ship.config.json in this repo/);
});
