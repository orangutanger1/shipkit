// Compositing store screenshots from a spec, a raw capture and caption copy.
//
// Two modes, one caption pipeline. See shots-spec.mjs for why both exist.
//
// device-frame
//   The iPhone mockup is never redrawn. Its layers are the committed Figma
//   exports, composited in Figma's z-order with the localized capture masked
//   into the screen cutout — so bezel, notch and speaker are the artwork the
//   design tool produced and only the pixels behind the glass change.
//
// caption-band
//   The finished composite already exists and only the caption band is
//   repainted. Legal exactly when that band is flat background: the renderer
//   measures the flatness itself and refuses below the spec's threshold rather
//   than quietly painting over artwork.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDep } from './appdeps.mjs';
import { ShipError } from '../log.mjs';
import { captionSvg, fitCaption, runWidth } from './shots-type.mjs';

/** #rrggbb → sharp's background object. */
export function parseColour(hex) {
	const m = /^#?([\da-f]{6})$/i.exec(String(hex ?? ''));
	if (!m) throw new ShipError(`not a colour: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

/** Font per locale, cached: opening a TTF per frame is wasted work. */
function fontLoader(spec, fontkit) {
	const cache = new Map();
	return (locale) => {
		const entry = spec.fonts.byLocale[locale] ?? spec.fonts.default;
		const key = `${entry.file}|${JSON.stringify(entry.variation)}`;
		if (!cache.has(key)) {
			if (!existsSync(entry.file))
				throw new ShipError(`font not found: ${entry.file}`, {
					hint: 'fonts.default in the spec must point at the exact face the design uses',
				});
			const opened = fontkit.openSync(entry.file);
			cache.set(key, entry.variation ? opened.getVariation(entry.variation) : opened);
		}
		return cache.get(key);
	};
}

const perCharacter = (spec, locale) => spec.type.perCharacterLocales.includes(locale);

/** Vertical room a caption may occupy: to the mockup, or to the canvas edge. */
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
 */
export function sourceLineCounts(spec, captions, sourceLocale, loadFont) {
	const copy = captions[sourceLocale];
	if (!copy) throw new ShipError(`no caption copy for source locale ${sourceLocale}`);
	const font = loadFont(sourceLocale);
	const out = {};
	for (const frame of spec.frames) {
		const text = copy[frame.key];
		if (!text) throw new ShipError(`${sourceLocale}: no caption for frame ${frame.key}`);
		out[frame.key] =
			fitCaption(font, text, {
				box: frame.caption,
				budget: captionBudget(spec, frame) ?? Infinity,
				type: spec.type,
				perCharacter: perCharacter(spec, sourceLocale),
			}).lines.length + spec.type.extraLines;
	}
	return out;
}

// --------------------------------------------------------------- device frame

/**
 * Map the raw capture into the artboard rect the way the design tool's image
 * transform does: it clamps when the transform samples outside the source, so
 * edge rows are replicated. A plain resize would shift the content instead.
 */
async function screenLayer(sharp, spec, srcPath, frame) {
	const { artboard, screenGroup, parts: _p } = spec.device;
	const W = artboard.w;
	const H = artboard.h;

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

/** A layer export is rounded to its visible ink box, so centre it on its declared centre. */
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
 */
async function compose(sharp, { width, height, background, items }) {
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

async function renderDeviceFrame(ctx, { locale, frame, text, targetLines }) {
	const { sharp, spec, loadFont } = ctx;
	const srcPath = join(spec.paths.raw, locale, spec.displayType, frame.src);
	if (!existsSync(srcPath))
		throw new ShipError(`missing raw capture: ${srcPath}`, {
			hint: `run \`ship shots capture --locale ${locale}\` first`,
		});

	const layers = spec.device.layers;
	const at = spec.device.screenIndex;
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
	const fit = fitCaption(font, text, {
		box: frame.caption,
		budget: captionBudget(spec, frame),
		targetLines,
		type: spec.type,
		perCharacter: perCharacter(spec, locale),
	});
	const svg = captionSvg(font, fit, {
		box: frame.caption,
		canvas: spec.canvas,
		colour: spec.type.colour,
	});

	const png = await compose(sharp, {
		width: spec.canvas.w,
		height: spec.canvas.h,
		background: parseColour(frame.bg),
		items: [
			{ input: device, left: Math.round(frame.phone.x), top: Math.round(frame.phone.y) },
			{ input: await sharp(Buffer.from(svg)).png().toBuffer(), left: 0, top: 0 },
		],
	});
	return { png, ...fit };
}

// --------------------------------------------------------------- caption band

/** Band bounds: everything between the canvas edge and the mockup, less clearance. */
export function bandBounds(spec, frame) {
	const { clearance } = spec.band;
	return frame.mockTop > 0
		? { y0: 0, y1: Math.round(frame.mockTop) - clearance }
		: { y0: Math.round(frame.mockTop + frame.mockH) + clearance, y1: spec.canvas.h };
}

/**
 * Measure a band on the base composite: its background colour, how flat it is,
 * and where the source-locale ink sits.
 *
 * `flat` is the safety gate. A band that is not overwhelmingly one colour holds
 * artwork, and repainting it destroys pixels — so this reports the number and
 * the caller refuses below the threshold. Nothing here guesses.
 */
export function measureBand({ data, width, channels }, { y0, y1 }, inkTolerance) {
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
	const bg = { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255 };

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

	const hasInk = Number.isFinite(top);
	return {
		bg,
		flat: total ? best / total : 1,
		ink: hasInk ? { top, bot, left, right, width: right - left, height: bot - top } : null,
	};
}

async function baseImage(ctx, frame) {
	const { sharp, spec } = ctx;
	if (ctx.bases.has(frame.key)) return ctx.bases.get(frame.key);
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
	const entry = { path, bounds, ...measured, raw: { data, info } };
	ctx.bases.set(frame.key, entry);
	return entry;
}

async function renderCaptionBand(ctx, { locale, frame, text, targetLines }) {
	const { sharp, spec, loadFont } = ctx;
	const base = await baseImage(ctx, frame);
	const { y0, y1 } = base.bounds;
	const bandH = y1 - y0;
	const pad = spec.band.pad;

	const font = loadFont(locale);
	const fit = fitCaption(font, text, {
		box: frame.caption,
		budget: bandH - 2 * pad,
		targetLines,
		type: spec.type,
		perCharacter: perCharacter(spec, locale),
	});

	// Draw into a band-sized canvas with slack above and below, then trim to the
	// ink so the block can be aligned on the source-locale ink top rather than
	// on a font-dependent line box.
	const slack = Math.round(spec.type.size * 2);
	const svg = captionSvg(font, fit, {
		box: frame.caption,
		canvas: { w: spec.canvas.w, h: bandH + 2 * slack },
		colour: spec.type.colour,
		top: slack,
	});
	const drawn = await sharp(Buffer.from(svg)).png().toBuffer();
	const trimmed = await sharp(drawn).trim({ threshold: 1 }).png().toBuffer();
	const ink = await sharp(trimmed).metadata();

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
			{ input: trimmed, left: Math.round(frame.caption.centre - ink.width / 2), top: Math.round(y) },
		])
		.png({ compressionLevel: 9 })
		.toBuffer();

	return { png, ...fit };
}

// ------------------------------------------------------------------- driver

async function context(cfg, spec) {
	const sharp = await appDep(cfg, 'sharp');
	const fontkit = await appDep(cfg, 'fontkit');
	return { sharp, spec, loadFont: fontLoader(spec, fontkit), bases: new Map() };
}

/** Output filename for a frame: numbered so ASC keeps the designed order. */
export const frameFile = (spec, frame, index) =>
	frame.out ?? (spec.mode === 'device-frame' ? frame.src : `${String(index + 1).padStart(2, '0')}-${frame.key}.png`);

/**
 * Render every requested locale into store/screenshots/<locale>/<displayType>/.
 * @returns {Promise<Array<{locale:string, file:string, size:number, lines:string[]}>>}
 */
export async function renderLocales(cfg, spec, captions, locales, { onFrame } = {}) {
	const ctx = await context(cfg, spec);
	const sourceLocale = spec.base?.sourceLocale ?? cfg.asc.primaryLocale;
	const targets = sourceLineCounts(spec, captions, sourceLocale, ctx.loadFont);
	const render = spec.mode === 'device-frame' ? renderDeviceFrame : renderCaptionBand;

	const written = [];
	for (const locale of locales) {
		const copy = captions[locale];
		if (!copy) throw new ShipError(`no caption copy for ${locale}`);
		for (const [i, frame] of spec.frames.entries()) {
			const text = copy[frame.key];
			if (!text) throw new ShipError(`${locale}: no caption for frame ${frame.key}`);
			const { png, lines, size } = await render(ctx, { locale, frame, text, targetLines: targets[frame.key] });
			const dest = join(spec.paths.out, locale, spec.displayType, frameFile(spec, frame, i));
			await mkdir(dirname(dest), { recursive: true });
			// Re-encode at sharp's default settings rather than dumping the
			// working buffer: identical pixels then produce identical bytes, so a
			// re-render that changed nothing shows up as an empty diff instead of
			// as N rewritten binaries.
			await ctx.sharp(png).png().toFile(dest);
			const row = { locale, frame: frame.key, file: dest, size, lines };
			written.push(row);
			onFrame?.(row);
		}
	}
	return written;
}

// -------------------------------------------------------------------- verify

/** Is (x,y) inside any excluded rectangle? */
const masked = (rects, x, y) =>
	rects.some((r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height);

/**
 * Share of pixels differing by more than `tolerance` in any channel, ignoring
 * the listed rectangles.
 *
 * The exclusions are the measurement, not a convenience. Two regions are
 * *supposed* to differ from the design tool's reference render:
 *   - behind the glass, where the reference shows the designer's placeholder
 *     screens and ours shows the real localized capture;
 *   - the caption, where two different rasterisers draw the same outlines and
 *     disagree on every antialiased edge of 128px type.
 * What is left is the question calibration actually asks: did the background
 * colour and the bezel land exactly where the design put them. On stallbook
 * that answer is 1.7–2.3% of pixels at tolerance 8, essentially all of it the
 * one-pixel antialiased rim of the phone body.
 */
async function pixelDelta(sharp, aBuf, bBuf, { tolerance = 0, ignore = [] } = {}) {
	const [a, b] = await Promise.all(
		[aBuf, bBuf].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })),
	);
	if (a.info.width !== b.info.width || a.info.height !== b.info.height)
		return { differing: 1, max: 255, size: `${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}` };
	let differing = 0;
	let counted = 0;
	let max = 0;
	const { width, channels } = a.info;
	for (let y = 0; y < a.info.height; y += 1)
		for (let x = 0; x < width; x += 1) {
			if (masked(ignore, x, y)) continue;
			const p = (y * width + x) * channels;
			let d = 0;
			for (let ch = 0; ch < 3; ch += 1) d = Math.max(d, Math.abs(a.data[p + ch] - b.data[p + ch]));
			if (d > max) max = d;
			if (d > tolerance) differing += 1;
			counted += 1;
		}
	return { differing: counted ? differing / counted : 0, max };
}

/** Where the glass sits on the canvas for one frame: phone offset + screen group. */
export function glassRect(spec, frame) {
	const g = spec.device.screenGroup;
	return {
		left: Math.round(frame.phone.x + g.x),
		top: Math.round(frame.phone.y + g.y),
		width: Math.round(g.w),
		height: Math.round(g.h),
	};
}

/** The full-width strip a fitted caption occupies, with slack for descenders. */
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
 * Calibration and safety, per mode.
 *
 * device-frame: re-render the source locale and diff against the design tool's
 * own render of the same frames, committed under `ref/`. That baseline is why a
 * geometry edit cannot quietly move the bezel.
 *
 * caption-band: re-render the source locale and compare caption ink width with
 * the live image (the wrap algorithm is right only if it reproduces the
 * designer's line breaks), then assert that every rendered locale differs from
 * the base *nowhere outside the band*.
 */
export async function verify(cfg, spec, captions, locales) {
	const ctx = await context(cfg, spec);
	const { sharp } = ctx;
	const sourceLocale = spec.base?.sourceLocale ?? cfg.asc.primaryLocale;
	const targets = sourceLineCounts(spec, captions, sourceLocale, ctx.loadFont);
	const rows = [];

	if (spec.mode === 'device-frame') {
		if (!spec.paths.ref || !existsSync(spec.paths.ref))
			throw new ShipError('no reference render to calibrate against', {
				hint: 'commit the design tool\'s own export of the source-locale frames and point `ref` at it',
			});
		const refs = await readdir(spec.paths.ref);
		for (const [i, frame] of spec.frames.entries()) {
			const rendered = await renderDeviceFrame(ctx, {
				locale: sourceLocale,
				frame,
				text: captions[sourceLocale][frame.key],
				targetLines: targets[frame.key],
			});
			const refName = refs.find((f) => f.startsWith(frame.key)) ?? refs[i];
			if (!refName) {
				rows.push({ frame: frame.key, ref: null });
				continue;
			}
			const delta = await pixelDelta(sharp, rendered.png, await readFile(join(spec.paths.ref, refName)), {
				// 8 absorbs rasteriser antialiasing without hiding a moved layer,
				// which shifts whole edges by far more than 8 levels.
				tolerance: 8,
				ignore: [glassRect(spec, frame), captionRect(spec, frame, rendered)],
			});
			rows.push({
				frame: frame.key,
				ref: refName,
				differing: delta.differing,
				max: delta.max,
				measures: 'background + bezel',
			});
		}
		return { mode: spec.mode, calibration: rows, safety: [] };
	}

	for (const frame of spec.frames) {
		const base = await baseImage(ctx, frame);
		const { png, size, lines } = await renderCaptionBand(ctx, {
			locale: sourceLocale,
			frame,
			text: captions[sourceLocale][frame.key],
			targetLines: targets[frame.key],
		});
		const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		const mine = measureBand({ data, width: info.width, channels: info.channels }, base.bounds, spec.band.inkTolerance);
		rows.push({
			frame: frame.key,
			flat: base.flat,
			size,
			inkDelta: (mine.ink?.width ?? 0) - base.ink.width,
			// A frame whose copy deliberately changed since the live image cannot
			// be calibrated against it — the ink is *supposed* to be a different
			// width. Naming the reason in the spec keeps that an exemption with a
			// paper trail instead of a threshold quietly raised until it passes.
			changed: frame.captionChanged ?? null,
			lines,
		});
	}

	// Nothing outside the band may move. This is the whole licence for the mode.
	const safety = [];
	for (const locale of locales) {
		let worst = 0;
		for (const [i, frame] of spec.frames.entries()) {
			const file = join(spec.paths.out, locale, spec.displayType, frameFile(spec, frame, i));
			if (!existsSync(file)) continue;
			const base = await baseImage(ctx, frame);
			const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
			const { y0, y1 } = base.bounds;
			for (let y = 0; y < info.height; y += 1) {
				if (y >= y0 && y < y1) continue;
				for (let x = 0; x < info.width; x += 1) {
					const p = (y * info.width + x) * info.channels;
					for (let ch = 0; ch < 3; ch += 1) {
						const d = Math.abs(data[p + ch] - base.raw.data[p + ch]);
						if (d > worst) worst = d;
					}
				}
			}
		}
		safety.push({ locale, maxOutsideBand: worst });
	}
	return { mode: spec.mode, calibration: rows, safety };
}

/** Ink width of one string at one size — used by tests and by `verify`. */
export const inkWidth = runWidth;
