import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DASH, num, round1, round2, clamp, clamp100, money, moneyOrDash, pct } from '../src/lib/fmt.mjs';

test('num coerces and falls back on junk', () => {
	assert.equal(num('42'), 42);
	assert.equal(num(-3.5), -3.5);
	assert.equal(num('abc'), 0);
	assert.equal(num('abc', 7), 7);
	assert.equal(num(NaN, 9), 9);
	assert.equal(num(Infinity, 1), 1);
	assert.equal(num(null, 4), 0); // Number(null) is 0, which is finite
	assert.equal(num(undefined, 4), 4);
});

test('round2 and round1 round half away to the requested precision', () => {
	assert.equal(round2(1.005), 1);
	assert.equal(round2(2.675), 2.68);
	assert.equal(round2(0.1 + 0.2), 0.3);
	assert.equal(round1(2.44), 2.4);
	assert.equal(round1(2.46), 2.5);
});

test('clamp saturates inside the bounds', () => {
	assert.equal(clamp(5, 0, 10), 5);
	assert.equal(clamp(-1, 0, 10), 0);
	assert.equal(clamp(11, 0, 10), 10);
});

test('clamp100 coerces then saturates 0-100 without rounding', () => {
	assert.equal(clamp100('50'), 50);
	assert.equal(clamp100(120), 100);
	assert.equal(clamp100(-5), 0);
	assert.equal(clamp100('junk'), 0);
	assert.equal(clamp100(50.6), 50.6);
});

test('money renders dollars with two decimals; absence reads as zero', () => {
	assert.equal(money(1.5), '$1.50');
	assert.equal(money('12.345'), '$12.35');
	assert.equal(money(0), '$0.00');
	assert.equal(money(null), '$0.00');
	assert.equal(money(undefined), '$0.00');
	assert.equal(money('junk'), '$0.00');
});

test('moneyOrDash distinguishes no-value from zero', () => {
	assert.equal(moneyOrDash(null), DASH);
	assert.equal(moneyOrDash(undefined), DASH);
	assert.equal(moneyOrDash(0), '$0.00');
	assert.equal(moneyOrDash(3), '$3.00');
});

test('pct renders a fraction with the requested precision', () => {
	assert.equal(pct(0.1234), '12.34%');
	assert.equal(pct(0.5, 1), '50.0%');
	assert.equal(pct(1), '100.00%');
	assert.equal(pct(null), '0.00%');
	assert.equal(pct('junk'), '0.00%');
});

test('DASH is the em-dash placeholder', () => {
	assert.equal(DASH, '—');
});
