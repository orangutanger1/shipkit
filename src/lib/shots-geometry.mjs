// Pure geometry + measurement for screenshot rendering — no sharp, no I/O.
// Everything here is decided from the spec and pixel buffers alone.
import { captionRuns } from './shots-spec.mjs';
import { fitCaption } from './shots-type.mjs';
import { ShipError } from '../log.mjs';

/** An 8-bit RGB triple. */
/** @typedef {{r: number, g: number, b: number}} RGB */

/** The bounding box of the ink found in a band, in canvas pixels. */
/** @typedef {{top: number, bot: number, left: number, right: number, width: number, height: number}} InkBox */

/** Vertical extent of a caption band. */
/** @typedef {{y0: number, y1: number}} BandBounds */

/**
 * #rrggbb → sharp's background object.
 * @param {string|undefined} hex
 * @returns {{r: number, g: number, b: number, alpha: number}}
 */
export function parseColour(hex) {
	const m = /^#?([\da-f]{6})$/i.exec(String(hex ?? ''));
	if (!m) throw new ShipError(`not a colour: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

/** @param {import('./shots-spec.mjs').ShotSpec} spec @param {string} locale @returns {boolean} */
const perCharacter = (spec, locale) => spec.type.perCharacterLocales.includes(locale);

/**
 * Vertical room a caption may occupy: to the mockup, or to the canvas edge.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @returns {number|null} null in caption-band mode, which repaints in place.
 */
export function captionBudget(spec, frame) {
	const { gap } = spec.type;
	const box = frame.caption;
	if (spec.mode === 'caption-band') return null;
	const phoneTop = frame.phone?.y ?? 0;
	return box.y < phoneTop ? phoneTop - box.y - gap : spec.canvas.h - box.y - gap;
}

/**
 * Line counts the source locale settles on. Every other locale aims at these so
 * the set reads with one rhythm, shrinking only when a long string demands it.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').Captions} captions
 * @param {string} sourceLocale
 * @param {(locale: string) => import('./shots-type.mjs').Font} loadFont
 * @returns {Record<string, number>}
 */
export function sourceLineCounts(spec, captions, sourceLocale, loadFont) {
	const copy = captions[sourceLocale];
	if (!copy) throw new ShipError(`no caption copy for source locale ${sourceLocale}`);
	const font = loadFont(sourceLocale);
	/** @type {Record<string, number>} */
	const out = {};
	for (const frame of spec.frames) {
		const runs = captionRuns(copy[frame.key]);
		if (!runs) throw new ShipError(`${sourceLocale}: no caption for frame ${frame.key}`);
		// The headline alone sets the rhythm every locale aims at. A subtitle is
		// fitted per frame against whatever the headline leaves, so it has no
		// target line count of its own.
		out[frame.key] =
			fitCaption(font, runs.headline, {
				box: frame.caption,
				budget: captionBudget(spec, frame) ?? Infinity,
				type: spec.type,
				perCharacter: perCharacter(spec, sourceLocale),
			}).lines.length + spec.type.extraLines;
	}
	return out;
}

/**
 * Band bounds: everything between the canvas edge and the mockup, less clearance.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @returns {BandBounds}
 */
export function bandBounds(spec, frame) {
	const { clearance } = spec.band;
	return frame.mockTop > 0
		? { y0: 0, y1: Math.round(frame.mockTop) - clearance }
		: { y0: Math.round(frame.mockTop + frame.mockH) + clearance, y1: spec.canvas.h };
}

/**
 * Most common RGB colour in the band, and its share of all pixels.
 * @param {{data: Buffer, width: number, channels: number}} band
 * @param {number} y0
 * @param {number} y1
 * @returns {{bg: RGB, best: number, total: number}}
 */
function dominantColour({ data, width, channels }, y0, y1) {
	/** @type {Map<number, number>} */
	const counts = new Map();
	for (let y = y0; y < y1; y += 1)
		for (let x = 0; x < width; x += 1) {
			const p = (y * width + x) * channels;
			const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	let best = 0;
	let bestKey = 0;
	let total = 0;
	for (const [key, n] of counts) {
		total += n;
		if (n > best) {
			best = n;
			bestKey = key;
		}
	}
	return {
		bg: { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255 },
		best,
		total,
	};
}

/**
 * Bounding box of pixels that differ from the band background by > inkTolerance.
 * @param {{data: Buffer, width: number, channels: number}} band
 * @param {number} y0
 * @param {number} y1
 * @param {RGB} bg
 * @param {number} inkTolerance
 * @returns {InkBox|null}
 */
function inkBox({ data, width, channels }, y0, y1, bg, inkTolerance) {
	let top = Infinity;
	let bot = -Infinity;
	let left = Infinity;
	let right = -Infinity;
	for (let y = y0; y < y1; y += 1)
		for (let x = 0; x < width; x += 1) {
			const p = (y * width + x) * channels;
			const d = Math.max(
				Math.abs(data[p] - bg.r),
				Math.abs(data[p + 1] - bg.g),
				Math.abs(data[p + 2] - bg.b),
			);
			if (d <= inkTolerance) continue;
			if (y < top) top = y;
			if (y > bot) bot = y;
			if (x < left) left = x;
			if (x > right) right = x;
		}
	return Number.isFinite(top) ? { top, bot, left, right, width: right - left, height: bot - top } : null;
}

/**
 * Where the glass sits on the canvas for one frame: phone offset + screen group.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function glassRect(spec, frame) {
	const g = spec.device.screenGroup;
	return {
		left: Math.round(frame.phone.x + g.x),
		top: Math.round(frame.phone.y + g.y),
		width: Math.round(g.w),
		height: Math.round(g.h),
	};
}

/**
 * The full-width strip a fitted caption occupies, with slack for descenders.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @param {import('./shots-type.mjs').Fit} fit
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function captionRect(spec, frame, fit) {
	const slack = Math.round(spec.type.lineHeight / 4);
	return {
		left: 0,
		top: Math.round(frame.caption.y - slack),
		width: spec.canvas.w,
		height: Math.round(fit.lines.length * fit.lineHeight + 2 * slack),
	};
}

/**
 * Output filename for a frame: numbered so ASC keeps the designed order.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @param {number} index
 * @returns {string}
 */
export const frameFile = (spec, frame, index) =>
	frame.out ?? (spec.mode === 'device-frame' ? frame.src : `${String(index + 1).padStart(2, '0')}-${frame.key}.png`);

/**
 * Measure a band on the base composite: its background colour, how flat it is,
 * and where the source-locale ink sits.
 *
 * `flat` is the safety gate. A band that is not overwhelmingly one colour holds
 * artwork, and repainting it destroys pixels — so this reports the number and
 * the caller refuses below the threshold. Nothing here guesses.
 * @param {{data: Buffer, width: number, channels: number}} buffer
 * @param {BandBounds} bounds
 * @param {number} inkTolerance
 * @returns {{bg: RGB, flat: number, ink: InkBox|null}}
 */
export function measureBand(buffer, bounds, inkTolerance) {
	const { y0, y1 } = bounds;
	const { bg, best, total } = dominantColour(buffer, y0, y1);
	return {
		bg,
		flat: total ? best / total : 1,
		ink: inkBox(buffer, y0, y1, bg, inkTolerance),
	};
}
