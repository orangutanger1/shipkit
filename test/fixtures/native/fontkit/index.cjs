// A stand-in for fontkit: a monospaced font whose glyphs are rectangles.
//
// Every advance width is a whole number of ems, so a wrap decision is a string
// length and can be asserted exactly (test/shots-render.test.mjs uses the same
// trick with a hand-written font). Glyph outlines are real rectangles in
// absolute coordinates, which is what lets the fake sharp turn a caption SVG
// into an ink box with the position and height the typesetter chose.
'use strict';
const { existsSync } = require('node:fs');

const UNITS = 1000;
const ADVANCE = 600;

/** A rectangle glyph, carrying its transform until it is asked for SVG. */
const glyphPath = (sx = 1, sy = 1, dx = 0, dy = 0) => ({
	scale: (a, b) => glyphPath(sx * a, sy * (b ?? a), dx, dy),
	translate: (a, b) => glyphPath(sx, sy, dx + a, dy + b),
	toSVG() {
		// Font units: a box from the baseline up to the ascent.
		const x0 = dx;
		const y0 = dy;
		const x1 = dx + ADVANCE * sx;
		const y1 = dy + 700 * sy;
		const [top, bottom] = y0 < y1 ? [y0, y1] : [y1, y0];
		return `M${x0} ${top}L${x1} ${top}L${x1} ${bottom}L${x0} ${bottom}Z`;
	},
});

const font = {
	unitsPerEm: UNITS,
	ascent: 800,
	descent: -200,
	/** @param {string} text */
	layout(text) {
		const glyphs = [...text].map(() => ({ advanceWidth: ADVANCE, path: glyphPath() }));
		return { advanceWidth: glyphs.length * ADVANCE, glyphs };
	},
	getVariation() {
		return font;
	},
};

module.exports = {
	openSync(file) {
		if (!existsSync(file)) throw new Error(`fake fontkit: no such font ${file}`);
		return font;
	},
	create() {
		return font;
	},
};
