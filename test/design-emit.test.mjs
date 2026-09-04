// test/design-emit.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyHash, classify, parseHeader, routeToFile, withHeader } from '../src/lib/design-emit.mjs';

const SRC = 'design/ux.json';
const body = 'export const x = 1;\n';

test('a header round-trips, and the hash covers the body only', () => {
	const text = withHeader(body, { source: SRC });
	const parsed = parseHeader(text);
	assert.equal(parsed.body, body);
	assert.equal(parsed.source, SRC);
	assert.equal(parsed.hash, bodyHash(body));
	assert.ok(text.startsWith('// @generated'));
});

test('our own untouched file is a rewrite', () => {
	assert.equal(classify(withHeader(body, { source: SRC }), body), 'rewrite');
});

test('a hand-edited body is detected, however small the edit', () => {
	const text = withHeader(body, { source: SRC }).replace('const x = 1', 'const x = 2');
	assert.equal(classify(text, body), 'edited');
});

test('reformatting the header does not falsify the hash', () => {
	const text = withHeader(body, { source: SRC }).replace('Edit freely.', 'Edit  freely.');
	assert.equal(classify(text, body), 'rewrite');
});

test('a file we never wrote is foreign, not overwritten', () => {
	assert.equal(classify('export const x = 1;\n', body), 'foreign');
});

test('an absent file is a create', () => {
	assert.equal(classify(null, body), 'create');
});

test('routes map onto expo-router paths, dynamic segments included', () => {
	assert.equal(routeToFile('/'), 'app/index.tsx');
	assert.equal(routeToFile('/paywall'), 'app/paywall.tsx');
	assert.equal(routeToFile('/settings/notifications'), 'app/settings/notifications.tsx');
	assert.equal(routeToFile('/item/[id]'), 'app/item/[id].tsx');
});

test('a route that escapes the app directory is refused', () => {
	assert.throws(() => routeToFile('/../etc/passwd'), /route/);
});
