// Caption typesetting: wrapping, size fitting, and glyph outlines.
//
// Captions are rendered as vector outlines pulled from the font file, never as
// text handed to a rasteriser. Two reasons, both learned the hard way:
//   * a font *lookup* (family name → file) resolves differently on a CI runner
//     than on the machine that approved the design, and silently substitutes;
//   * the face matters more than the weight name. The variable Oswald at
//     wght=600 is not the static SemiBold — its space advance is wider, which
//     drifted caption widths ~14px against the Figma reference.
// Outlines from an explicit file cannot do either.
//
// Everything here takes an injected font object (fontkit's shape) so the layout
// maths is testable without a binary dependency.

/**
 * The slice of fontkit's font the typesetter uses. Injected so the layout maths
 * is testable without the binary dependency.
 * @typedef {Object} Font
 * @property {number} unitsPerEm
 * @property {number} ascent
 * @property {number} descent
 * @property {(text: string) => GlyphRun} layout
 */

/** A shaped run: its total advance and its positioned glyphs. */
/** @typedef {{advanceWidth: number, glyphs: Glyph[]}} GlyphRun */

/** One positioned glyph: its advance and its outline. */
/** @typedef {{advanceWidth: number, path: GlyphPath}} Glyph */

/**
 * A fontkit path: transformable, and serialisable to SVG path data.
 * @typedef {Object} GlyphPath
 * @property {(x: number, y: number) => GlyphPath} scale
 * @property {(x: number, y: number) => GlyphPath} translate
 * @property {() => string} toSVG
 */

/** The caption box the fitter wraps into: the centre to stay on, the width to wrap in. */
/** @typedef {{centre: number, wrap: number}} TypeBox */

/**
 * The ramp the fitter steps through: design size, floors, decrement, and which
 * wrap algorithm reproduces the design.
 * @typedef {{size: number, lineHeight: number, wrap: 'balanced'|'greedy', targetMinSize: number, minSize: number, step: number}} TypeRamp
 */

/**
 * The type block plus what only the layout driver needs: ink colour and the
 * optional subtitle ramp. A full spec type block satisfies this.
 * @typedef {TypeRamp & {colour: string, subtitle: import('./shots-spec.mjs').SpecSubtitle|null}} LayoutType
 */

/**
 * One fitted caption: the wrapped lines, the size they settled at, the line
 * height that follows, and whether an explicit newline was honoured verbatim.
 * @typedef {Object} Fit
 * @property {string[]} lines
 * @property {number} size
 * @property {number} lineHeight
 * @property {boolean} forced
 */

/**
 * One run as the SVG writer consumes it. `top` may be unresolved (null) on the
 * single-run path, where the writer falls back to the box's own top.
 * @typedef {{fit: Fit, colour: string, top: number|null, font?: Font}} CaptionRunInput
 */

/** A run inside {@link layoutCaption}'s result, with its position resolved. */
/** @typedef {{fit: Fit, colour: string, top: number, font: Font}} CaptionRun */

/**
 * The full layout of one caption: the runs to paint, the headline fit callers
 * position the block by, the subtitle fit when one survived, and the height.
 * @typedef {{runs: CaptionRun[], fit: Fit, subtitle: Fit|null, height: number}} LayoutResult
 */

/** Font metrics scale for a given pixel size. */
/** @param {Font} font @param {number} size @returns {number} */
const scaleFor = (font, size) => size / font.unitsPerEm;

/**
 * Baseline of the first line inside a line box, matching how a design tool
 * centres the em box in the line height rather than sitting text on the top.
 * @param {Font} font
 * @param {number} size
 * @param {number} lineHeight
 * @returns {number}
 */
function firstBaseline(font, size, lineHeight) {
	const s = scaleFor(font, size);
	const ascent = font.ascent * s;
	const descent = font.descent * s;
	return (lineHeight - (ascent - descent)) / 2 + ascent;
}

/**
 * @param {Font} font
 * @param {string} text
 * @param {number} size
 * @returns {number}
 */
function runWidth(font, text, size) {
	return font.layout(text).advanceWidth * scaleFor(font, size);
}

/**
 * Greedy wrap — fill each line until the next token will not fit.
 * This is what Figma does, so it is what reproduces a designer's line breaks.
 * @param {Font} font
 * @param {string[]} tokens
 * @param {string} joiner
 * @param {number} size
 * @param {number} maxWidth
 * @returns {string[]|null}
 */
export function wrapGreedy(font, tokens, joiner, size, maxWidth) {
	const lines = [];
	let cur = '';
	for (const t of tokens) {
		const cand = cur ? cur + joiner + t : t;
		if (cur && runWidth(font, cand, size) > maxWidth) {
			lines.push(cur);
			cur = t;
		} else cur = cand;
	}
	if (cur) lines.push(cur);
	const out = lines.map((l) => l.trim()).filter(Boolean);
	return out.some((l) => runWidth(font, l, size) > maxWidth) ? null : out;
}

/**
 * Balanced wrap — the fewest lines greedy could achieve, then the split of that
 * line count minimising summed squared slack, so no line is left holding one
 * orphan word. Returns null when a single token cannot fit at this size.
 * @param {Font} font
 * @param {string[]} tokens
 * @param {string} joiner
 * @param {number} size
 * @param {number} maxWidth
 * @returns {string[]|null}
 */
export function wrapBalanced(font, tokens, joiner, size, maxWidth) {
	const widths = tokens.map((t) => runWidth(font, t, size));
	if (widths.some((w) => w > maxWidth)) return null;
	const sep = joiner ? runWidth(font, joiner, size) : 0;

	/** @param {number} i @param {number} j @returns {number} */
	const span = (i, j) => {
		let w = 0;
		for (let k = i; k <= j; k += 1) w += widths[k];
		return w + sep * (j - i);
	};

	// Minimum feasible line count: greedy is optimal for that one metric.
	let min = 1;
	let cur = 0;
	for (let i = 0; i < tokens.length; i += 1) {
		const next = cur ? cur + sep + widths[i] : widths[i];
		if (next <= maxWidth) cur = next;
		else {
			min += 1;
			cur = widths[i];
		}
	}

	const N = tokens.length;
	const cost = Array.from({ length: min + 1 }, () => Array.from({ length: N + 1 }, () => Infinity));
	const cut = Array.from({ length: min + 1 }, () => Array.from({ length: N + 1 }, () => -1));
	cost[0][0] = 0;
	for (let l = 1; l <= min; l += 1) {
		for (let j = l; j <= N; j += 1) {
			for (let i = l - 1; i < j; i += 1) {
				if (cost[l - 1][i] === Infinity) continue;
				const w = span(i, j - 1);
				if (w > maxWidth) continue;
				const slack = maxWidth - w;
				const c = cost[l - 1][i] + slack * slack;
				if (c < cost[l][j]) {
					cost[l][j] = c;
					cut[l][j] = i;
				}
			}
		}
	}
	if (cost[min][N] === Infinity) return null;

	const lines = [];
	for (let l = min, j = N; l > 0; l -= 1) {
		const i = cut[l][j];
		lines.unshift(tokens.slice(i, j).join(joiner));
		j = i;
	}
	return lines;
}

/**
 * Characters that may not open a line — Japanese and Korean kinsoku shori.
 * Breaking before one is a typographic error a reader notices immediately: it
 * strands a full stop or a closing bracket alone at the head of a line, which
 * is what a two-line CJK subtitle does the moment its last character lands on
 * a boundary.
 */
const NO_LINE_START = '。、，．！？：；）］｝〉》」』】〕・ー〜…';

/**
 * Split a caption into wrappable tokens. CJK captions carry no spaces.
 * @param {string} text
 * @param {{perCharacter?: boolean}} [opts]
 * @returns {{tokens: string[], joiner: string}}
 */
export function tokenise(text, { perCharacter = false } = {}) {
	const t = text.trim();
	if (perCharacter && !/\s/.test(t)) {
		const tokens = [];
		for (const ch of t) {
			if (tokens.length && NO_LINE_START.includes(ch)) tokens[tokens.length - 1] += ch;
			else tokens.push(ch);
		}
		return { tokens, joiner: '' };
	}
	return { tokens: t.split(/\s+/).filter(Boolean), joiner: ' ' };
}

/**
 * Choose lines and a size for one caption.
 *
 * Preference order:
 *   1. the design's own size at the source locale's line count;
 *   2. step down (line height held proportional) to reach that line count, so
 *      every locale reads at one rhythm;
 *   3. failing that, more lines at the largest size that fits.
 *
 * An explicit newline in the copy is honoured verbatim and never re-wrapped —
 * that is how the source locale reproduces the approved design exactly.
 *
 * @throws when nothing down to `minSize` fits; a clipped caption is worse than
 *         a failed build.
 * @param {Font} font
 * @param {string} text
 * @param {{box: TypeBox, budget: number, targetLines?: number|null, type: TypeRamp, perCharacter?: boolean}} opts
 * @returns {Fit}
 */
export function fitCaption(font, text, { box, budget, targetLines = null, type, perCharacter = false }) {
	const ratio = type.lineHeight / type.size;
	/** @param {number} size @returns {number} */
	const lhOf = (size) => size * ratio;
	const maxWidth = box.wrap;
	const wrapFn = type.wrap === 'greedy' ? wrapGreedy : wrapBalanced;
	/** @param {string[]|null} lines @param {number} size @returns {boolean|null} */
	const fits = (lines, size) => lines && lines.length * lhOf(size) <= budget;

	if (text.includes('\n')) {
		const forced = text
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		for (let size = type.size; size >= type.minSize; size -= type.step) {
			const over = forced.some((l) => runWidth(font, l, size) > maxWidth);
			if (!over && fits(forced, size)) return { lines: forced, size, lineHeight: lhOf(size), forced: true };
		}
		throw new Error(`forced caption will not fit: ${JSON.stringify(text)}`);
	}

	const { tokens, joiner } = tokenise(text, { perCharacter });

	if (targetLines) {
		for (let size = type.size; size >= type.targetMinSize; size -= type.step) {
			const lines = wrapFn(font, tokens, joiner, size, maxWidth);
			if (fits(lines, size) && lines && lines.length <= targetLines)
				return { lines, size, lineHeight: lhOf(size), forced: false };
		}
	}
	for (let size = type.size; size >= type.minSize; size -= type.step) {
		const lines = wrapFn(font, tokens, joiner, size, maxWidth);
		if (lines && fits(lines, size)) return { lines, size, lineHeight: lhOf(size), forced: false };
	}
	throw new Error(`caption will not fit: ${JSON.stringify(text)}`);
}

/**
 * @param {Font} font
 * @param {Fit} fit
 * @param {TypeBox} box
 * @param {number} y0
 * @returns {string[]}
 */
function runPaths(font, fit, box, y0) {
	const { lines, size, lineHeight } = fit;
	const s = scaleFor(font, size);
	const base = firstBaseline(font, size, lineHeight);
	/** @type {string[]} */
	const paths = [];
	lines.forEach((line, i) => {
		const run = font.layout(line);
		const y = y0 + base + i * lineHeight;
		let pen = box.centre - (run.advanceWidth * s) / 2;
		for (const glyph of run.glyphs) {
			const d = glyph.path.scale(s, -s).translate(pen, y).toSVG();
			if (d) paths.push(`<path d="${d}"/>`);
			pen += glyph.advanceWidth * s;
		}
	});
	return paths;
}

/**
 * Glyph outlines for a fitted caption, as an SVG document sized to the canvas.
 * Lines are centred on the box centre, which is what every one of these designs
 * does and what keeps a longer localized string from drifting off-axis.
 *
 * `fit` is either one fit (the single-run call, unchanged) or an array of runs
 * `{ fit, colour, top, font? }`. Each run becomes its own `<g fill>`, because a
 * headline and its subtitle are set in different colours; a single group could
 * only paint one of them. A one-element array emits byte-identical SVG to the
 * single-run call, so nothing about the existing pipeline moves.
 * @param {Font} font
 * @param {Fit|CaptionRunInput[]} fit
 * @param {{box: import('./shots-spec.mjs').CaptionBox, canvas: import('./shots-spec.mjs').Canvas, colour: string, top?: number|null}} opts
 * @returns {string}
 */
export function captionSvg(font, fit, { box, canvas, colour, top = null }) {
	const runs = Array.isArray(fit) ? fit : [{ fit, colour, top }];
	const groups = runs.map(
		(r) => `<g fill="${r.colour}">${runPaths(r.font ?? font, r.fit, box, r.top ?? box.y).join('')}</g>`,
	);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.w}" height="${canvas.h}">` +
		`${groups.join('')}</svg>`
	);
}

/** Height of one fitted run's line boxes. */
/** @param {Fit} fit @returns {number} */
const blockHeight = (fit) => fit.lines.length * fit.lineHeight;

/**
 * The type ramp a subtitle is fitted with, derived from its spec block.
 * @param {import('./shots-spec.mjs').SpecSubtitle} subtitle
 * @param {TypeRamp} type
 * @returns {TypeRamp}
 */
const subtitleRamp = (subtitle, type) => ({
	size: subtitle.size,
	lineHeight: subtitle.lineHeight,
	// The subtitle breaks with the same algorithm as the headline: `wrap` is a
	// statement about which design tool authored the art, not a per-run taste.
	wrap: type.wrap,
	targetMinSize: subtitle.minSize,
	minSize: subtitle.minSize,
	step: subtitle.step,
});

/**
 * Lay out a caption as one or two runs.
 *
 * With no `type.subtitle` in the spec, or no subtitle string for this frame,
 * this is exactly the old single-run fit and the returned run sits at top 0 —
 * every existing app renders unchanged.
 *
 * With both, the headline is fitted into the budget less the room the subtitle
 * needs, then the subtitle into what is left. `gap` is measured baseline to
 * baseline: from the headline's last baseline to the subtitle's first, which is
 * how a design tool spaces two stacked text layers.
 *
 * A subtitle that will not fit even at its `minSize` is dropped and the
 * headline re-fitted at the full budget — a cramped subtitle reads worse than
 * no subtitle — and `onDrop` is called so the drop is reported, not silent.
 * @param {Font} font
 * @param {{headline: string, subtitle?: string|null}} copy
 * @param {{box: TypeBox, budget: number, targetLines?: number|null, type: LayoutType, perCharacter?: boolean, subtitleFont?: Font|null, onDrop?: ((text: string) => void)|null}} opts
 * @returns {LayoutResult}
 */
export function layoutCaption(
	font,
	{ headline, subtitle },
	{ box, budget, targetLines = null, type, perCharacter = false, subtitleFont = null, onDrop = null },
) {
	/** @param {number} b @returns {Fit} */
	const fitHeadline = (b) =>
		fitCaption(font, headline, { box, budget: b, targetLines, type, perCharacter });

	/** @returns {LayoutResult} */
	const single = () => {
		const fit = fitHeadline(budget);
		return { runs: [{ fit, colour: type.colour, top: 0, font }], fit, subtitle: null, height: blockHeight(fit) };
	};
	if (!type.subtitle || !subtitle) return single();

	const st = type.subtitle;
	const sFont = subtitleFont ?? font;
	const ramp = subtitleRamp(st, type);
	const gap = st.gap;

	// Reserve: how much *further than its own last line box* the headline pushes
	// the block down once the subtitle is under it, at both runs' design sizes.
	// Not `subtitle height + gap`: the gap is baseline to baseline, so it already
	// contains the headline's last descender and the subtitle's ascent. Charging
	// the headline for those twice shrinks it for room nothing needs — it cost
	// glovebox's frames two of their four headlines at full size.
	const wrapFn = type.wrap === 'greedy' ? wrapGreedy : wrapBalanced;
	const { tokens, joiner } = tokenise(subtitle, { perCharacter });
	// A subtitle with explicit line breaks keeps them: per-character wrapping has
	// no idea where a Japanese phrase ends, so a copywriter who broke the line
	// themselves has said something the fitter cannot work out.
	const estLines = subtitle.includes('\n')
		? subtitle.split('\n').filter((l) => l.trim()).length
		: (wrapFn(sFont, tokens, joiner, st.size, box.wrap)?.length ?? 1);
	const reserve = Math.max(
		0,
		firstBaseline(font, type.size, type.lineHeight) -
			type.lineHeight +
			gap -
			firstBaseline(sFont, st.size, st.lineHeight) +
			estLines * st.lineHeight,
	);

	/** @type {Fit|null} */
	let head;
	try {
		head = fitHeadline(Math.max(0, budget - reserve));
	} catch {
		head = null;
	}

	if (head) {
		// Where the subtitle's line boxes start, given the headline that actually
		// fitted: its last baseline, plus the gap, back off the subtitle's own
		// first baseline within its line box.
		const lastBaseline = firstBaseline(font, head.size, head.lineHeight) + (head.lines.length - 1) * head.lineHeight;
		const subTop = lastBaseline + gap - firstBaseline(sFont, st.size, st.lineHeight);
		try {
			const sub = fitCaption(sFont, subtitle, {
				box,
				budget: budget - subTop,
				type: ramp,
				perCharacter,
			});
			// Re-derive the top for the size the subtitle settled at: a shrunk
			// subtitle has a shorter first baseline than the one assumed above.
			const top = lastBaseline + gap - firstBaseline(sFont, sub.size, sub.lineHeight);
			return {
				runs: [
					{ fit: head, colour: type.colour, top: 0, font },
					{ fit: sub, colour: st.colour, top, font: sFont },
				],
				fit: head,
				subtitle: sub,
				height: top + blockHeight(sub),
			};
		} catch {
			/* falls through to the drop below */
		}
	}

	onDrop?.(subtitle);
	return single();
}
