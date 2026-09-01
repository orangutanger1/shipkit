// Image dimensions straight out of the file header. No image library, no
// `file(1)`, no trusting the filename — the only number that matters is the
// one Apple's uploader will read.

/**
 * PNG: fixed layout, IHDR is always the first chunk, so width/height are
 * big-endian uint32 at byte 16 and 20.
 * JPEG: variable — walk the segment chain from the SOI until a Start-Of-Frame
 * marker, whose payload carries precision, height, then width as uint16.
 * @param {Buffer} buffer
 * @returns {{width:number, height:number, format:'png'|'jpeg'}|null}
 */
export function readImageSize(buffer) {
	if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
	}
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		// Every SOFn except C4 (huffman tables), C8 (reserved) and CC (arithmetic
		// coding conditioning) — those three share the Cx range but are not frames.
		const SOF = new Set([
			0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
		]);
		let i = 2;
		while (i + 1 < buffer.length) {
			if (buffer[i] !== 0xff) {
				i += 1; // resync: some encoders pad between segments
				continue;
			}
			const marker = buffer[i + 1];
			if (marker === 0xff) {
				i += 1; // fill byte
				continue;
			}
			// Standalone markers carry no length payload.
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
				i += 2;
				continue;
			}
			if (i + 3 >= buffer.length) break;
			const length = buffer.readUInt16BE(i + 2);
			if (SOF.has(marker)) {
				if (i + 9 > buffer.length) break;
				return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5), format: 'jpeg' };
			}
			if (length < 2) break;
			i += 2 + length;
		}
	}
	return null;
}
