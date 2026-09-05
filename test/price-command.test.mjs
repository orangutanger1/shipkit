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

// ─── the plan when the numbers do not clear the floor ────────────────────────

test('a plan whose territories cannot repay an install says so in both artifacts', async () => {
	// A floor no storefront clears is the shape of the real complaint: the base
	// price is too low to fund paid acquisition anywhere, and the operator needs
	// to see which storefronts that is before spending on them.
	const dir = await priceRepo();
	const { code, out } = await price(['plan'], { dir, flags: { territories: 'US,DE,JP', floor: 50 } });
	assert.equal(code, 0);
	assert.match(out, /below floor/, 'the table marks every flagged row');
	assert.match(out, /3 territories net under \$50\.00\/month/);
	const md = await readFile(join(dir, 'store/pricing/plan.md'), 'utf8');
	assert.match(md, /## Below the sustaining floor/);
	assert.match(md, /\*\*⚠ below floor\*\*/);
});

test('the ads target sets the floor when no --floor is given', async () => {
	// A subscription that nets less than a third of an install's price can never
	// repay one, so ads.targetCpi — not the constant — is the floor to beat.
	const dir = await priceRepo({}, { ads: { targetCpi: 6 } });
	const { out } = await price(['plan'], { dir, flags: { territories: 'US', json: true } });
	assert.equal(JSON.parse(out).floorUsd, 2);
});

// ─── reading prices out of whatever shape asc answered with ─────────────────

/** One live price row per shape asc has been seen to emit for the same reading. */
const SHAPES = {
	data: [
		// The raw JSON:API shape, with the territory as a bare alpha-3 reference.
		{ attributes: { customerPrice: '4.99', currency: 'USD' }, territory: 'USA' },
		// Flattened, with the price beside the envelope and the territory nested.
		{ customerPrice: '5.99', attributes: { territory: { id: 'DEU' }, currencyCode: 'EUR' } },
		// `price`/`territoryCode`, as the older flattened output named them.
		{ attributes: { price: '5.99' }, territoryCode: 'FRA', currency: 'EUR' },
		{ price: '740', attributes: { territoryCode: 'JPN' }, currencyCode: 'JPY' },
		// A relationship link and no currency anywhere.
		{ attributes: { customerPrice: '4.49' }, relationships: { territory: { data: { id: 'GBR' } } } },
		// Unreadable: a price that is not a number is dropped, never guessed.
		{ attributes: { customerPrice: 'free', territory: { id: 'ITA' } } },
		// A price with no territory anywhere on it is not a price for anywhere.
		{ attributes: { customerPrice: '9.99' } },
	],
};

test('a live price is read out of every shape asc emits, and an unreadable one is dropped', async () => {
	// asc has changed the shape of this payload across versions, and a price it
	// reads as NaN must never become a price `apply` overwrites unguarded.
	ascOk({ app: SHAPES });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir, flags: { 'app-price': true, json: true } });
	const byTerritory = Object.fromEntries(JSON.parse(out).appPrices.map((r) => [r.territory, r]));
	assert.deepEqual(Object.keys(byTerritory).sort(), ['DE', 'FR', 'GB', 'JP', 'US']);
	assert.equal(byTerritory.DE.price, 5.99);
	assert.equal(byTerritory.DE.currency, 'EUR');
	assert.equal(byTerritory.FR.currency, 'EUR');
	assert.equal(byTerritory.JP.price, 740);
	assert.equal(byTerritory.JP.currency, 'JPY');
	assert.equal(byTerritory.GB.currency, null);
	assert.ok(!('IT' in byTerritory), 'a price that is not a number is not a price');
});

test('a live price with no currency prints as a bare number', async () => {
	ascOk({ app: SHAPES });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir, flags: { 'app-price': true } });
	assert.match(out, /GB\s+4\.49\s*$/m, 'no currency means no trailing space to align on');
});

// ─── naming the subscription to price ───────────────────────────────────────

test('--subscription names one of several by its product id', async () => {
	ascOk({
		subs: { data: [{ attributes: { id: 'sub-a', productId: 'com.a', name: 'A', subscriptionPeriod: 'ONE_MONTH' } }, { id: 'sub-b', attributes: { productId: 'com.b' } }] },
	});
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir, flags: { subscription: 'com.a' } });
	assert.match(out, /subscription com\.a — A/);
});

test('--subscription accepts an id asc could not list', async () => {
	// asc cannot always list subscriptions (a sandbox key, a paginated list that
	// times out); naming the id by hand has to still price it.
	ascOk({ subs: { data: [] } });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir, flags: { subscription: 'com.ghost' } });
	assert.match(out, /subscription com\.ghost\n/, 'an id asc never described carries no name');
});

test('a subscription asc names only by its internal id is still priced', async () => {
	ascOk({ subs: { data: [{ id: 'sub-only' }] } });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /subscription sub-only\n/);
});

test('a subscription asc names only by its product id is still priced', async () => {
	ascOk({ subs: { data: [{ attributes: { productId: 'com.p' } }] }, subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['show'], { dir });
	assert.match(out, /subscription com\.p\n/);
	const { code } = await price(['apply'], { dir, flags: { 'max-delta': 100 } });
	assert.equal(code, 0);
	const set = (await calls()).find((call) => call.args.includes('set'));
	assert.ok(set.args.includes('com.p'), 'the product id stands in for the missing subscription id');
});

test('show keeps going when the per-territory price read fails', async () => {
	// show is a read: a target it can name but not price is a warning, not a
	// failure, because the app price and the plan diff are still worth printing.
	ascOk({ extra: [['subscriptions pricing prices list', { code: 1, err: 'asc: forbidden' }]] });
	const dir = await priceRepo();
	const { code, out } = await price(['show'], { dir });
	assert.equal(code, 0);
	assert.match(out, /subscription prices unavailable/);
});

test('apply names the subscriptions to choose between by whatever id each carries', async () => {
	ascOk({ subs: { data: [{ id: 'sub-a' }, { id: 'sub-b', attributes: { productId: 'com.b' } }] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(() => price(['apply'], { dir }), /--subscription sub-a \| com\.b|2 subscriptions/);
});

test('apply --subscription skips the lookup entirely', async () => {
	ascOk({ subs: { data: [] }, subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { code } = await price(['apply'], { dir, flags: { subscription: 'com.named', 'max-delta': 100 } });
	assert.equal(code, 0);
	const set = (await calls()).find((call) => call.args.includes('set'));
	assert.ok(set.args.includes('com.named'));
});

// ─── the price schedule, in the shapes asc reports it ───────────────────────

const scheduleIs = (payload) => ascOk({ extra: [['pricing schedule view', { out: payload }]] });

test('a price schedule is named from wherever asc put its id and start date', async () => {
	scheduleIs({ data: [{ attributes: { id: 'sched-a', startDate: '2026-11-01' } }] });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /price schedule sched-a · starts 2026-11-01/);
});

test('a flattened price schedule row is read too', async () => {
	scheduleIs({ data: [{ startDate: '2026-12-01' }] });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /price schedule — · starts 2026-12-01/, 'no id to show is a dash, not "undefined"');
});

test('a price schedule with no start date is already in effect', async () => {
	scheduleIs({ data: [{}] });
	const dir = await priceRepo();
	const { out } = await price(['show'], { dir });
	assert.match(out, /price schedule — · starts immediate/);
});

// ─── plan versus live ───────────────────────────────────────────────────────

test('show reports a plan the store already matches as a match', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 4.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['show'], { dir });
	assert.match(out, /all 1 planned territories already match/);
});

test('show prints the live price and the delta for each move the plan wants', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['show'], { dir });
	assert.match(out, /3\.99/, 'the live price is shown, not "unset"');
	assert.match(out, /\+25%/);
});

test('show reports a planned cut as a cut', async () => {
	// show gates nothing, so a price the plan lowers has to read as a decrease
	// here — this is where an operator sees a bad plan before `apply` refuses it.
	ascOk({ subPrices: { data: [priceRow('US', 9.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['show'], { dir });
	assert.match(out, /-50%/);
	assert.doesNotMatch(out, /\+50%/);
});

test('a territory with no live price is shown as unset, with no delta to show', async () => {
	// A first price is not a move: there is nothing to compare it against, and a
	// percentage there would be an invention.
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	const { out } = await price(['show'], { dir });
	assert.match(out, /DE\s+unset\s+\S+ EUR\s*$/m);
});

test('show --json carries the plan and the diff against it', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	const { out } = await price(['show'], { dir, flags: { json: true } });
	const doc = JSON.parse(out);
	assert.equal(doc.target, 'subscription');
	assert.equal(doc.plan.rows, 2);
	assert.equal(doc.plan.baseUsd, 4.99);
	assert.equal(doc.diff.changes.length, 1);
	assert.deepEqual(doc.diff.unchanged, []);
});

test('a plan file that is not JSON names the file rather than crashing', async () => {
	ascOk();
	const dir = await priceRepo({ 'store/pricing/plan.json': '{ not json' });
	await assert.rejects(() => price(['show'], { dir }), /plan\.json is not valid JSON/);
});

// ─── apply, as data ─────────────────────────────────────────────────────────

test('apply --json reports the moves --max-delta blocked, and the table shows a cut', async () => {
	// A cut is the case the sign handling gets wrong: −95% is as unreversible as
	// +400%, and it has to read as a cut in both the table and the JSON.
	ascOk({ subPrices: { data: [priceRow('US', 99.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(() => price(['apply'], { dir, flags: { 'max-delta': 10 } }), /exceed --max-delta/);

	// The JSON body is emitted before the throw: a machine reading this run needs
	// the blocked list even though the exit is a failure.
	let thrown;
	const { out } = await capture(() =>
		inDir(dir, () => run({ args: ['apply'], flags: { 'max-delta': 10, json: true } }).catch((err) => { thrown = err; })),
	);
	assert.match(String(thrown), /exceed --max-delta/);
	const doc = JSON.parse(out);
	assert.equal(doc.reason, 'max-delta');
	assert.deepEqual(doc.applied, []);
	assert.ok(doc.blocked[0].delta < 0, 'a cut is reported as a cut');
});

test('apply --json reports having nothing to do', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 4.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['apply'], { dir, flags: { json: true } });
	assert.deepEqual(JSON.parse(out), { applied: [], skipped: [], unchanged: 1 });
});

test('apply --json reports what it pushed and when it takes effect', async () => {
	ascOk({ subPrices: { data: [priceRow('US', 3.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['apply'], { dir, flags: { 'max-delta': 100, 'start-date': '2026-10-01', json: true } });
	const doc = JSON.parse(out);
	assert.equal(doc.subscription, 'sub1');
	assert.equal(doc.startDate, '2026-10-01');
	assert.equal(doc.applied.length, 1);
	assert.deepEqual(doc.skipped, []);
});

test('a price asc refuses aborts the batch rather than half-applying it', async () => {
	// A half-applied price table is worse than either price, so the first refusal
	// stops the run and carries asc's own words.
	ascOk({
		subPrices: { data: [priceRow('US', 3.99, 'USD')] },
		extra: [['subscriptions pricing prices set', { code: 2, err: 'asc: price point not on the ladder' }]],
	});
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	await assert.rejects(
		() => price(['apply'], { dir, flags: { 'max-delta': 100 } }),
		/asc subscriptions pricing prices set exited 2/,
	);
});

// ─── apply --app-price ──────────────────────────────────────────────────────

test('apply --app-price --json reports a price already correct as unchanged', async () => {
	ascOk({ app: { data: [priceRow('US', 4.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { out } = await price(['apply'], { dir, flags: { 'app-price': true, json: true } });
	assert.deepEqual(JSON.parse(out), { target: 'app', applied: [], unchanged: ['US'] });
});

test('apply --app-price schedules the change for the date asked for', async () => {
	ascOk({ app: { data: [priceRow('US', 2.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US' } });
	const { code } = await price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 100, 'start-date': '2026-10-01' } });
	assert.equal(code, 0);
	const created = (await calls()).find((call) => call.args.includes('create'));
	assert.ok(created.args.includes('2026-10-01'), '--start-date rides along');
});

test('apply --app-price --dry-run schedules nothing and says which price it would have set', async () => {
	ascOk({ app: { data: [priceRow('US', 2.99, 'USD')] } });
	const dir = await priceRepo();
	await price(['plan'], { dir, flags: { territories: 'US,DE' } });
	setDryRun(true);
	try {
		const { out } = await price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 100 } });
		assert.match(out, /app price schedule planned/, 'planned, never "created" — nothing was pushed');
		const { out: raw } = await price(['apply'], { dir, flags: { 'app-price': true, 'max-delta': 100, json: true } });
		// --dry-run narrates the call it did not make before the JSON body.
		const doc = JSON.parse(raw.slice(raw.indexOf('{')));
		assert.deepEqual(doc.applied, []);
		assert.deepEqual(doc.skipped, ['US']);
	} finally {
		setDryRun(false);
	}
});

// ─── audit: what it refuses to judge ────────────────────────────────────────

test('audit will not tell a yearly from a weekly without a period', async () => {
	// asc does not always carry subscriptionPeriod. Reporting "no yearly" from a
	// payload that simply does not say is the failure this guards.
	ascOk({ subs: { data: [{ id: 'sub1', attributes: { productId: 'com.demo.sub' } }] } });
	const dir = await priceRepo();
	const { out } = await price(['audit'], { dir, flags: { json: true } });
	const ladder = JSON.parse(out).rows.find((r) => r.name === 'ladder');
	assert.equal(ladder.level, 'skip');
	assert.match(ladder.detail, /cannot tell a yearly from a weekly/);
});

test('audit skips trial placement and the annual price when asc carries neither', async () => {
	// `asc subscriptions list` has no introductory-offer duration and the price
	// list has no US row: both are unknown, and unknown is not a finding.
	ascOk({
		subs: { data: [{ id: 'sub1', attributes: { productId: 'com.demo.yearly', subscriptionPeriod: 'ONE_YEAR' } }] },
		subPrices: { data: [priceRow('DE', 49.99, 'EUR')] },
	});
	const dir = await priceRepo();
	const { out } = await price(['audit'], { dir, flags: { json: true } });
	const rows = JSON.parse(out).rows;
	const trial = rows.find((r) => r.name === 'trial placement');
	assert.equal(trial.level, 'skip');
	assert.match(trial.detail, /no introductory-offer duration/);
	assert.equal(rows.find((r) => r.name === 'annual price').level, 'skip');
});

test('audit reads the win-back offering when RevenueCat answers', async () => {
	// With offerings in hand the retention row is a real finding, and the row
	// naming why they were missing must not be printed alongside it.
	ascOk();
	const dir = await priceRepo();
	const fetch = async (url) =>
		json(String(url).includes('/offerings')
			? { items: [{ id: 'off1', lookup_key: 'default' }] }
			: { items: [{ id: 'proj1', name: 'Demo' }] });
	const { out } = await price(['audit'], { dir, flags: { json: true }, fetch });
	const rows = JSON.parse(out).rows;
	assert.ok(!rows.some((r) => r.name === 'offerings'), 'nothing to say about offerings we could read');
	assert.equal(rows.find((r) => r.name === 'retention offer').level, 'warn');
});

test('audit will not guess which RevenueCat project this repo is', async () => {
	// Several projects on the account and no projectId in the config: picking one
	// would audit the wrong app's paywall, so it says what is missing instead.
	ascOk();
	const dir = await priceRepo();
	const fetch = async () => json({ items: [{ id: 'proj1', name: 'Demo' }, { id: 'proj2', name: 'Other' }] });
	const { out } = await price(['audit'], { dir, flags: { json: true }, fetch });
	const offerings = JSON.parse(out).rows.find((r) => r.name === 'offerings');
	assert.match(offerings.detail, /no revenuecat\.projectId/);
});

test('a rejection that is not an Error still names itself', async () => {
	ascOk();
	const dir = await priceRepo();
	const fetch = async () => { throw 'connection reset'; };
	const { out } = await price(['audit'], { dir, flags: { json: true }, fetch });
	const offerings = JSON.parse(out).rows.find((r) => r.name === 'offerings');
	assert.match(offerings.detail, /offerings unreadable — connection reset/);
});

// ─── audit: the states in which there is nothing to audit ───────────────────

test('audit without an App Store Connect app id says which key is missing', async () => {
	ascOk();
	const dir = await repo({ config: { price: { basePriceUsd: 4.99 } }, prefix: 'ship-price-' });
	const { out } = await price(['audit'], { dir, flags: { json: true } });
	const ladder = JSON.parse(out).rows.find((r) => r.name === 'ladder');
	assert.equal(ladder.level, 'skip');
	assert.match(ladder.detail, /set asc\.appId in ship\.config\.json/);
});

test('audit with no asc on PATH points at ship doctor', async () => {
	// asc is the whole read; without it the audit has no ladder to judge and must
	// say why rather than reporting an app with no subscriptions.
	const dir = await priceRepo();
	const path = process.env.PATH;
	process.env.PATH = '/nonexistent';
	try {
		const { out } = await price(['audit'], { dir, flags: { json: true } });
		const ladder = JSON.parse(out).rows.find((r) => r.name === 'ladder');
		assert.match(ladder.detail, /asc is not on PATH — see `ship doctor`/);
	} finally {
		process.env.PATH = path;
	}
});

test('audit prices a subscription asc names only by its product id', async () => {
	ascOk({
		subs: { data: [{ attributes: { productId: 'com.demo.yearly', subscriptionPeriod: 'ONE_YEAR' } }] },
		subPrices: { data: [priceRow('US', 39.99, 'USD')] },
	});
	const dir = await priceRepo();
	const { out } = await price(['audit'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(out).rows.find((r) => r.name === 'annual price').level, 'ok');
});
