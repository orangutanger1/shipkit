// sRGB colour arithmetic, exactly as much as the design gates need: a hue, so
// "exactly one accent" is checkable, and WCAG contrast, so a theme's
// readability is a number rather than an opinion.
//
// WCAG 2.1 relative luminance and contrast, verbatim from the spec — the
// constants are not tunable and the formula is not approximated, because a
// gate that computes 4.4 as 4.6 is worse than no gate.

/** @typedef {{r: number, g: number, b: number}} Rgb */

/**
 * `#rrggbb` (or `#rgb`) to channels 0-255. Null for anything else, so a caller
 * reports "not a colour" rather than silently gating against black.
 * @type {(hex: unknown) => Rgb|null}
 */
export function parseHex(hex) {
	const s = String(hex ?? '').trim();
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
	if (!m) return null;
	const d = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1];
	return { r: parseInt(d.slice(0, 2), 16), g: parseInt(d.slice(2, 4), 16), b: parseInt(d.slice(4, 6), 16) };
}

/** @type {(channel: number) => number} */
const linearize = (channel) => {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 * @type {(rgb: Rgb) => number}
 */
export const luminance = ({ r, g, b }) => 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

/**
 * Contrast ratio between two hex colours, 1 to 21. Null when either side is
 * unparseable — the caller already has a better message for that.
 * @type {(a: unknown, b: unknown) => number|null}
 */
export function contrast(a, b) {
	const x = parseHex(a);
	const y = parseHex(b);
	if (!x || !y) return null;
	const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
	return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Hue in degrees, 0-359. Null for greys: an achromatic colour has no hue, and
 * returning 0 for it would let a grey satisfy "the accent hue is 0".
 * @type {(hex: unknown) => number|null}
 */
export function hueOf(hex) {
	const rgb = parseHex(hex);
	if (!rgb) return null;
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const span = max - min;
	if (span === 0) return null;
	const h = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
	return Math.round(h * 60 + 360) % 360;
}

/**
 * Shortest distance between two hues on the circle, so 350° and 10° are 20
 * apart rather than 340.
 * @type {(a: number, b: number) => number}
 */
export function hueDistance(a, b) {
	const d = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360));
	return Math.min(d, 360 - d);
}
