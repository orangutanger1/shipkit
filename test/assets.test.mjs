// Screenshot measurement, OTA safety classification, and RevenueCat payload
// shape — the three places where a wrong answer is silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImageSize } from '../src/commands/shots.mjs';
import { isNativeDep } from '../src/lib/native.mjs';
import { bundleOf } from '../src/lib/revenuecat.mjs';

/** Minimal but real PNG: signature + IHDR length/type/width/height. */
function png(width, height) {
	const buf = Buffer.alloc(33);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0x0d0a1a0a, 4);
	buf.writeUInt32BE(13, 8);
	buf.write('IHDR', 12, 'ascii');
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

/** JPEG with one skippable APP0 segment before the SOF0 frame header. */
function jpeg(width, height) {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
	const sof = Buffer.alloc(11);
	sof.writeUInt16BE(0xffc0, 0);
	sof.writeUInt16BE(9, 2); // segment length
	sof.writeUInt8(8, 4); // precision
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

test('PNG dimensions come from IHDR', () => {
	assert.deepEqual(readImageSize(png(1242, 2688)), { width: 1242, height: 2688, format: 'png' });
});

test('JPEG dimensions come from the frame header, past other segments', () => {
	assert.deepEqual(readImageSize(jpeg(1170, 2532)), { width: 1170, height: 2532, format: 'jpeg' });
});

test('a landscape capture is not silently transposed', () => {
	// Apple treats 2688x1242 and 1242x2688 as different display slots.
	assert.deepEqual(readImageSize(png(2688, 1242)), { width: 2688, height: 1242, format: 'png' });
});

test('non-images and truncated headers measure as null, never as zero', () => {
	assert.equal(readImageSize(Buffer.from('not an image')), null);
	assert.equal(readImageSize(Buffer.alloc(0)), null);
	assert.equal(readImageSize(png(100, 100).subarray(0, 18)), null);
});

test('native packages are recognised by prefix and by name', () => {
	for (const name of ['expo', 'react-native', 'expo-router', 'react-native-svg', '@react-native-google-signin/google-signin', '@sentry/react-native'])
		assert.equal(isNativeDep(name), true, `${name} should be native`);
});

test('pure-JS packages do not force a rebuild', () => {
	// `react` starts with neither prefix but is on the allow-list; `zod` matches
	// nothing. Misclassifying either turns every dependency bump into a build.
	for (const name of ['react', 'react-dom', 'typescript', 'zod', 'zustand', '@tanstack/react-query', 'nativewind'])
		assert.equal(isNativeDep(name), false, `${name} should be pure JS`);
});

test('bundleOf reads the nested v2 shape, the flat shape, and neither', () => {
	// The nested shape is what the live API returns; reading only the flat one
	// made the paywall bundle-mismatch gate pass on a mismatched project.
	assert.equal(bundleOf({ type: 'app_store', app_store: { bundle_id: 'com.a' } }), 'com.a');
	assert.equal(bundleOf({ type: 'app_store', bundle_id: 'com.b' }), 'com.b');
	assert.equal(bundleOf({ type: 'test_store' }), '');
	assert.equal(bundleOf(undefined), '');
});
