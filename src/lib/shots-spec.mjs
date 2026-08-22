// The screenshot design spec — one committed JSON file describing what a store
// screenshot is made of, transcribed from the Figma node tree.
//
// Everything the renderer needs is data: frame geometry, the device mockup layer
// stack, caption boxes, type, and which raw capture goes behind the glass. Two
// apps needed two composition strategies and the difference is one field:
//
//   device-frame  the mockup is rebuilt from Figma layer exports each run, with
//                 a fresh app capture masked into the screen cutout. Requires
//                 real localized captures.
//   caption-band  the finished composite already exists (Apple is serving it),
//                 and only the flat caption band is repainted. Requires nothing
//                 from the app, which is the point: it works when the web build
//                 is not a faithful stand-in for the device UI.
//
// Both read the same caption file and the same type block, so a locale added to
// one is added the same way to the other.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ShipError } from '../log.mjs';

export const MODES = ['device-frame', 'caption-band'];

/** Type defaults. Sizes are canvas pixels, matching Figma's own numbers. */
const TYPE_DEFAULTS = {
	size: 128,
	lineHeight: 160,
	colour: '#FFFFFF',
	/**
	 * `balanced` minimises squared slack so no line is left an orphan word.
	 * `greedy` is what Figma itself does, and the two disagree: on glovebox's
	 * frame 2 balanced split "Log a service / in 15 seconds." where the designer
	 * saw "Log a service in 15 / seconds.". Match the source of truth for the
	 * frames you are reproducing, not the prettier algorithm.
	 */
	wrap: 'balanced',
	/** Shrink floor when holding the source line count, then the absolute floor. */
	targetMinSize: 96,
	minSize: 56,
	step: 2,
	/** Vertical breathing room kept between the caption block and the mockup. */
	gap: 24,
	/**
	 * Lines a localized caption may take beyond the source locale's count before
	 * the fitter starts shrinking. 0 holds the design's rhythm exactly; 1 suits a
	 * set whose captions are single sentences that some languages simply cannot
	 * say in two lines at 128px.
	 */
	extraLines: 0,
	/**
	 * Designers vary caption box widths per frame while keeping one centre; a
	 * narrow box would shrink a long localized string for no design reason.
	 * Widen every box to this side margin, preserving its centre.
	 */
	margin: null,
	/** Locales whose captions break between characters, having no spaces. */
	perCharacterLocales: ['ja', 'ko', 'zh-Hans', 'zh-Hant', 'th'],
};

const BAND_DEFAULTS = {
	/** Per-channel distance from the band background that counts as glyph ink. */
	inkTolerance: 26,
	/**
	 * Minimum share of the band that must be one flat colour. Below this the
	 * band holds artwork, and repainting it would destroy pixels the design
	 * needs — a hard stop, not a warning.
	 */
	flatMin: 0.85,
	/** Keep the redrawn block this far inside the band. */
	pad: 8,
	/** Clearance between the band edge and the mockup. */
	clearance: 4,
};

/**
 * Resolve a spec-relative path. Spec paths are relative to the store directory,
 * so a spec can be copied between repos whose app roots differ.
 */
const resolver = (cfg) => (p) => (p == null ? null : isAbsolute(p) ? p : join(cfg.paths.store, p));

/**
 * Load `store/<shots.spec>`; `null` when the app has no render pipeline, which
 * is the normal case — most repos bring finished PNGs and only upload them.
 */
export async function loadSpec(cfg, { required = false } = {}) {
	const file = join(cfg.paths.store, cfg.shots.spec);
	if (!existsSync(file)) {
		if (!required) return null;
		throw new ShipError(`no screenshot spec at ${file}`, {
			hint: 'this repo uploads screenshots but does not render them; see `ship shots --help`',
		});
	}
	let raw;
	try {
		raw = JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
	return normaliseSpec(raw, cfg, file);
}

/**
 * Validate and fill a spec. Every failure here is one that would otherwise show
 * up as a wrong-looking PNG on the App Store, so they are all fatal.
 */
export function normaliseSpec(raw, cfg, file = '<spec>') {
	const abs = resolver(cfg);
	const spec = { ...raw, file };

	if (!MODES.includes(spec.mode))
		throw new ShipError(`${file}: mode must be one of ${MODES.join(', ')}`, {
			hint: 'device-frame rebuilds the mockup; caption-band repaints an existing composite',
		});
	if (!spec.canvas?.w || !spec.canvas?.h)
		throw new ShipError(`${file}: canvas.w and canvas.h are required`);
	if (!Array.isArray(spec.frames) || !spec.frames.length)
		throw new ShipError(`${file}: frames[] is empty`);

	spec.displayType = spec.displayType ?? 'IPHONE_65';
	spec.type = { ...TYPE_DEFAULTS, ...(spec.type ?? {}) };
	spec.band = { ...BAND_DEFAULTS, ...(spec.band ?? {}) };
	spec.source = spec.source ?? {};

	// A font entry is either a path or `{ file, variation }`. The variation is
	// not decoration: a variable face opens on its default instance, which for
	// Noto Sans is Regular, so a design calling for Bold silently renders light
	// and every caption comes out narrower than the reference.
	const fontEntry = (v) =>
		typeof v === 'string' ? { file: abs(v), variation: null } : { file: abs(v?.file), variation: v?.variation ?? null };
	spec.fonts = {
		default: fontEntry(spec.fonts?.default),
		byLocale: Object.fromEntries(
			Object.entries(spec.fonts?.byLocale ?? {}).map(([k, v]) => [k, fontEntry(v)]),
		),
	};
	if (!spec.fonts.default.file)
		throw new ShipError(`${file}: fonts.default is required`, {
			hint: 'point it at the same face the design uses; a substitute drifts caption widths',
		});

	spec.paths = {
		raw: abs(spec.raw ?? 'screenshots-raw'),
		out: join(cfg.paths.store, 'screenshots'),
		captions: abs(spec.captions ?? 'screenshot-captions.json'),
		parts: abs(spec.device?.parts ?? 'figma-export/parts'),
		ref: abs(spec.ref ?? null),
	};

	// Caption boxes: record each box's centre and the width wrapping may use.
	for (const frame of spec.frames) {
		if (!frame.key) throw new ShipError(`${file}: every frame needs a key`);
		const box = frame.caption ?? {};
		const centre = box.x != null && box.w != null ? box.x + box.w / 2 : spec.canvas.w / 2;
		const room =
			spec.type.margin == null
				? (box.w ?? spec.canvas.w)
				: 2 * Math.min(centre, spec.canvas.w - centre) - 2 * spec.type.margin;
		frame.caption = { ...box, centre, wrap: Math.max(box.w ?? 0, room) };
	}

	if (spec.mode === 'device-frame') normaliseDevice(spec, file);
	else normaliseBand(spec, cfg, file);

	return spec;
}

function normaliseDevice(spec, file) {
	const d = spec.device;
	if (!d?.w || !d?.h) throw new ShipError(`${file}: device.w and device.h are required`);
	if (!Array.isArray(d.layers) || !d.layers.length)
		throw new ShipError(`${file}: device.layers[] is required`, {
			hint: 'these are the committed Figma layer exports, in Figma z-order',
		});
	if (d.screenIndex == null)
		throw new ShipError(`${file}: device.screenIndex is required`, {
			hint: 'the z-order position the masked capture is inserted at',
		});
	d.screenMask = d.screenMask ?? 'screen-shape.png';
	if (!d.screenGroup || !d.artboard)
		throw new ShipError(`${file}: device.screenGroup and device.artboard are required`);
	for (const frame of spec.frames)
		if (!frame.src)
			throw new ShipError(`${file}: frame ${frame.key} needs src (the raw capture filename)`);
}

function normaliseBand(spec, cfg, file) {
	spec.base = spec.base ?? {};
	spec.base.sourceLocale = spec.base.sourceLocale ?? cfg.asc.primaryLocale;
	spec.paths.base = spec.base.dir
		? resolver(cfg)(spec.base.dir)
		: join(spec.paths.raw, spec.base.sourceLocale, spec.displayType);
	for (const frame of spec.frames) {
		frame.base = frame.base ?? `${frame.key}.png`;
		if (frame.mockTop == null || frame.mockH == null)
			throw new ShipError(`${file}: frame ${frame.key} needs mockTop and mockH`, {
				hint: 'they place the band above or below the mockup',
			});
	}
}

/**
 * Caption copy, normalised out of the two shapes in the wild:
 *   { "en-US": { "01": "…" } }                     — flat
 *   { "locales": { "en-US": { "captions": {…} } } } — annotated
 * Both round-trip to `locale → frameKey → string`.
 */
export async function loadCaptions(spec) {
	const raw = JSON.parse(await readFile(spec.paths.captions, 'utf8'));
	const src = raw.locales ?? raw;
	const out = {};
	for (const [locale, entry] of Object.entries(src)) {
		if (locale.startsWith('_') || locale === 'source' || locale === 'notes' || locale === 'frames')
			continue;
		const captions = entry?.captions ?? entry;
		if (captions && typeof captions === 'object') out[locale] = captions;
	}
	if (!Object.keys(out).length)
		throw new ShipError(`${spec.paths.captions} defines no locales`);
	return out;
}

/** Locales to act on: explicit list, else every locale with caption copy. */
export function localesFor(cfg, captions, requested) {
	const known = new Set(Object.keys(captions));
	if (requested?.length) {
		const missing = requested.filter((l) => !known.has(l));
		if (missing.length)
			throw new ShipError(`no caption copy for ${missing.join(', ')}`, {
				hint: `captions exist for: ${[...known].join(', ')}`,
			});
		return requested;
	}
	const configured = cfg.store.locales?.length ? cfg.store.locales : [...known];
	return configured.filter((l) => known.has(l));
}
