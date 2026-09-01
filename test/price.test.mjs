// Territory pricing. Two things here cost real money when they break: a price
// that is not on the local ladder (¥743 is not a price anyone has seen, and
// customers read it as an import), and a price move that ships without being
// gated (price changes are visible to existing subscribers and are not casually
// reversible). Both are decided by pure functions, so both are pinned here.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	COMMISSION,
	MIN_PROCEEDS_USD,
	TERRITORIES,
	derivePlan,
	normaliseTerritory,
	reconcilePrices as reconcile,
} from '../src/lib/pricing.mjs';

const BASE = 4.99;
const plan = derivePlan(BASE);
const row = (doc, territory) => {
	const found = doc.rows.find((r) => r.territory === territory);
	assert.ok(found, `no ${territory} row`);
	return found;
};
const basis = (territory) => TERRITORIES.find((t) => t.territory === territory);
/** What a straight FX conversion of the US price would have produced. */
const naive = (territory, base = BASE) => base * basis(territory).fx;

// ─── ladders ─────────────────────────────────────────────────────────────────

test('the JPY price is a whole number on the ¥00/¥80 ladder', () => {
	for (const base of [0.99, 2.99, 4.99, 9.99, 19.99, 49.99]) {
		const jp = row(derivePlan(base), 'JP');
		assert.equal(jp.currency, 'JPY');
		assert.equal(jp.decimals, 0);
		assert.ok(Number.isInteger(jp.price), `¥${jp.price} is not a whole yen`);
		assert.ok(jp.price % 100 === 0 || jp.price % 100 === 80, `¥${jp.price} is off the ladder`);
	}
});

test('a EUR price always ends in .99', () => {
	for (const base of [0.99, 2.49, 4.99, 7.99, 12.99, 29.99]) {
		for (const territory of ['DE', 'FR', 'IT', 'ES']) {
			const r = row(derivePlan(base), territory);
			assert.equal(r.currency, 'EUR');
			assert.equal(r.decimals, 2);
			assert.equal(Math.round(r.price * 100) % 100, 99, `${r.price} ${territory} does not end in .99`);
		}
	}
});

test('the INR price is a whole rupee amount', () => {
	for (const base of [0.99, 4.99, 9.99, 24.99]) {
		const inr = row(derivePlan(base), 'IN');
		assert.equal(inr.currency, 'INR');
		assert.equal(inr.decimals, 0);
		assert.ok(Number.isInteger(inr.price), `₹${inr.price} carries a subunit`);
		assert.equal(inr.price % 10, 9, `₹${inr.price} is off the 9/49/99 ladder`);
	}
});

test('no decimal-free storefront ever gets a fractional price', () => {
	for (const base of [0.99, 3.99, 8.99, 14.99]) {
		for (const r of derivePlan(base).rows) {
			if (r.decimals === 0) assert.ok(Number.isInteger(r.price), `${r.territory} ${r.price} has a subunit`);
			else assert.equal(Math.round(r.price * 100) % 100, 99, `${r.territory} ${r.price} is not a .99 price`);
			assert.ok(r.price > 0, `${r.territory} priced at ${r.price}`);
		}
	}
});

// ─── the base price ──────────────────────────────────────────────────────────

test('the base price propagates and the US row is the base', () => {
	for (const base of [0.99, 4.99, 9.99, 49.99]) {
		const doc = derivePlan(base);
		assert.equal(doc.baseUsd, base);
		const us = row(doc, 'US');
		assert.equal(us.price, base);
		assert.equal(us.usdEquivalent, base);
		assert.equal(us.effectivePct, 100);
		assert.equal(us.basisPct, 100);
	}
});

test('a non-positive or unparseable base is refused, not silently coerced', () => {
	for (const bad of [0, -1, 'free', null, undefined, Number.NaN]) {
		assert.throws(() => derivePlan(bad), /base price must be a positive number/);
	}
});

test('--territories filters the table and an unknown one names the covered set', () => {
	const doc = derivePlan(BASE, { territories: ['de', 'JPN', 'US'] });
	assert.deepEqual(doc.rows.map((r) => r.territory), ['US', 'DE', 'JP']);
	assert.throws(() => derivePlan(BASE, { territories: ['ZZ'] }), /no pricing basis for ZZ/);
	assert.equal(normaliseTerritory('DEU'), 'DE');
	assert.equal(normaliseTerritory('de'), 'DE');
});

// ─── purchasing power ────────────────────────────────────────────────────────

test('low-PPP territories land below a naive FX conversion', () => {
	for (const territory of ['IN', 'ID', 'EG', 'BR', 'TR']) {
		const r = row(plan, territory);
		assert.ok(basis(territory).basisPct < 100);
		assert.ok(
			r.price < naive(territory),
			`${territory}: ${r.price} is not below the ${naive(territory).toFixed(2)} FX conversion`,
		);
		assert.ok(r.usdEquivalent < BASE, `${territory} nets $${r.usdEquivalent}, not below the $${BASE} base`);
		assert.ok(r.effectivePct < 100);
	}
});

test('high-PPP territories land above a naive FX conversion', () => {
	for (const territory of ['CH', 'NO', 'AU', 'DK']) {
		const r = row(plan, territory);
		assert.ok(basis(territory).basisPct > 100);
		assert.ok(
			r.price > naive(territory),
			`${territory}: ${r.price} is not above the ${naive(territory).toFixed(2)} FX conversion`,
		);
		assert.ok(r.usdEquivalent > BASE, `${territory} nets $${r.usdEquivalent}, not above the $${BASE} base`);
		assert.ok(r.effectivePct > 100);
	}
});

test('India is priced at roughly a third of the US, not at the FX rate', () => {
	const inr = row(plan, 'IN');
	assert.ok(inr.price < naive('IN') * 0.5, `₹${inr.price} vs ₹${naive('IN').toFixed(0)} equalized`);
	assert.ok(Math.abs(inr.effectivePct - 30) < 10, `${inr.effectivePct}% is nowhere near the 30% basis`);
});

test('rounding drift is reported, not hidden', () => {
	for (const r of plan.rows) {
		assert.equal(r.roundingDriftPct, Math.round((r.effectivePct - r.basisPct) * 10) / 10);
	}
});

// ─── sustainability floor ────────────────────────────────────────────────────

test('proceeds are the local price net of commission, in USD', () => {
	for (const r of plan.rows) {
		assert.equal(r.proceedsUsd, Math.round(r.usdEquivalent * (1 - COMMISSION) * 100) / 100);
	}
	assert.equal(plan.commission, COMMISSION);
	assert.equal(plan.floorUsd, MIN_PROCEEDS_USD);
});

test('a territory whose derived price nets less than the floor is flagged', () => {
	const cheap = derivePlan(1.99);
	const inr = row(cheap, 'IN');
	assert.ok(inr.proceedsUsd < MIN_PROCEEDS_USD, `₹${inr.price} nets $${inr.proceedsUsd}`);
	assert.equal(inr.belowFloor, true);
	assert.ok(cheap.flagged.includes('IN'));
	assert.deepEqual(cheap.flagged, cheap.rows.filter((r) => r.belowFloor).map((r) => r.territory));
	// The same territory clears the default floor once the base pays for it.
	assert.equal(row(plan, 'IN').belowFloor, false);
	assert.deepEqual(plan.flagged, []);
});

test('a raised floor flags the territories that cannot repay an install', () => {
	const strict = derivePlan(BASE, { floorUsd: 2 });
	assert.equal(strict.floorUsd, 2);
	assert.ok(strict.flagged.includes('IN'));
	assert.ok(strict.flagged.includes('ID'));
	assert.ok(!strict.flagged.includes('US'));
	for (const r of strict.rows) assert.equal(r.belowFloor, r.proceedsUsd < 2);
});

// ─── the delta gate ──────────────────────────────────────────────────────────

const priced = (territory, price) => ({ territory, currency: 'USD', price, decimals: 2 });

test('a move larger than --max-delta is blocked and one at exactly the limit is not', () => {
	const rows = [priced('AT', 15), priced('BE', 16)];
	const live = { AT: { price: 10 }, BE: { price: 10 } };
	const { changes, blocked } = reconcile(rows, live, { maxDelta: 0.5 });
	assert.deepEqual(changes.map((c) => c.territory), ['AT']); // +50%, exactly the limit
	assert.deepEqual(blocked.map((c) => c.territory), ['BE']); // +60%
	assert.equal(changes[0].delta, 0.5);
	assert.equal(blocked[0].delta, 0.6);
	assert.equal(changes[0].from, 10);
	assert.equal(changes[0].to, 15);
});

test('the gate is symmetric — a cut past the limit is blocked too', () => {
	const live = new Map([['AT', { price: 10 }], ['BE', { price: 10 }]]);
	const { changes, blocked } = reconcile([priced('AT', 5), priced('BE', 3.9)], live, { maxDelta: 0.5 });
	assert.deepEqual(changes.map((c) => c.territory), ['AT']); // -50%
	assert.deepEqual(blocked.map((c) => c.territory), ['BE']); // -61%
});

test('--force moves a blocked change into the batch rather than dropping it', () => {
	const { changes, blocked } = reconcile([priced('BE', 100)], { BE: { price: 10 } }, { maxDelta: 0.5, force: true });
	assert.deepEqual(blocked, []);
	assert.deepEqual(changes.map((c) => c.territory), ['BE']);
});

test('a territory with no live price is a first price, not a gated move', () => {
	const { added, changes, blocked } = reconcile([priced('BE', 999)], {}, { maxDelta: 0.5 });
	assert.deepEqual(added.map((c) => c.territory), ['BE']);
	assert.equal(added[0].from, null);
	assert.deepEqual(changes, []);
	assert.deepEqual(blocked, []);
});

test('an unchanged price is not a change', () => {
	const { unchanged, changes } = reconcile([priced('AT', 14.99)], { AT: { price: 14.99 } }, { maxDelta: 0.5 });
	assert.deepEqual(unchanged.map((c) => c.territory), ['AT']);
	assert.deepEqual(changes, []);
});

// ─── config wiring ───────────────────────────────────────────────────────────

const SHIP = fileURLToPath(new URL('../bin/ship', import.meta.url));
const exec = promisify(execFile);

test('price plan reads basePriceUsd from ship.config.json', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'ship-price-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(
		join(dir, 'ship.config.json'),
		`${JSON.stringify({
			name: 'Glovebox',
			bundleId: 'com.example.glovebox',
			price: { dir: 'store/pricing', basePriceUsd: 6.99 },
		})}\n`,
	);

	const { stdout } = await exec(process.execPath, [SHIP, 'price', 'plan', '--json'], { cwd: dir, encoding: 'utf8' });
	const doc = JSON.parse(stdout);
	assert.equal(doc.baseUsd, 6.99);
	assert.equal(row(doc, 'US').price, 6.99);
	assert.equal(doc.rows.length, TERRITORIES.length);
	assert.equal(doc.app.bundleId, 'com.example.glovebox');
	// The plan is written where the rest of the pipeline reads it.
	const written = JSON.parse(await readFile(join(dir, 'store', 'pricing', 'plan.json'), 'utf8'));
	assert.equal(written.baseUsd, 6.99);
});
