// A stand-in for sharp: a real (tiny) image pipeline over raw RGBA buffers.
//
// shipkit resolves sharp out of the *app* repo at call time, which is what
// makes this possible: the render tests point that lookup here. It is not a
// mock — PNGs are genuinely encoded and decoded (zlib, filter 0, 8-bit), and
// every operation the renderer uses moves real pixels, so geometry, masking,
// trimming and band measurement are all exercised for real. The one thing it
// cannot do is rasterise glyph outlines, so an SVG becomes the bounding box of
// the coordinates in its paths — see test/fixtures/native/fontkit, which emits
// rectangles for exactly that reason.
'use strict';
const zlib = require('node:zlib');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{width: number, height: number, channels: number, data: Buffer}} */
const blank = (width, height, channels, fill) => ({
	width, height, channels,
	data: Buffer.alloc(width * height * channels, fill ?? 0),
});

function crc32(buf) {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type, body) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
	return Buffer.concat([head, body, crc]);
}

function encodePng(img) {
	const { width, height, channels, data } = img;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
	const raw = Buffer.alloc(height * (1 + width * channels));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * channels)] = 0;
		data.copy(raw, y * (1 + width * channels) + 1, y * width * channels, (y + 1) * width * channels);
	}
	return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function decodePng(buf) {
	let at = 8;
	let width = 0, height = 0, channels = 4;
	const idat = [];
	while (at < buf.length) {
		const len = buf.readUInt32BE(at);
		const type = buf.toString('ascii', at + 4, at + 8);
		const body = buf.subarray(at + 8, at + 8 + len);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 1;
		} else if (type === 'IDAT') idat.push(body);
		at += 12 + len;
	}
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const data = Buffer.alloc(width * height * channels);
	for (let y = 0; y < height; y++)
		raw.copy(data, y * width * channels, y * (1 + width * channels) + 1, (y + 1) * (1 + width * channels));
	return { width, height, channels, data };
}

/** Every coordinate in an SVG's paths, reduced to the box they cover. */
function rasteriseSvg(text) {
	const width = Number(/width="(\d+(?:\.\d+)?)"/.exec(text)?.[1] ?? 1);
	const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(text)?.[1] ?? 1);
	const img = blank(Math.round(width), Math.round(height), 4, 0);
	const xs = [];
	const ys = [];
	for (const m of text.matchAll(/ d="([^"]+)"/g)) {
		const nums = (m[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
		for (let i = 0; i + 1 < nums.length; i += 2) {
			xs.push(nums[i]);
			ys.push(nums[i + 1]);
		}
	}
	if (!xs.length) return img;
	const x0 = Math.max(0, Math.floor(Math.min(...xs)));
	const x1 = Math.min(img.width, Math.ceil(Math.max(...xs)));
	const y0 = Math.max(0, Math.floor(Math.min(...ys)));
	const y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = (y * img.width + x) * 4;
			img.data[p] = 17;
			img.data[p + 1] = 17;
			img.data[p + 2] = 17;
			img.data[p + 3] = 255;
		}
	return img;
}

const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(PNG_SIG);
const isSvg = (buf) => Buffer.isBuffer(buf) && buf.toString('utf8', 0, 200).includes('<svg');

function toImage(input, opts = {}) {
	if (input && typeof input === 'object' && !Buffer.isBuffer(input) && input.create) {
		const { width, height, channels, background } = input.create;
		const img = blank(width, height, channels, 0);
		const bg = background ?? { r: 0, g: 0, b: 0, alpha: 0 };
		for (let p = 0; p < img.data.length; p += channels) {
			img.data[p] = bg.r ?? 0;
			img.data[p + 1] = bg.g ?? 0;
			img.data[p + 2] = bg.b ?? 0;
			if (channels === 4) img.data[p + 3] = Math.round((bg.alpha ?? 1) * 255);
		}
		return img;
	}
	if (typeof input === 'string') return decodePng(readFileSync(input));
	if (opts.raw) return { width: opts.raw.width, height: opts.raw.height, channels: opts.raw.channels, data: Buffer.from(input) };
	if (isSvg(input)) return rasteriseSvg(input.toString('utf8'));
	if (isPng(input)) return decodePng(input);
	throw new Error('fake sharp: unsupported input');
}

/** Nearest-neighbour resample — enough to prove the geometry, not the filter. */
function resize(img, w, h) {
	const out = blank(w, h, img.channels, 0);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
			const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
			img.data.copy(out.data, (y * w + x) * img.channels, (sy * img.width + sx) * img.channels, (sy * img.width + sx + 1) * img.channels);
		}
	return out;
}

function extract(img, { left, top, width, height }) {
	const out = blank(width, height, img.channels, 0);
	for (let y = 0; y < height; y++) {
		const sy = top + y;
		if (sy < 0 || sy >= img.height) continue;
		for (let x = 0; x < width; x++) {
			const sx = left + x;
			if (sx < 0 || sx >= img.width) continue;
			img.data.copy(out.data, (y * width + x) * img.channels, (sy * img.width + sx) * img.channels, (sy * img.width + sx + 1) * img.channels);
		}
	}
	return out;
}

function extend(img, { left = 0, top = 0, right = 0, bottom = 0 }) {
	const out = blank(img.width + left + right, img.height + top + bottom, img.channels, 0);
	for (let y = 0; y < out.height; y++)
		for (let x = 0; x < out.width; x++) {
			// extendWith: 'copy' — clamp to the edge, which is what the renderer relies on.
			const sx = Math.min(img.width - 1, Math.max(0, x - left));
			const sy = Math.min(img.height - 1, Math.max(0, y - top));
			img.data.copy(out.data, (y * out.width + x) * img.channels, (sy * img.width + sx) * img.channels, (sy * img.width + sx + 1) * img.channels);
		}
	return out;
}

function over(base, layer, left, top) {
	const bc = base.channels;
	for (let y = 0; y < layer.height; y++) {
		const by = top + y;
		if (by < 0 || by >= base.height) continue;
		for (let x = 0; x < layer.width; x++) {
			const bx = left + x;
			if (bx < 0 || bx >= base.width) continue;
			const lp = (y * layer.width + x) * layer.channels;
			const bp = (by * base.width + bx) * bc;
			const alpha = layer.channels === 4 ? layer.data[lp + 3] / 255 : 1;
			if (!alpha) continue;
			for (let ch = 0; ch < 3; ch++)
				base.data[bp + ch] = Math.round(layer.data[lp + ch] * alpha + base.data[bp + ch] * (1 - alpha));
			if (bc === 4) base.data[bp + 3] = Math.max(base.data[bp + 3], layer.data[lp + 3] ?? 255);
		}
	}
	return base;
}

/** The ink box, for trim(): anything that is neither transparent nor the corner colour. */
function inkBox(img) {
	const ch = img.channels;
	const corner = [img.data[0], img.data[1], img.data[2], ch === 4 ? img.data[3] : 255];
	let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) {
			const p = (y * img.width + x) * ch;
			const same = img.data[p] === corner[0] && img.data[p + 1] === corner[1] && img.data[p + 2] === corner[2] && (ch === 3 || img.data[p + 3] === corner[3]);
			if (same) continue;
			if (x < x0) x0 = x;
			if (y < y0) y0 = y;
			if (x > x1) x1 = x;
			if (y > y1) y1 = y;
		}
	if (x1 < 0) return { left: 0, top: 0, width: img.width, height: img.height };
	return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

class Pipeline {
	constructor(input, opts) {
		this.img = toImage(input, opts);
		this.trimmed = null;
	}
	resize(width, height) {
		this.img = resize(this.img, Math.round(width), Math.round(height));
		return this;
	}
	extend(opts) {
		this.img = extend(this.img, opts);
		return this;
	}
	extract(opts) {
		this.img = extract(this.img, opts);
		return this;
	}
	ensureAlpha() {
		if (this.img.channels === 4) return this;
		const out = blank(this.img.width, this.img.height, 4, 255);
		for (let i = 0, o = 0; i < this.img.data.length; i += 3, o += 4) {
			this.img.data.copy(out.data, o, i, i + 3);
			out.data[o + 3] = 255;
		}
		this.img = out;
		return this;
	}
	removeAlpha() {
		if (this.img.channels === 3) return this;
		const out = blank(this.img.width, this.img.height, 3, 0);
		for (let i = 0, o = 0; i < this.img.data.length; i += 4, o += 3) this.img.data.copy(out.data, o, i, i + 3);
		this.img = out;
		return this;
	}
	extractChannel(name) {
		const idx = { red: 0, green: 1, blue: 2, alpha: 3 }[name] ?? 0;
		const out = blank(this.img.width, this.img.height, 1, 0);
		for (let i = 0, o = 0; i < this.img.data.length; i += this.img.channels, o += 1) out.data[o] = this.img.data[i + idx];
		this.img = out;
		return this;
	}
	toColourspace() {
		return this;
	}
	composite(items) {
		this.pending = items;
		return this;
	}
	trim() {
		const box = inkBox(this.img);
		this.trimmed = { trimOffsetTop: -box.top, trimOffsetLeft: -box.left };
		this.img = extract(this.img, box);
		return this;
	}
	png() {
		return this;
	}
	#flatten() {
		for (const item of this.pending ?? []) {
			const layer = toImage(item.input, item);
			over(this.img, layer, item.left ?? 0, item.top ?? 0);
		}
		this.pending = null;
		return this.img;
	}
	raw() {
		this.wantRaw = true;
		return this;
	}
	async metadata() {
		const img = this.#flatten();
		return { width: img.width, height: img.height, channels: img.channels, format: 'png' };
	}
	async toBuffer(opts = {}) {
		const img = this.#flatten();
		const body = this.wantRaw ? img.data : encodePng(img);
		if (!opts.resolveWithObject) return body;
		return { data: body, info: { width: img.width, height: img.height, channels: img.channels, ...this.trimmed } };
	}
	async toFile(dest) {
		const img = this.#flatten();
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, encodePng(img));
		return { width: img.width, height: img.height, channels: img.channels };
	}
}

const sharp = (input, opts) => new Pipeline(input, opts);
module.exports = sharp;
module.exports.default = sharp;
