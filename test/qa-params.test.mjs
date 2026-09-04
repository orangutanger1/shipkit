// test/qa-params.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { QA_DEFAULTS, sanitizeQa } from '../src/lib/qa-params.mjs';

const OPTS = { enabled: true, themes: ['light', 'dark'], states: ['default', 'loading', 'error'] };

test('disabled returns the defaults for every hostile input', () => {
	const hostile = [
		{ qaTheme: 'dark', qaState: 'error', qaLocale: 'de-DE', qaTextScale: '2' },
		{ qaTheme: ['dark'], qaState: '../../etc/passwd', qaLocale: '../', qaTextScale: 'Infinity' },
		{ qaTheme: '__proto__', qaState: 'constructor', qaLocale: 999, qaTextScale: -5 },
	];
	for (const raw of hostile)
		assert.deepEqual(sanitizeQa(raw, { ...OPTS, enabled: false }), QA_DEFAULTS);
});

test('enabled accepts the valid set', () => {
	assert.deepEqual(sanitizeQa({ qaTheme: 'dark', qaState: 'error', qaLocale: 'de-DE', qaTextScale: '1.5' }, OPTS), {
		theme: 'dark', state: 'error', locale: 'de-DE', scale: 1.5,
	});
});

test('enabled falls back per field, never throws', () => {
	const cases = [
		[{ qaTheme: 'chartreuse' }, 'theme', null],
		[{ qaState: 'nope' }, 'state', 'default'],
		[{ qaLocale: 'not a locale' }, 'locale', null],
		[{ qaLocale: 'de_DE' }, 'locale', null],
		[{ qaTextScale: 'NaN' }, 'scale', 1],
		[{ qaTextScale: '0.01' }, 'scale', 0.5],
		[{ qaTextScale: '99' }, 'scale', 4],
		[{ qaTheme: ['dark', 'light'] }, 'theme', null],
		[{ qaState: null }, 'state', 'default'],
	];
	for (const [raw, field, want] of cases)
		assert.equal(sanitizeQa(raw, OPTS)[field], want, `${field} from ${JSON.stringify(raw)}`);
});

test('an absent parameter object is the defaults', () => {
	assert.deepEqual(sanitizeQa(undefined, OPTS), QA_DEFAULTS);
});
