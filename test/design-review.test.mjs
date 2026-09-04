import assert from 'node:assert/strict';
import test from 'node:test';
import { EXCEPTIONS, reviewSources } from '../src/lib/design-review.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const scan = (source, path = 'app/home.tsx') => reviewSources([{ path, source }], DEFAULT_SYSTEM);
const kinds = (source, path) => scan(source, path).map((v) => v.kind);

test('a screen that builds its own StyleSheet is caught', () => {
	assert.ok(kinds('const s = StyleSheet.create({ a: { flex: 1 } });').includes('stylesheet'));
});

test('an inline style with a numeric literal is caught', () => {
	assert.ok(kinds('<View style={{ padding: 13 }} />').includes('inline-style'));
});

test('importing a raw primitive into a screen is caught', () => {
	assert.ok(kinds("import { View, Text } from 'react-native';").includes('raw-primitive'));
});

test('a 3-digit hex is caught, which the old rule missed', () => {
	assert.ok(kinds("const c = '#abc';").includes('color'));
});

test('the documented exceptions do not fire', () => {
	for (const source of [
		'<View style={{ flex: 1 }} />',
		'<View style={{ opacity: 1 }} />',
		'<View style={{ borderWidth: 1 }} />',
		'<View style={{ zIndex: 0 }} />',
		'const h = StyleSheet.hairlineWidth;',
		"const p = Platform.select({ ios: 'a', android: 'b' });",
	]) assert.deepEqual(scan(source), [], source);
});

test('src/theme is where tokens legitimately become literals', () => {
	assert.deepEqual(scan("const c = '#abcdef';\nconst s = StyleSheet.create({});", 'src/theme/primitives.tsx'), []);
});

test('the exception list is data, so it can be reviewed', () => {
	assert.ok(Array.isArray(EXCEPTIONS.styleKeys));
	assert.ok(EXCEPTIONS.styleKeys.includes('flex'));
});
