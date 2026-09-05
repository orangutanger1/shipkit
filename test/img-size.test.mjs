// The JPEG segment walk, branch by branch. A screenshot is measured once and
// the number is sent to Apple, so every way this loop can exit early — a
// truncated length, a padded encoder, a marker that only looks like a frame —
// has to end in `null` rather than a plausible wrong size, and none of them
// may spin. `test/assets.test.mjs` covers the happy path through `shots`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readImageSize } from '../src/lib/img-size.mjs';

const SOI = [0xff, 0xd8];

/** An 11-byte SOFn frame header: length, precision, height, then width. */
function sof(width, height, marker = 0xc0) {
	const buf = Buffer.alloc(11);
	buf.writeUInt8(0xff, 0);
	buf.writeUInt8(marker, 1);
	buf.writeUInt16BE(9, 2);
	buf.writeUInt8(8, 4);
	buf.writeUInt16BE(height, 5);
	buf.writeUInt16BE(width, 7);
	return buf;
}

/** A skippable segment of `marker` whose payload is `payload` bytes of zero. */
function segment(marker, payload = 2) {
	return Buffer.concat([Buffer.from([0xff, marker]), lengthOf(payload), Buffer.alloc(payload)]);
}

function lengthOf(payload) {
	const buf = Buffer.alloc(2);
	buf.writeUInt16BE(payload + 2, 0);
	return buf;
}

/** Assemble a JPEG from raw byte runs, all of which follow the SOI. */
function jpegOf(...parts) {
	return Buffer.concat([Buffer.from(SOI), ...parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))]);
}

test('every SOFn marker that is a frame yields dimensions', () => {
	for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
		assert.deepEqual(
			readImageSize(jpegOf(sof(1170, 2532, marker))),
			{ width: 1170, height: 2532, format: 'jpeg' },
			`marker 0x${marker.toString(16)} should be read as a frame`,
		);
	}
});

test('the three Cx markers that are not frames are skipped, not measured', () => {
	// C4 huffman tables, C8 reserved, CC arithmetic conditioning. Reading one as
	// a frame would report table bytes as a pixel count.
	for (const marker of [0xc4, 0xc8, 0xcc]) {
		assert.deepEqual(
			readImageSize(jpegOf(segment(marker, 4), sof(640, 480))),
			{ width: 640, height: 480, format: 'jpeg' },
			`marker 0x${marker.toString(16)} should be skipped as a table`,
		);
	}
});

test('padding between segments is resynced past, not read as a marker', () => {
	// Some encoders leave non-0xff filler between segments.
	assert.deepEqual(readImageSize(jpegOf([0x00, 0x12, 0x34], sof(828, 1792))), {
		width: 828,
		height: 1792,
		format: 'jpeg',
	});
});

test('0xff fill bytes before a marker are consumed one at a time', () => {
	assert.deepEqual(readImageSize(jpegOf([0xff, 0xff, 0xff], sof(1284, 2778))), {
		width: 1284,
		height: 2778,
		format: 'jpeg',
	});
});

test('standalone markers carry no length payload and are stepped over', () => {
	// TEM (0x01) plus the restart markers and a nested SOI, none of which have a
	// length field to skip by. Reading a length here would desync the walk.
	for (const marker of [0x01, 0xd0, 0xd7, 0xd8, 0xd9]) {
		assert.deepEqual(
			readImageSize(jpegOf([0xff, marker], sof(750, 1334))),
			{ width: 750, height: 1334, format: 'jpeg' },
			`marker 0x${marker.toString(16)} should be treated as standalone`,
		);
	}
});

test('a segment that claims a length under two measures as null, never as a loop', () => {
	// length < 2 cannot even cover its own length field; advancing by it would
	// move backwards or stand still.
	for (const claimed of [0x0000, 0x0001]) {
		const bad = Buffer.from([0xff, 0xe0, claimed >> 8, claimed & 0xff]);
		assert.equal(readImageSize(jpegOf(bad, sof(640, 480))), null, `length ${claimed} should abort the walk`);
	}
});

test('a marker truncated before its length field measures as null', () => {
	assert.equal(readImageSize(jpegOf([0xff, 0xe0])), null);
	assert.equal(readImageSize(jpegOf([0xff, 0xe0, 0x00])), null);
});

test('a frame header cut short of its dimensions measures as null', () => {
	// The SOF marker and length arrive, the width does not. Anything but null
	// here would be dimensions read off the end of the buffer.
	const full = jpegOf(sof(1242, 2688));
	for (let cut = 4; cut < 9; cut += 1) assert.equal(readImageSize(full.subarray(0, 2 + cut)), null);
});

test('a segment length that runs off the end stops the walk', () => {
	assert.equal(readImageSize(jpegOf(Buffer.from([0xff, 0xe0, 0xff, 0xff]), sof(640, 480))), null);
});

test('a JPEG with no frame at all measures as null', () => {
	assert.equal(readImageSize(jpegOf(segment(0xe0, 4), segment(0xe1, 4))), null);
});

test('the SOI alone is not a measurable image', () => {
	assert.equal(readImageSize(Buffer.from(SOI)), null);
	assert.equal(readImageSize(Buffer.from([0xff])), null);
});

test('a PNG signature shorter than a full IHDR measures as null', () => {
	// The signature check needs 24 bytes before it may read width and height.
	const sig = Buffer.alloc(23);
	sig.writeUInt32BE(0x89504e47, 0);
	sig.writeUInt32BE(0x0d0a1a0a, 4);
	assert.equal(readImageSize(sig), null);
});

test('a file whose second signature word is wrong is not treated as a PNG', () => {
	const buf = Buffer.alloc(33);
	buf.writeUInt32BE(0x89504e47, 0);
	buf.writeUInt32BE(0xdeadbeef, 4);
	assert.equal(readImageSize(buf), null);
});
