// The validator subset, keyword by keyword. It is gate code: a keyword that
// silently does nothing would let an invalid artifact through a green run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../src/lib/schema.mjs';

const ok = (schema, value) => assert.deepEqual(validate(schema, value), [], `expected valid: ${JSON.stringify(value)}`);
const bad = (schema, value, needle) => {
	const issues = validate(schema, value);
	assert.ok(issues.length, `expected invalid: ${JSON.stringify(value)}`);
	if (needle) assert.ok(issues.some((i) => i.message.includes(needle)), `${JSON.stringify(issues)} lacks "${needle}"`);
};

test('type accepts a union and names what it got', () => {
	ok({ type: 'string' }, 'x');
	ok({ type: ['integer', 'null'] }, null);
	ok({ type: ['integer', 'null'] }, 3);
	bad({ type: ['integer', 'null'] }, 3.5, 'expected integer or null, got number');
	bad({ type: 'object' }, [], 'got array');
	bad({ type: 'array' }, {}, 'got object');
	bad({ type: 'number' }, Number.NaN);
	bad({ type: 'boolean' }, 'true');
	bad({ type: 'string' }, null, 'got null');
});

test('a failed type check stops the value being measured as the wrong thing', () => {
	assert.equal(validate({ type: 'string', minLength: 5 }, 42).length, 1);
});

test('enum and const', () => {
	ok({ enum: ['a', 'b'] }, 'b');
	bad({ enum: ['a', 'b'] }, 'c', 'must be one of: a, b');
	ok({ const: 2 }, 2);
	bad({ const: 2 }, 3, 'must be 2');
});

test('string constraints', () => {
	bad({ type: 'string', minLength: 2 }, 'a', 'shorter than 2');
	bad({ type: 'string', maxLength: 2 }, 'abc', 'longer than 2');
	bad({ type: 'string', pattern: '^ref_' }, 'x', 'does not match');
	ok({ type: 'string', pattern: '^ref_' }, 'ref_a1');
});

test('formats', () => {
	ok({ format: 'date-time' }, '2026-09-02T12:00:00Z');
	bad({ format: 'date-time' }, '2026-09-02', 'not a valid date-time');
	bad({ format: 'date-time' }, '2026-13-40T00:00:00Z');
	ok({ format: 'uri' }, 'https://example.com/a');
	bad({ format: 'uri' }, 'example.com');
	ok({ format: 'sha256' }, 'a'.repeat(64));
	bad({ format: 'sha256' }, 'a'.repeat(63));
	ok({ format: 'unknown-format' }, 'anything');
});

test('number bounds', () => {
	bad({ type: 'number', minimum: 1 }, 0, 'below minimum 1');
	bad({ type: 'number', maximum: 5 }, 6, 'above maximum 5');
	ok({ type: 'number', minimum: 1, maximum: 5 }, 5);
});

test('array constraints and per-item recursion', () => {
	bad({ type: 'array', minItems: 2 }, [1], 'at least 2');
	bad({ type: 'array', maxItems: 1 }, [1, 2], 'limit is 1');
	bad({ type: 'array', uniqueItems: true }, ['a', 'a'], 'duplicate');
	ok({ type: 'array', uniqueItems: true }, ['a', 'b']);
	const schema = { type: 'array', items: { type: 'integer' } };
	assert.deepEqual(validate(schema, [1, 'x']), [{ path: '$[1]', message: 'expected integer, got string' }]);
});

test('objects: required, unknown keys, minProperties', () => {
	const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
	ok(schema, { a: 'x' });
	assert.deepEqual(validate(schema, {}), [{ path: '$.a', message: 'is required' }]);
	bad(schema, { a: 'x', b: 1 }, 'is not a known property');
	bad({ type: 'object', minProperties: 1 }, {}, 'at least 1');
	ok({ type: 'object', minProperties: 1 }, { a: 1 });
});

test('patternProperties match before additionalProperties refuses', () => {
	const schema = {
		type: 'object',
		additionalProperties: false,
		properties: { a: { type: 'string' } },
		patternProperties: { '^x_': { type: 'integer' } },
	};
	ok(schema, { a: 'v', x_1: 3 });
	bad(schema, { x_1: 'no' }, 'expected integer');
	bad(schema, { y_1: 3 }, 'is not a known property');
});

test('additionalProperties as a schema validates every undeclared value', () => {
	const schema = { type: 'object', additionalProperties: { type: 'integer' } };
	ok(schema, { any: 1, other: 2 });
	assert.deepEqual(validate(schema, { any: 'x' }), [{ path: '$.any', message: 'expected integer, got string' }]);
});

test('$ref resolves against the document root', () => {
	const schema = {
		$defs: { id: { type: 'string', pattern: '^ref_' } },
		type: 'object',
		properties: { a: { $ref: '#/$defs/id' } },
	};
	ok(schema, { a: 'ref_1' });
	bad(schema, { a: 'x' }, 'does not match');
	assert.throws(() => validate({ $ref: '#/$defs/missing' }, 1), /unresolvable \$ref/);
	assert.throws(() => validate({ $defs: { loop: { $ref: '#/$defs/loop' } }, $ref: '#/$defs/loop' }, 1), /circular \$ref/);
});

test('allOf, anyOf and oneOf', () => {
	ok({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'ab');
	bad({ allOf: [{ type: 'string' }, { minLength: 2 }] }, 'a', 'shorter than 2');
	const any = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
	ok(any, 'x');
	ok(any, 3);
	bad(any, true, 'matches none of the allowed shapes');
	const one = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
	ok(one, 3.5);
	bad(one, 12, 'matches 2 of the allowed shapes');
	bad(one, 'x', 'matches 0 of the allowed shapes');
});

test('every issue carries the path that failed', () => {
	const schema = {
		type: 'object',
		properties: { list: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } },
	};
	assert.deepEqual(validate(schema, { list: [{ n: 1 }, { n: 'x' }] }), [
		{ path: '$.list[1].n', message: 'expected integer, got string' },
	]);
});
