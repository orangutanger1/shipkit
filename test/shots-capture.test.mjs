// The capture step's seed builder, unit-level. `seedFor` decides what a browser
// profile holds before a screenshot is taken, and it is where two failures live
// that no screenshot would ever show you: a locale inheriting the previous
// locale's storage, and a date placeholder that silently stayed literal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFor } from '../src/lib/shots-capture.mjs';

const NOW = new Date('2026-03-15T09:30:00.000Z');

test('a seed with no overlay is the shared default', () => {
	assert.deepEqual(seedFor({ default: { currency: 'USD' } }, 'en-US', NOW), { currency: 'USD' });
});

test('no seed at all is an empty payload, not a crash', () => {
	assert.deepEqual(seedFor(null, 'en-US', NOW), {});
	assert.deepEqual(seedFor({}, 'en-US', NOW), {});
});

test('a locale overlay is merged deeply, so it states only what differs', () => {
	// The whole point of the overlay: a locale names one currency code rather
	// than a second copy of the fixture that then drifts from the original.
	const seed = {
		default: { settings: { currency: 'USD', units: 'imperial' }, car: { name: 'Wagon' } },
		byLocale: { 'de-DE': { settings: { currency: 'EUR' } } },
	};
	assert.deepEqual(seedFor(seed, 'de-DE', NOW), {
		settings: { currency: 'EUR', units: 'imperial' },
		car: { name: 'Wagon' },
	});
	assert.deepEqual(seedFor(seed, 'en-US', NOW).settings.currency, 'USD', 'the default is untouched by the overlay');
});

test('an overlay replaces an array wholesale rather than merging it item by item', () => {
	// Merging entries pairwise would leave a German fixture holding the tail of
	// the English one — three services where the locale asked for two.
	const seed = {
		default: { services: [{ label: 'Oil change' }, { label: 'Tyres' }, { label: 'Brakes' }] },
		byLocale: { 'de-DE': { services: [{ label: 'Ölwechsel' }] } },
	};
	assert.deepEqual(seedFor(seed, 'de-DE', NOW).services, [{ label: 'Ölwechsel' }]);
});

test('an overlay may replace an object with a scalar, and a scalar with an object', () => {
	const toScalar = seedFor({ default: { trip: { km: 12 } }, byLocale: { x: { trip: 0 } } }, 'x', NOW);
	assert.equal(toScalar.trip, 0);
	const toObject = seedFor({ default: { trip: 0 }, byLocale: { x: { trip: { km: 12 } } } }, 'x', NOW);
	assert.deepEqual(toObject.trip, { km: 12 });
});

test('an overlay of null clears a value instead of being ignored', () => {
	assert.equal(seedFor({ default: { banner: 'Welcome' }, byLocale: { x: { banner: null } } }, 'x', NOW).banner, null);
});

test('date placeholders resolve against a fixed now, everywhere in the fixture', () => {
	// A hardcoded date drifts out of the seeded fixture the day after it is
	// written: an invoice screen captured in April must not show March's data.
	const seed = {
		default: {
			today: '{{today}}',
			yesterday: '{{today-1}}',
			nextWeek: '{{today+7}}',
			thisMonth: '{{month}}',
			lastMonth: '{{month-1}}',
			stamp: '{{now}}',
			nested: { entries: ['{{today}}', 'literal'] },
			count: 3,
			enabled: true,
			nothing: null,
		},
	};
	const out = seedFor(seed, 'en-US', NOW);
	assert.equal(out.today, '2026-03-15');
	assert.equal(out.yesterday, '2026-03-14');
	assert.equal(out.nextWeek, '2026-03-22');
	assert.equal(out.thisMonth, '2026-03');
	assert.equal(out.lastMonth, '2026-02');
	assert.equal(out.stamp, '2026-03-15T09:30:00.000Z');
	assert.deepEqual(out.nested.entries, ['2026-03-15', 'literal'], 'arrays and nested objects are walked too');
	assert.equal(out.count, 3, 'a non-string is carried through untouched');
	assert.equal(out.enabled, true);
	assert.equal(out.nothing, null);
});

test('a placeholder inside a longer string is replaced in place', () => {
	assert.equal(seedFor({ default: { label: 'Invoice for {{month}}' } }, 'en-US', NOW).label, 'Invoice for 2026-03');
});
