// Calibration and safety for screenshot rendering — did the background colour
// and the bezel land exactly where the design put them?
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ShipError } from '../log.mjs';
import { captionRect, frameFile, glassRect, measureBand, sourceLineCounts } from './shots-geometry.mjs';
import { baseImage, context, renderCaptionBand, renderDeviceFrame } from './shots-composite.mjs';
import { captionRuns } from './shots-spec.mjs';

/** @typedef {import('./shots-spec.mjs').ShotSpec} ShotSpec */
/** @typedef {import('./shots-spec.mjs').Captions} Captions */
/** @typedef {import('./shots-spec.mjs').CaptionRuns} CaptionRuns */
/** @typedef {import('./shots-composite.mjs').Ctx} Ctx */
/** @typedef {import('./shots-composite.mjs').BaseImage} BaseImage */
/** A rect in canvas pixels, as {@link glassRect} and {@link captionRect} return. */
/** @typedef {{left: number, top: number, width: number, height: number}} Rect */

/**
 * Is (x,y) inside any excluded rectangle?
 * @param {Rect[]} rects
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
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
 * @param {import('./appdeps.mjs').NativeModule} sharp
 * @param {Buffer} aBuf
 * @param {Buffer} bBuf
 * @param {{tolerance?: number, ignore?: Rect[]}} [opts]
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

/**
 * @param {Ctx} ctx
 * @param {ShotSpec} spec
 * @param {Captions} captions
 * @param {Record<string, number>} targets
 * @param {string} sourceLocale
 */
async function calibrateDeviceFrame(ctx, spec, captions, targets, sourceLocale) {
	const { sharp } = ctx;
	if (!spec.paths.ref || !existsSync(spec.paths.ref))
		throw new ShipError('no reference render to calibrate against', {
			hint: 'commit the design tool\'s own export of the source-locale frames and point `ref` at it',
		});
	const refs = await readdir(spec.paths.ref);
	const rows = [];
	for (const [i, frame] of spec.frames.entries()) {
		const rendered = await renderDeviceFrame(ctx, {
			locale: sourceLocale,
			frame,
			copy: /** @type {CaptionRuns} */ (captionRuns(captions[sourceLocale][frame.key])),
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
	return rows;
}

/**
 * @param {Ctx} ctx
 * @param {ShotSpec} spec
 * @param {Captions} captions
 * @param {Record<string, number>} targets
 * @param {string} sourceLocale
 */
async function calibrateCaptionBand(ctx, spec, captions, targets, sourceLocale) {
	const { sharp } = ctx;
	const rows = [];
	for (const frame of spec.frames) {
		const base = await baseImage(ctx, frame);
		const { png, size, lines } = await renderCaptionBand(ctx, {
			locale: sourceLocale,
			frame,
			copy: /** @type {CaptionRuns} */ (captionRuns(captions[sourceLocale][frame.key])),
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
	return rows;
}

/**
 * Nothing outside the band may move. This is the whole licence for the mode.
 * @param {Ctx} ctx
 * @param {ShotSpec} spec
 * @param {string[]} locales
 */
async function bandSafety(ctx, spec, locales) {
	const { sharp } = ctx;
	const safety = [];
	for (const locale of locales) {
		let worst = 0;
		for (const [i, frame] of spec.frames.entries()) {
			const file = join(spec.paths.out, locale, spec.displayType, frameFile(spec, frame, i));
			if (!existsSync(file)) continue;
			const base = await baseImage(ctx, frame);
			const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
			const { y0, y1 } = base.bounds;
			worst = Math.max(worst, worstOutsideBand({ data, info }, base, y0, y1));
		}
		safety.push({ locale, maxOutsideBand: worst });
	}
	return safety;
}

/**
 * @param {{data: Buffer, info: {width: number, height: number, channels: number}}} buffer
 * @param {BaseImage} base
 * @param {number} y0
 * @param {number} y1
 */
function worstOutsideBand({ data, info }, base, y0, y1) {
	let worst = 0;
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
	return worst;
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
 * @param {import('../config.mjs').Config} cfg
 * @param {ShotSpec} spec
 * @param {Captions} captions
 * @param {string[]} locales
 */
export async function verify(cfg, spec, captions, locales) {
	const ctx = await context(cfg, spec);
	const sourceLocale = spec.base?.sourceLocale ?? cfg.asc.primaryLocale;
	const targets = sourceLineCounts(spec, captions, sourceLocale, ctx.loadFont);

	if (spec.mode === 'device-frame') {
		const calibration = await calibrateDeviceFrame(ctx, spec, captions, targets, sourceLocale);
		return { mode: spec.mode, calibration, safety: [] };
	}

	const calibration = await calibrateCaptionBand(ctx, spec, captions, targets, sourceLocale);
	const safety = await bandSafety(ctx, spec, locales);
	return { mode: spec.mode, calibration, safety };
}
