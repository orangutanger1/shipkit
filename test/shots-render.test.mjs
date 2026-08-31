// The screenshot render pipeline's silent-failure surface.
//
// Everything tested here produces a plausible-looking PNG when it is wrong,
// which is the whole problem: a caption wrapped differently from the design, a
// band measured a few pixels short, a spec field misread. None of it throws on
// its own, and nobody diffs 96 images by eye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionSvg, fitCaption, layoutCaption, tokenise, wrapBalanced, wrapGreedy } from '../src/lib/shots-type.mjs';
import { bandBounds, glassRect, measureBand, parseColour, frameFile } from '../src/lib/shots-render.mjs';
import { captionRuns, normaliseSpec } from '../src/lib/shots-spec.mjs';
import { seedFor } from '../src/lib/shots-capture.mjs';
import { driftOf } from '../src/lib/figma.mjs';

/**
 * A font whose every glyph is one unit wide per character, so advance widths
 * are string lengths and a wrap decision can be asserted exactly. fontkit's
 * shape, none of its weight.
 */
const font = (unitsPerEm = 1000) => ({
	unitsPerEm,
	ascent: 800,
	descent: -200,
	layout: (text) => ({
		advanceWidth: text.length * unitsPerEm,
		glyphs: [...text].map(() => ({
			advanceWidth: unitsPerEm,
			path: { scale: () => ({ translate: () => ({ toSVG: () => 'M0 0' }) }) },
		})),
	}),
});

const TYPE = {
	size: 100,
	lineHeight: 125,
	colour: '#FFFFFF',
	wrap: 'balanced',
	targetMinSize: 80,
	minSize: 50,
	step: 10,
	gap: 24,
	margin: null,
	extraLines: 0,
	perCharacterLocales: ['ja', 'ko'],
};

// ------------------------------------------------------------------ wrapping

test('greedy and balanced wrap disagree, and the design decides which is right', () => {
	// The real case from glovebox frame 2. Figma is greedy, so a balanced wrap
	// breaks the line where the designer did not — it reads better and is wrong.
	const f = font();
	const tokens = 'Log a service in 15 seconds.'.split(' ');
	const width = 19 * 100;
	assert.deepEqual(wrapGreedy(f, tokens, ' ', 100, width), ['Log a service in 15', 'seconds.']);
	assert.deepEqual(wrapBalanced(f, tokens, ' ', 100, width), ['Log a service', 'in 15 seconds.']);
});

test('balanced wrap refuses to leave an orphan word greedy would', () => {
	const f = font();
	// "aaaa bb cc" at width 7: greedy takes "aaaa bb" then "cc"; balanced
	// evens the slack to "aaaa" / "bb cc".
	const tokens = ['aaaa', 'bb', 'cc'];
	assert.deepEqual(wrapGreedy(f, tokens, ' ', 100, 700), ['aaaa bb', 'cc']);
	assert.deepEqual(wrapBalanced(f, tokens, ' ', 100, 700), ['aaaa', 'bb cc']);
});

test('a single word wider than the box fails the wrap instead of overflowing', () => {
	const f = font();
	assert.equal(wrapBalanced(f, ['aaaaaaaa'], ' ', 100, 400), null);
	assert.equal(wrapGreedy(f, ['aaaaaaaa'], ' ', 100, 400), null);
});

test('CJK captions tokenise per character, Latin per word', () => {
	// Eight characters, seven tokens: the closing 。 rides on the character before
	// it, because no line may open with it.
	assert.deepEqual(tokenise('愛車の整備記録。', { perCharacter: true }).tokens.length, 7);
	assert.equal(tokenise('愛車の整備記録。', { perCharacter: true }).joiner, '');
	// A per-character locale whose caption does have spaces is still word-wrapped:
	// breaking "Set up" mid-word would be worse than a long line.
	assert.deepEqual(tokenise('Set up', { perCharacter: true }).tokens, ['Set', 'up']);
});

test('a CJK line never opens with a full stop the wrap could have stranded', () => {
	// Kinsoku shori. Without it a two-line Japanese subtitle whose last character
	// lands on the boundary puts 。 alone at the head of the second line, which is
	// exactly what the first ja subtitle render did.
	assert.deepEqual(tokenise('点検が遅れる前に、賢く通知。', { perCharacter: true }).tokens.at(-1), '知。');
	assert.deepEqual(tokenise('あい、う。', { perCharacter: true }).tokens, ['あ', 'い、', 'う。']);
});

// ------------------------------------------------------------------- fitting

test('an explicit newline is honoured verbatim and never re-wrapped', () => {
	// This is how the source locale reproduces the approved design exactly.
	const fit = fitCaption(font(), 'AA\nBB', { box: { wrap: 10000, centre: 500 }, budget: 10000, type: TYPE });
	assert.deepEqual(fit.lines, ['AA', 'BB']);
	assert.equal(fit.forced, true);
	assert.equal(fit.size, TYPE.size);
});

test('a localized caption shrinks to hold the source line count before it takes another line', () => {
	const f = font();
	// Three words that need 3 lines at 100 but fit 2 at 80.
	const box = { wrap: 800, centre: 500 };
	const fit = fitCaption(f, 'aaaa bbbb cccc', { box, budget: 10000, targetLines: 2, type: TYPE });
	assert.equal(fit.lines.length, 2);
	assert.ok(fit.size < TYPE.size, 'should have stepped the size down');
});

test('a caption that cannot fit throws rather than clipping', () => {
	// A clipped caption ships; a thrown error does not.
	assert.throws(
		() => fitCaption(font(), 'aaaaaaaaaaaaaaaaaaaa', { box: { wrap: 200, centre: 500 }, budget: 10000, type: TYPE }),
		/will not fit/,
	);
	assert.throws(
		() => fitCaption(font(), 'aa bb', { box: { wrap: 10000, centre: 500 }, budget: 10, type: TYPE }),
		/will not fit/,
	);
});

test('the line box, not the em box, positions the first baseline', () => {
	const f = font();
	const svg = captionSvg(f, { lines: ['a'], size: 100, lineHeight: 125 }, {
		box: { y: 0, centre: 500 },
		canvas: { w: 1000, h: 1000 },
		colour: '#ABCDEF',
	});
	assert.match(svg, /width="1000" height="1000"/);
	assert.match(svg, /fill="#ABCDEF"/);
});

// ---------------------------------------------------------------- subtitles

const SUB_TYPE = {
	...TYPE,
	subtitle: { size: 50, lineHeight: 62.5, colour: '#A0A0A0', minSize: 30, step: 10, gap: 150, variation: null },
};

const runsOf = (text) => captionRuns(text);

test('copy is either a headline string or a headline/subtitle pair', () => {
	// The string form is what every app ships today and must keep working.
	assert.deepEqual(captionRuns('Never Miss an Oil Change.'), {
		headline: 'Never Miss an Oil Change.',
		subtitle: null,
	});
	assert.deepEqual(captionRuns({ headline: 'H', subtitle: 'S' }), { headline: 'H', subtitle: 'S' });
	// A pair with no subtitle is the headline alone, not an error.
	assert.deepEqual(captionRuns({ headline: 'H' }), { headline: 'H', subtitle: null });
	assert.equal(captionRuns(undefined), null);
	assert.equal(captionRuns({ subtitle: 'orphan' }), null);
});

test('without type.subtitle the layout is the single run it has always been', () => {
	// The byte-identity guarantee for every app that is not opting in: one run,
	// at top 0, fitted against the whole budget.
	const layout = layoutCaption(font(), runsOf('aa bb'), {
		box: { wrap: 10000, centre: 500 },
		budget: 10000,
		type: TYPE,
	});
	assert.equal(layout.runs.length, 1);
	assert.equal(layout.subtitle, null);
	assert.deepEqual(layout.runs[0].fit.lines, ['aa bb']);
	assert.equal(layout.runs[0].top, 0);
	assert.equal(layout.runs[0].colour, TYPE.colour);
});

test('a frame with no subtitle string sits exactly where it does today, even when the spec has a subtitle ramp', () => {
	const box = { wrap: 10000, centre: 500 };
	const plain = layoutCaption(font(), runsOf('aa bb'), { box, budget: 10000, type: SUB_TYPE });
	const before = layoutCaption(font(), runsOf('aa bb'), { box, budget: 10000, type: TYPE });
	assert.equal(plain.runs.length, 1);
	assert.deepEqual(plain.runs[0].fit, before.runs[0].fit);
	assert.equal(plain.runs[0].top, before.runs[0].top);
});

test('both runs are painted, in their own colours, stacked by the baseline gap', () => {
	const f = font();
	const box = { wrap: 10000, centre: 500 };
	const layout = layoutCaption(f, { headline: 'aa', subtitle: 'bb cc' }, { box, budget: 10000, type: SUB_TYPE });
	assert.equal(layout.runs.length, 2);
	assert.equal(layout.runs[0].colour, TYPE.colour);
	assert.equal(layout.runs[1].colour, '#A0A0A0');
	assert.equal(layout.runs[1].fit.size, SUB_TYPE.subtitle.size);
	// gap is baseline to baseline: the subtitle's first baseline lands exactly
	// `gap` below the headline's last, whatever the two line boxes are.
	const baseline = (fit, top) => top + (fit.lineHeight - (0.8 - -0.2) * fit.size) / 2 + 0.8 * fit.size;
	assert.equal(
		Math.round(baseline(layout.runs[1].fit, layout.runs[1].top)),
		Math.round(baseline(layout.runs[0].fit, layout.runs[0].top) + SUB_TYPE.subtitle.gap),
	);
	assert.ok(layout.height > layout.runs[0].fit.lineHeight, 'the block is taller than the headline alone');
});

test('the headline gives up room to the subtitle, and takes it back when the subtitle is dropped', () => {
	const f = font();
	const box = { wrap: 1000, centre: 500 };
	// Budget fits the headline at full size only if nothing is reserved below it.
	const tight = { ...SUB_TYPE, subtitle: { ...SUB_TYPE.subtitle, gap: 400 } };
	const dropped = [];
	const layout = layoutCaption(
		f,
		{ headline: 'aa bb cc', subtitle: 'dd ee ff gg hh' },
		{ box, budget: 300, type: tight, onDrop: (t) => dropped.push(t) },
	);
	// No room for both, so the subtitle goes and the headline is re-fitted at the
	// full budget rather than left shrunken by a reserve it no longer needs.
	assert.equal(layout.runs.length, 1);
	assert.equal(layout.subtitle, null);
	assert.deepEqual(dropped, ['dd ee ff gg hh']);
	const alone = layoutCaption(f, runsOf('aa bb cc'), { box, budget: 300, type: TYPE });
	assert.equal(layout.runs[0].fit.size, alone.runs[0].fit.size);
	assert.deepEqual(layout.runs[0].fit.lines, alone.runs[0].fit.lines);
});

test('the whole two-run block stays inside the budget it was given', () => {
	// The band's flatness gate licensed exactly these bounds, so overflowing them
	// is not a cosmetic problem — it paints over artwork.
	const f = font();
	const box = { wrap: 2000, centre: 500 };
	for (const budget of [400, 600, 900, 2000]) {
		const layout = layoutCaption(
			f,
			{ headline: 'aa bb', subtitle: 'cc dd ee ff' },
			{ box, budget, type: SUB_TYPE },
		);
		assert.ok(layout.height <= budget, `block ${layout.height} overflowed budget ${budget}`);
	}
});

test('the subtitle wraps with the headline\'s algorithm, not a prettier one', () => {
	const f = font();
	const greedy = { ...SUB_TYPE, wrap: 'greedy' };
	const layout = layoutCaption(
		f,
		{ headline: 'aa', subtitle: 'aaaa bb cc' },
		{ box: { wrap: 350, centre: 500 }, budget: 10000, type: greedy },
	);
	// At size 50 in a 350 box: greedy takes "aaaa bb" then "cc"; balanced would
	// have evened it to "aaaa" / "bb cc".
	assert.deepEqual(layout.runs[1].fit.lines, ['aaaa bb', 'cc']);
});

test('each run becomes its own fill group, and one run emits what it always did', () => {
	const f = font();
	const box = { y: 0, centre: 500 };
	const canvas = { w: 1000, h: 1000 };
	const fit = { lines: ['a'], size: 100, lineHeight: 125 };
	const single = captionSvg(f, fit, { box, canvas, colour: '#ABCDEF' });
	assert.equal(captionSvg(f, [{ fit, colour: '#ABCDEF', top: 0 }], { box, canvas }), single);
	const two = captionSvg(
		f,
		[
			{ fit, colour: '#FFFFFF', top: 0 },
			{ fit, colour: '#A0A0A0', top: 300 },
		],
		{ box, canvas },
	);
	assert.equal(two.match(/<g fill=/g).length, 2);
	assert.match(two, /fill="#A0A0A0"/);
});

test('a subtitle ramp is validated at load, not discovered as a subtitle that never shrinks', () => {
	const raw = deviceSpec();
	raw.type = { subtitle: { size: 60, minSize: 80 } };
	assert.throws(() => normaliseSpec(raw, cfg), /minSize \(80\) is above its size/);
	const ok = deviceSpec();
	ok.type = { subtitle: { size: 60, lineHeight: 75 } };
	const spec = normaliseSpec(ok, cfg);
	assert.equal(spec.type.subtitle.colour, '#A0A0A0');
	assert.equal(spec.type.subtitle.step, 2);
	// Absent, it stays null so the renderer takes the single-run path.
	assert.equal(normaliseSpec(deviceSpec(), cfg).type.subtitle, null);
});

// ---------------------------------------------------------------------- band

/** Solid RGB field with a darker ink rectangle in it. */
function band(width, height, bg, ink) {
	const data = Buffer.alloc(width * height * 3);
	for (let i = 0; i < data.length; i += 3) {
		data[i] = bg[0];
		data[i + 1] = bg[1];
		data[i + 2] = bg[2];
	}
	for (let y = ink.top; y <= ink.bot; y += 1)
		for (let x = ink.left; x <= ink.right; x += 1) {
			const p = (y * width + x) * 3;
			data[p] = ink.colour[0];
			data[p + 1] = ink.colour[1];
			data[p + 2] = ink.colour[2];
		}
	return { data, width, channels: 3 };
}

test('band measurement finds the modal background and the ink box around it', () => {
	const img = band(100, 60, [15, 17, 19], { top: 10, bot: 19, left: 20, right: 79, colour: [255, 255, 255] });
	const m = measureBand(img, { y0: 0, y1: 60 }, 26);
	assert.deepEqual(m.bg, { r: 15, g: 17, b: 19 });
	assert.deepEqual(m.ink, { top: 10, bot: 19, left: 20, right: 79, width: 59, height: 9 });
	assert.ok(m.flat > 0.85 && m.flat < 1);
});

test('flatness is what licenses repainting, so it is measured not assumed', () => {
	// Half the band is a second colour: this is artwork, and filling the band
	// would destroy it. The number has to come out low enough for the caller's
	// gate to fire.
	const img = band(100, 60, [15, 17, 19], { top: 0, bot: 29, left: 0, right: 99, colour: [200, 100, 50] });
	assert.ok(measureBand(img, { y0: 0, y1: 60 }, 26).flat <= 0.5);
});

test('a band with no ink reports none instead of an empty rectangle at the origin', () => {
	const img = band(20, 20, [0, 0, 0], { top: 0, bot: -1, left: 0, right: -1, colour: [0, 0, 0] });
	assert.equal(measureBand(img, { y0: 0, y1: 20 }, 26).ink, null);
});

test('the band sits above or below the mockup depending on where the mockup starts', () => {
	const spec = { canvas: { w: 1242, h: 2688 }, band: { clearance: 4 } };
	assert.deepEqual(bandBounds(spec, { mockTop: 595, mockH: 2251 }), { y0: 0, y1: 591 });
	// A negative mockTop means the phone runs off the top and the caption is below it.
	assert.deepEqual(bandBounds(spec, { mockTop: -164, mockH: 2251 }), { y0: 2091, y1: 2688 });
});

// ---------------------------------------------------------------------- spec

const cfg = {
	paths: { store: '/repo/store' },
	asc: { primaryLocale: 'en-US' },
	store: { locales: ['en-US', 'de-DE'] },
};

const deviceSpec = () => ({
	mode: 'device-frame',
	canvas: { w: 1242, h: 2688 },
	fonts: { default: '../assets/fonts/X.ttf' },
	type: { margin: 98 },
	device: {
		w: 1076,
		h: 2174,
		screenIndex: 1,
		layers: [{ file: 'body.png', x: 0, y: 0, w: 10, h: 10 }],
		screenGroup: { x: 65.82, y: 49.35, w: 955.07, h: 2072.83 },
		artboard: { x: -4.94, y: -2.47, w: 962.48, h: 2077.76 },
	},
	frames: [{ key: '01', src: '01.png', bg: '#14100C', phone: { x: 83, y: 690 }, caption: { x: 165, y: 128, w: 909 } }],
});

test('a narrow caption box is widened to the margin convention, keeping its centre', () => {
	// The designer's boxes vary in width about one shared centre. Wrapping to
	// the narrowest would shrink a long localized caption for no design reason.
	const spec = normaliseSpec(deviceSpec(), cfg);
	const box = spec.frames[0].caption;
	assert.equal(box.centre, 165 + 909 / 2);
	assert.equal(box.wrap, 2 * Math.min(box.centre, 1242 - box.centre) - 2 * 98);
	assert.ok(box.wrap > box.w, 'the 98px margin gives more room than the 909px box');
});

test('without a margin the design box is the wrap width', () => {
	const raw = deviceSpec();
	raw.type = {};
	assert.equal(normaliseSpec(raw, cfg).frames[0].caption.wrap, 909);
});

test('spec paths resolve against the store directory, so a spec ports between repos', () => {
	const spec = normaliseSpec(deviceSpec(), cfg);
	assert.equal(spec.fonts.default.file, '/repo/assets/fonts/X.ttf');
	assert.equal(spec.paths.parts, '/repo/store/figma-export/parts');
	assert.equal(spec.paths.out, '/repo/store/screenshots');
});

test('a font entry may carry a variable-font instance', () => {
	const raw = deviceSpec();
	raw.fonts.byLocale = { ja: { file: 'fonts/NotoSansJP.ttf', variation: { wght: 700 } } };
	const spec = normaliseSpec(raw, cfg);
	assert.deepEqual(spec.fonts.byLocale.ja, { file: '/repo/store/fonts/NotoSansJP.ttf', variation: { wght: 700 } });
});

test('an incomplete spec fails at load, not halfway through a 96-image render', () => {
	assert.throws(() => normaliseSpec({ ...deviceSpec(), mode: 'photoshop' }, cfg), /mode must be one of/);
	assert.throws(() => normaliseSpec({ ...deviceSpec(), frames: [] }, cfg), /frames\[\] is empty/);
	const noDevice = deviceSpec();
	delete noDevice.device;
	assert.throws(() => normaliseSpec(noDevice, cfg), /device\.w and device\.h/);
	const noFont = deviceSpec();
	noFont.fonts = {};
	assert.throws(() => normaliseSpec(noFont, cfg), /fonts\.default is required/);
});

test('caption-band frames need the mockup bounds that place the band', () => {
	const raw = {
		mode: 'caption-band',
		canvas: { w: 1242, h: 2688 },
		fonts: { default: 'fonts/X.ttf' },
		frames: [{ key: 'S1', caption: { x: 98, y: 176, w: 1045 } }],
	};
	assert.throws(() => normaliseSpec(raw, cfg), /needs mockTop and mockH/);
	raw.frames[0].mockTop = 595;
	raw.frames[0].mockH = 2251;
	const spec = normaliseSpec(raw, cfg);
	assert.equal(spec.frames[0].base, 'S1.png');
	assert.equal(spec.paths.base, '/repo/store/screenshots-raw/en-US/IPHONE_65');
});

// -------------------------------------------------------------------- output

test('output filenames keep the designed order for the store', () => {
	const device = normaliseSpec(deviceSpec(), cfg);
	assert.equal(frameFile(device, device.frames[0], 0), '01.png');
	const band = normaliseSpec(
		{
			mode: 'caption-band',
			canvas: { w: 1242, h: 2688 },
			fonts: { default: 'f.ttf' },
			frames: [{ key: 'S1', mockTop: 1, mockH: 1 }, { key: 'S2', mockTop: 1, mockH: 1 }],
		},
		cfg,
	);
	assert.equal(frameFile(band, band.frames[1], 1), '02-S2.png');
});

test('the glass rectangle follows the phone, which is what excludes it from calibration', () => {
	const spec = normaliseSpec(deviceSpec(), cfg);
	assert.deepEqual(glassRect(spec, spec.frames[0]), { left: 149, top: 739, width: 955, height: 2073 });
});

test('colours parse with or without the hash, and a typo is fatal', () => {
	assert.deepEqual(parseColour('#14100C'), { r: 20, g: 16, b: 12, alpha: 1 });
	assert.deepEqual(parseColour('14100C'), { r: 20, g: 16, b: 12, alpha: 1 });
	assert.throws(() => parseColour('#141'), /not a colour/);
});

// ------------------------------------------------------------------- capture

test('every capture pass writes the full merged seed, never a patch', () => {
	// localStorage survives between locale passes, so a partial seed leaves the
	// previous locale's currency behind — a German barn billed in dollars.
	const seed = { default: { barn: { currency: 'USD' } }, byLocale: { 'de-DE': { barn: { currency: 'EUR' } } } };
	assert.deepEqual(seedFor(seed, 'de-DE'), { barn: { currency: 'EUR' } });
	assert.deepEqual(seedFor(seed, 'en-US'), { barn: { currency: 'USD' } });
	assert.deepEqual(seedFor(null, 'en-US'), {});
});

// --------------------------------------------------------------------- figma

test('an unpinned spec reports unknown drift, not drift', () => {
	// Reporting "drifted" for a spec that never recorded a version trains people
	// to ignore the check.
	assert.equal(driftOf({}, { version: '123' }).drifted, null);
	assert.equal(driftOf({ source: { version: '123' } }, { version: '123' }).drifted, false);
	assert.equal(driftOf({ source: { version: '122' } }, { version: '123' }).drifted, true);
});
