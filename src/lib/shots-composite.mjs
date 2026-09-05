// sharp compositing for screenshot rendering: the device frame (committed Figma
// layers + masked capture) and the caption band (repaint a flat background
// strip). See shots-geometry.mjs for the pure half and shots-spec.mjs for the
// two modes.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDep } from './appdeps.mjs';
import { ShipError, warn } from '../log.mjs';
import { captionSvg, layoutCaption } from './shots-type.mjs';
import { bandBounds, captionBudget, frameFile, measureBand, parseColour, sourceLineCounts } from './shots-geometry.mjs';
import { captionRuns } from './shots-spec.mjs';

/**
 * The render context: the sharp constructor, the normalised spec, a per-face
 * font cache, and the caption-band base images measured so far.
 * @typedef {Object} Ctx
 * @property {import('./appdeps.mjs').NativeModule} sharp
 * @property {import('./shots-spec.mjs').ShotSpec} spec
 * @property {(locale: string, variation?: Record<string, number>|null) => import('./shots-type.mjs').Font} loadFont
 * @property {Map<string, BaseImage>} bases
 */

/**
 * A caption-band base composite, measured: where the band is, how flat it is,
 * where the source ink sits, and the raw pixels for the outside-band check.
 * `ink` is non-null — the loader refuses a base with no ink to align to.
 * @typedef {Object} BaseImage
 * @property {string} path
 * @property {import('./shots-geometry.mjs').BandBounds} bounds
 * @property {import('./shots-geometry.mjs').RGB} bg
 * @property {number} flat
 * @property {import('./shots-geometry.mjs').InkBox} ink
 * @property {{data: Buffer, info: {width: number, height: number, channels: number}}} raw
 */

/** A layer positioned for {@link compose}: encoded bytes plus top-left corner. */
/** @typedef {{input: Buffer, left: number, top: number}} ComposeItem */

/**
 * What a renderer hands back: the PNG, the headline fit it was painted from,
 * and the subtitle fit when one survived.
 * @typedef {{png: Buffer, lines: string[], size: number, lineHeight: number, forced: boolean, subtitle: import('./shots-type.mjs').Fit|null}} RenderResult
 */

/** One rendered locale+frame row for the report. */
/** @typedef {{locale: string, frame: string, file: string, size: number, lines: string[], subtitle: string[]|null}} RenderRow */

/**
 * Font per locale, cached: opening a TTF per frame is wasted work.
 *
 * `variation` overrides the locale entry's own axis values, which is how a
 * subtitle set lighter than its headline gets the weight it was designed at.
 * It has to be stated: ja/ko resolve to variable Noto faces that open on
 * Regular, so an inherited axis is the difference between the design and a
 * caption that silently renders at the wrong weight.
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./appdeps.mjs').NativeModule} fontkit
 * @returns {(locale: string, variation?: Record<string, number>|null) => import('./shots-type.mjs').Font}
 */
function fontLoader(spec, fontkit) {
	/** @type {Map<string, import('./shots-type.mjs').Font>} */
	const cache = new Map();
	return (locale, variation = null) => {
		const base = spec.fonts.byLocale[locale] ?? spec.fonts.default;
		const entry = variation ? { ...base, variation: { ...base.variation, ...variation } } : base;
		const key = `${entry.file}|${JSON.stringify(entry.variation)}`;
		if (!cache.has(key)) {
			// The normaliser requires a file on every font entry; its null is the
			// unvalidated byLocale case the spec schema forbids.
			if (!existsSync(/** @type {string} */ (entry.file)))
				throw new ShipError(`font not found: ${entry.file}`, {
					hint: 'fonts.default in the spec must point at the exact face the design uses',
				});
			const opened = fontkit.openSync(entry.file);
			cache.set(key, entry.variation ? opened.getVariation(entry.variation) : opened);
		}
		return /** @type {import('./shots-type.mjs').Font} */ (cache.get(key));
	};
}

/** @param {import('./shots-spec.mjs').ShotSpec} spec @param {string} locale @returns {boolean} */
const perCharacter = (spec, locale) => spec.type.perCharacterLocales.includes(locale);

/** The font a subtitle run is set in: the locale's face, at the subtitle's axis. */
/**
 * @param {Ctx} ctx
 * @param {string} locale
 * @returns {import('./shots-type.mjs').Font|null}
 */
const subtitleFontFor = (ctx, locale) =>
	ctx.spec.type.subtitle ? ctx.loadFont(locale, ctx.spec.type.subtitle.variation) : null;

/**
 * Lay a frame's copy out as one or two runs, reporting a dropped subtitle.
 * @param {Ctx} ctx
 * @param {{locale: string, frame: import('./shots-spec.mjs').ShotFrame, copy: import('./shots-spec.mjs').CaptionRuns, budget: number, targetLines: number|null}} opts
 * @returns {import('./shots-type.mjs').LayoutResult}
 */
function layoutFor(ctx, { locale, frame, copy, budget, targetLines }) {
	return layoutCaption(ctx.loadFont(locale), copy, {
		box: frame.caption,
		budget,
		targetLines,
		type: ctx.spec.type,
		perCharacter: perCharacter(ctx.spec, locale),
		subtitleFont: subtitleFontFor(ctx, locale),
		// Named on stdout rather than swallowed: a subtitle that silently stopped
		// shipping in one locale is exactly the failure this feature exists to fix.
		onDrop: (text) => warn(`${locale}/${frame.key}: subtitle dropped, will not fit at minSize: ${text}`),
	});
}

// --------------------------------------------------------------- device frame

/**
 * Map the raw capture into the artboard rect the way the design tool's image
 * transform does: it clamps when the transform samples outside the source, so
 * edge rows are replicated. A plain resize would shift the content instead.
 * @param {import('./appdeps.mjs').NativeModule} sharp
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {string} srcPath
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @returns {Promise<Buffer>}
 */
async function screenLayer(sharp, spec, srcPath, frame) {
	const { artboard, screenGroup } = spec.device;
	const W = artboard.w;
	const H = artboard.h;

	/** @type {Buffer} */
	let placed;
	if (frame.cover) {
		// scaleMode FILL: cover the rect, centre-crop the overflow.
		placed = await sharp(srcPath)
			.resize(Math.round(W), Math.round(H), { fit: 'cover', position: 'center' })
			.png()
			.toBuffer();
	} else {
		const [[m00, , m02], [, m11, m12]] = frame.crop;
		// u = m00*x/W + m02 → the full source spans W/m00, offset -m02*W/m00.
		const rw = W / m00;
		const rh = H / m11;
		const dx = -m02 * rw;
		const dy = -m12 * rh;
		const resized = await sharp(srcPath).resize(Math.round(rw), Math.round(rh), { fit: 'fill' }).png().toBuffer();

		const left = Math.max(0, Math.round(dx));
		const top = Math.max(0, Math.round(dy));
		const right = Math.max(0, Math.round(W - (dx + rw)));
		const bottom = Math.max(0, Math.round(H - (dy + rh)));
		const extended =
			left || top || right || bottom
				? await sharp(resized).extend({ left, top, right, bottom, extendWith: 'copy' }).png().toBuffer()
				: resized;

		const cropLeft = Math.max(0, -Math.round(dx));
		const cropTop = Math.max(0, -Math.round(dy));
		const em = await sharp(extended).metadata();
		placed = await sharp(extended)
			.extract({
				left: cropLeft,
				top: cropTop,
				width: Math.min(Math.round(W), em.width - cropLeft),
				height: Math.min(Math.round(H), em.height - cropTop),
			})
			.resize(Math.round(W), Math.round(H), { fit: 'fill' })
			.png()
			.toBuffer();
	}

	// The artboard is larger than the screen group and negatively offset, so
	// build at artboard size and extract the group window, then mask with the
	// real cutout (rounded corners + notch) exported from Figma.
	const groupW = Math.round(screenGroup.w);
	const groupH = Math.round(screenGroup.h);
	const inGroup = await sharp(placed)
		.extract({
			left: Math.round(-artboard.x),
			top: Math.round(-artboard.y),
			width: groupW,
			height: groupH,
		})
		.png()
		.toBuffer();

	const maskAlpha = await sharp(join(spec.paths.parts, spec.device.screenMask))
		.resize(groupW, groupH, { fit: 'fill' })
		.ensureAlpha()
		.extractChannel('alpha')
		.toColourspace('b-w')
		.png()
		.toBuffer();

	const { data, info } = await sharp(inGroup).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const mask = await sharp(maskAlpha).raw().toBuffer();
	for (let p = 0, m = 0; p < data.length; p += info.channels, m += 1)
		data[p + 3] = (data[p + 3] * mask[m]) / 255;
	return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
		.png()
		.toBuffer();
}

/**
 * A layer export is rounded to its visible ink box, so centre it on its declared centre.
 * @param {import('./appdeps.mjs').NativeModule} sharp
 * @param {string} dir
 * @param {import('./shots-spec.mjs').DeviceLayer} spec
 * @returns {Promise<ComposeItem>}
 */
async function centred(sharp, dir, spec) {
	const p = join(dir, spec.file);
	if (!existsSync(p))
		throw new ShipError(`missing mockup layer: ${p}`, {
			hint: 'the Figma layer exports are committed build inputs — restore them from git, not from Figma',
		});
	const meta = await sharp(p).metadata();
	return {
		input: await sharp(p).png().toBuffer(),
		left: Math.round(spec.x + spec.w / 2 - meta.width / 2),
		top: Math.round(spec.y + spec.h / 2 - meta.height / 2),
	};
}

/**
 * Composite onto a width×height window, tolerating layers that fall outside it:
 * build on a canvas covering the union of all extents, then extract the window.
 * Figma clips to the frame; sharp refuses to composite out of bounds.
 * @param {import('./appdeps.mjs').NativeModule} sharp
 * @param {{width: number, height: number, background?: {r: number, g: number, b: number, alpha?: number}, items: ComposeItem[]}} opts
 * @returns {Promise<Buffer>}
 */
async function compose(sharp, { width, height, background, items }) {
	/** @type {Array<ComposeItem & {w: number, h: number}>} */
	const sized = [];
	for (const item of items) {
		const meta = await sharp(item.input).metadata();
		sized.push({ ...item, w: meta.width, h: meta.height });
	}
	const padLeft = Math.max(0, ...sized.map((i) => -i.left));
	const padTop = Math.max(0, ...sized.map((i) => -i.top));
	const padRight = Math.max(0, ...sized.map((i) => i.left + i.w - width));
	const padBottom = Math.max(0, ...sized.map((i) => i.top + i.h - height));

	const canvas = await sharp({
		create: {
			width: width + padLeft + padRight,
			height: height + padTop + padBottom,
			channels: 4,
			background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite(sized.map((i) => ({ input: i.input, left: i.left + padLeft, top: i.top + padTop })))
		.png()
		.toBuffer();

	return sharp(canvas).extract({ left: padLeft, top: padTop, width, height }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * @param {Ctx} ctx
 * @param {{locale: string, frame: import('./shots-spec.mjs').ShotFrame, copy: import('./shots-spec.mjs').CaptionRuns, targetLines: number|null}} opts
 * @returns {Promise<RenderResult>}
 */
async function renderDeviceFrame(ctx, { locale, frame, copy, targetLines }) {
	const { sharp, spec, loadFont } = ctx;
	const srcPath = join(spec.paths.raw, locale, spec.displayType, frame.src);
	if (!existsSync(srcPath))
		throw new ShipError(`missing raw capture: ${srcPath}`, {
			hint: `run \`ship shots capture --locale ${locale}\` first`,
		});

	const layers = spec.device.layers;
	const at = spec.device.screenIndex;
	/** @type {ComposeItem[]} */
	const parts = [];
	for (const layer of layers.slice(0, at)) parts.push(await centred(sharp, spec.paths.parts, layer));
	parts.push({
		input: await screenLayer(sharp, spec, srcPath, frame),
		left: Math.round(spec.device.screenGroup.x),
		top: Math.round(spec.device.screenGroup.y),
	});
	for (const layer of layers.slice(at)) parts.push(await centred(sharp, spec.paths.parts, layer));

	const device = await compose(sharp, { width: spec.device.w, height: spec.device.h, items: parts });

	const font = loadFont(locale);
	// Device-frame frames always have a budget; captionBudget's null is caption-band's.
	const layout = layoutFor(ctx, { locale, frame, copy, budget: /** @type {number} */ (captionBudget(spec, frame)), targetLines });
	const { fit } = layout;
	const svg = captionSvg(
		font,
		layout.runs.length === 1
			? fit
			: layout.runs.map((r) => ({ ...r, top: frame.caption.y + r.top })),
		{
			box: frame.caption,
			canvas: spec.canvas,
			colour: spec.type.colour,
		},
	);

	const png = await compose(sharp, {
		width: spec.canvas.w,
		height: spec.canvas.h,
		background: parseColour(frame.bg),
		items: [
			{ input: device, left: Math.round(frame.phone.x), top: Math.round(frame.phone.y) },
			{ input: await sharp(Buffer.from(svg)).png().toBuffer(), left: 0, top: 0 },
		],
	});
	return { png, ...fit, subtitle: layout.subtitle };
}

// --------------------------------------------------------------- caption band

/**
 * Measure the base composite once per frame and cache it.
 * @param {Ctx} ctx
 * @param {import('./shots-spec.mjs').ShotFrame} frame
 * @returns {Promise<BaseImage>}
 */
async function baseImage(ctx, frame) {
	const { sharp, spec } = ctx;
	if (ctx.bases.has(frame.key)) return /** @type {BaseImage} */ (ctx.bases.get(frame.key));
	const path = join(spec.paths.base, frame.base);
	if (!existsSync(path))
		throw new ShipError(`missing base composite: ${path}`, {
			hint: 'run `ship shots capture` to download the live App Store images',
		});
	const img = sharp(path).removeAlpha();
	const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
	if (info.width !== spec.canvas.w || info.height !== spec.canvas.h)
		throw new ShipError(
			`${path} is ${info.width}x${info.height}, spec canvas is ${spec.canvas.w}x${spec.canvas.h}`,
		);
	const bounds = bandBounds(spec, frame);
	const measured = measureBand({ data, width: info.width, channels: info.channels }, bounds, spec.band.inkTolerance);
	if (measured.flat < spec.band.flatMin)
		throw new ShipError(
			`${frame.key}: caption band is only ${(measured.flat * 100).toFixed(0)}% one colour`,
			{
				hint: 'the band is no longer flat background — repainting it would destroy artwork. Re-derive the geometry before rendering.',
			},
		);
	if (!measured.ink) throw new ShipError(`${frame.key}: found no caption ink in the band to align to`);
	// Named rather than spread so `ink` keeps the non-null the throw above proved.
	const entry = { path, bounds, bg: measured.bg, flat: measured.flat, ink: measured.ink, raw: { data, info } };
	ctx.bases.set(frame.key, entry);
	return entry;
}

/**
 * The drawn caption reduced to its ink, for aligning on the source ink top.
 *
 * A single run is trimmed on all four sides and re-centred on the caption
 * centre, exactly as it always was. Two runs are trimmed vertically only: the
 * headline and the subtitle are each centred on that same centre, but their ink
 * boxes have different side bearings, so re-centring their union would shift
 * both runs by the difference. Keeping full canvas width keeps each run on the
 * axis the design put it on.
 * @param {import('./appdeps.mjs').NativeModule} sharp
 * @param {Buffer} drawn
 * @param {boolean} twoRun
 * @returns {Promise<{trimmed: Buffer, ink: {width: number, height: number, full: boolean}}>}
 */
async function inkStrip(sharp, drawn, twoRun) {
	if (!twoRun) {
		const trimmed = await sharp(drawn).trim({ threshold: 1 }).png().toBuffer();
		return { trimmed, ink: { ...(await sharp(trimmed).metadata()), full: false } };
	}
	const probe = await sharp(drawn).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
	const full = await sharp(drawn).metadata();
	// sharp populates trimOffsetTop on any pipeline that called trim(), and this
	// one did, one line up.
	const top = Math.abs(probe.info.trimOffsetTop);
	const trimmed = await sharp(drawn)
		.extract({ left: 0, top, width: full.width, height: probe.info.height })
		.png()
		.toBuffer();
	return { trimmed, ink: { width: full.width, height: probe.info.height, full: true } };
}

/**
 * @param {Ctx} ctx
 * @param {{locale: string, frame: import('./shots-spec.mjs').ShotFrame, copy: import('./shots-spec.mjs').CaptionRuns, targetLines: number|null}} opts
 * @returns {Promise<RenderResult>}
 */
async function renderCaptionBand(ctx, { locale, frame, copy, targetLines }) {
	const { sharp, spec, loadFont } = ctx;
	const base = await baseImage(ctx, frame);
	const { y0, y1 } = base.bounds;
	const bandH = y1 - y0;
	const pad = spec.band.pad;

	const font = loadFont(locale);
	// The band is the budget, and it is not negotiable: the flatness gate above
	// licensed repainting exactly these bounds. A two-run block that will not fit
	// loses its subtitle inside layoutCaption rather than growing the band.
	const layout = layoutFor(ctx, { locale, frame, copy, budget: bandH - 2 * pad, targetLines });
	const { fit } = layout;

	// Draw into a band-sized canvas with slack above and below, then trim to the
	// ink so the block can be aligned on the source-locale ink top rather than
	// on a font-dependent line box.
	const slack = Math.round(spec.type.size * 2);
	const svg = captionSvg(
		font,
		layout.runs.length === 1 ? fit : layout.runs.map((r) => ({ ...r, top: slack + r.top })),
		{
			box: frame.caption,
			canvas: { w: spec.canvas.w, h: bandH + 2 * slack },
			colour: spec.type.colour,
			top: slack,
		},
	);
	const drawn = await sharp(Buffer.from(svg)).png().toBuffer();
	const { trimmed, ink } = await inkStrip(sharp, drawn, layout.runs.length > 1);

	// Keep the source ink top; when the localized block is taller, grow it about
	// that line so the caption stays optically where the designer put it.
	const grow = Math.max(0, Math.floor((ink.height - base.ink.height) / 2));
	let y = base.ink.top - grow;
	y = Math.max(y0 + pad, Math.min(y, y1 - ink.height - pad));

	const png = await sharp(base.path)
		.removeAlpha()
		.composite([
			{
				input: {
					create: { width: spec.canvas.w, height: bandH, channels: 3, background: base.bg },
				},
				left: 0,
				top: y0,
			},
			{
				input: trimmed,
				left: ink.full ? 0 : Math.round(frame.caption.centre - ink.width / 2),
				top: Math.round(y),
			},
		])
		.png({ compressionLevel: 9 })
		.toBuffer();

	return { png, ...fit, subtitle: layout.subtitle };
}

// ------------------------------------------------------------------- driver

/**
 * @param {import('../config.mjs').Config} cfg
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @returns {Promise<Ctx>}
 */
async function context(cfg, spec) {
	const sharp = await appDep(cfg, 'sharp');
	const fontkit = await appDep(cfg, 'fontkit');
	return { sharp, spec, loadFont: fontLoader(spec, fontkit), bases: new Map() };
}

/**
 * Render every requested locale into store/screenshots/<locale>/<displayType>/.
 * @param {import('../config.mjs').Config} cfg
 * @param {import('./shots-spec.mjs').ShotSpec} spec
 * @param {import('./shots-spec.mjs').Captions} captions
 * @param {string[]} locales
 * @param {{onFrame?: (row: RenderRow) => void}} [opts]
 * @returns {Promise<RenderRow[]>}
 */
export async function renderLocales(cfg, spec, captions, locales, { onFrame } = {}) {
	const ctx = await context(cfg, spec);
	const sourceLocale = spec.base?.sourceLocale ?? cfg.asc.primaryLocale;
	const targets = sourceLineCounts(spec, captions, sourceLocale, ctx.loadFont);
	const render = spec.mode === 'device-frame' ? renderDeviceFrame : renderCaptionBand;

	/** @type {RenderRow[]} */
	const written = [];
	for (const locale of locales) {
		// localesFor only ever answers with locales the caption file defines, so
		// every locale reaching here has copy.
		const copy = captions[locale];
		for (const [i, frame] of spec.frames.entries()) {
			const runs = captionRuns(copy[frame.key]);
			if (!runs) throw new ShipError(`${locale}: no caption for frame ${frame.key}`);
			const { png, lines, size, subtitle } = await render(ctx, {
				locale,
				frame,
				copy: runs,
				targetLines: targets[frame.key],
			});
			const dest = join(spec.paths.out, locale, spec.displayType, frameFile(spec, frame, i));
			await mkdir(dirname(dest), { recursive: true });
			// Re-encode at sharp's default settings rather than dumping the
			// working buffer: identical pixels then produce identical bytes, so a
			// re-render that changed nothing shows up as an empty diff instead of
			// as N rewritten binaries.
			await ctx.sharp(png).png().toFile(dest);
			const row = { locale, frame: frame.key, file: dest, size, lines, subtitle: subtitle?.lines ?? null };
			written.push(row);
			onFrame?.(row);
		}
	}
	return written;
}

export { renderDeviceFrame, renderCaptionBand, baseImage, context };
