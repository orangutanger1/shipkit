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

/** Canvas size in pixels; every other number in a spec is in this coordinate space. */
/** @typedef {{w: number, h: number}} Canvas */

/** A rect in mockup coordinates: the screen group and the artboard. */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/**
 * A caption box as the renderer consumes it: the top edge the block grows from,
 * the centre it stays on, and the width wrapping may use.
 * @typedef {{y: number, centre: number, wrap: number}} CaptionBox
 */

/**
 * A font entry resolved at load: `file` absolute, `variation` the variable-font
 * instance when the spec states one.
 * @typedef {{file: string|null, variation: Record<string, number>|null}} FontEntry
 */

/** The spec's font block with entries resolved to {@link FontEntry}. */
/** @typedef {{default: FontEntry, byLocale: Record<string, FontEntry>}} SpecFonts */

/** A font entry as written in the spec: a store-relative path or `{file, variation}`. */
/** @typedef {string|{file?: string|null, variation?: Record<string, number>|null}} RawFontEntry */

/** The font block as written. */
/** @typedef {{default?: RawFontEntry, byLocale?: Record<string, RawFontEntry>}} RawFonts */

/**
 * Caption typesetting, shared by both modes.
 * @typedef {Object} SpecType
 * @property {number} size
 * @property {number} lineHeight
 * @property {string} colour
 * @property {'balanced'|'greedy'} wrap
 * @property {number} targetMinSize
 * @property {number} minSize
 * @property {number} step
 * @property {number} gap
 * @property {number} extraLines
 * @property {number|null} margin
 * @property {string[]} perCharacterLocales
 * @property {SpecSubtitle|null} subtitle
 */

/**
 * The optional second run's ramp and baseline gap.
 * @typedef {Object} SpecSubtitle
 * @property {number} size
 * @property {number} lineHeight
 * @property {string} colour
 * @property {number} minSize
 * @property {number} step
 * @property {number} gap
 * @property {Record<string, number>|null} variation
 */

/**
 * caption-band only: how the band is found, gated and repainted.
 * @typedef {Object} SpecBand
 * @property {number} inkTolerance
 * @property {number} flatMin
 * @property {number} pad
 * @property {number} clearance
 */

/** One mockup layer export, in Figma z-order. */
/** @typedef {{file: string, x: number, y: number, w: number, h: number}} DeviceLayer */

/**
 * device-frame only: the mockup rebuilt from committed Figma layer exports.
 * @typedef {Object} SpecDevice
 * @property {number} w
 * @property {number} h
 * @property {string} [parts]
 * @property {number} screenIndex
 * @property {string} screenMask
 * @property {DeviceLayer[]} layers
 * @property {Rect} screenGroup
 * @property {Rect} artboard
 */

/**
 * device-frame only: how `ship shots capture` drives the app's web build.
 * @typedef {Object} SpecCapture
 * @property {string} [url]
 * @property {{width: number, height: number, deviceScaleFactor: number}} [viewport]
 * @property {boolean} [hideScrollbars]
 * @property {number} [settleMs]
 * @property {number} [timeoutMs]
 * @property {string|null} [localeParam]
 * @property {{seed?: string, default?: import('./util.mjs').JsonObject, byLocale?: Record<string, import('./util.mjs').JsonObject>}} [storage]
 * @property {Array<{frame: string, path?: string, waitFor?: string, evaluate?: string}>} [screens]
 */

/** A caption box as written; `centre`/`wrap` are derived at load. */
/** @typedef {{x?: number, y?: number, w?: number, centre?: number, wrap?: number}} RawCaption */

/**
 * One frame as written, before the validator fills defaults.
 * @typedef {Object} RawFrame
 * @property {string} [key]
 * @property {string} [src]
 * @property {string} [out]
 * @property {string} [node]
 * @property {string} [bg]
 * @property {{x: number, y: number}} [phone]
 * @property {RawCaption} [caption]
 * @property {number[][]} [crop]
 * @property {boolean} [cover]
 * @property {string} [base]
 * @property {number} [mockTop]
 * @property {number} [mockH]
 * @property {string} [captionChanged]
 */

/** Where this geometry came from in Figma, plus the pinned version. */
/** @typedef {{figmaFile?: string, frameIds?: Record<string, string>, page?: string, instance?: string, note?: string, version?: string, lastModified?: string, checkedAt?: string}} RawSource */

/** caption-band only: which finished images are repainted, and where from. */
/** @typedef {{sourceLocale?: string, country?: string, dir?: string}} RawBase */

/** Absolute paths derived from the spec and config at load. */
/** @typedef {{raw: string, out: string, captions: string, parts: string, ref: string|null, base: string}} SpecPaths */

/**
 * One frame after normalisation. Mode-required fields are typed as present —
 * the validator throws before a render reaches the mode that reads them.
 * @typedef {Object} ShotFrame
 * @property {string} key
 * @property {string} src
 * @property {string} [out]
 * @property {string} [node]
 * @property {string} [bg]
 * @property {{x: number, y: number}} phone
 * @property {CaptionBox} caption
 * @property {number[][]} crop
 * @property {boolean} [cover]
 * @property {string} base
 * @property {number} mockTop
 * @property {number} mockH
 * @property {string} [captionChanged]
 */

/**
 * The normalised spec every renderer consumes: blocks defaulted, paths
 * absolute, caption boxes carrying centre + wrap. Reached only through
 * {@link normaliseSpec}, which has validated or filled every field declared here.
 * @typedef {Object} ShotSpec
 * @property {'device-frame'|'caption-band'} mode
 * @property {string} displayType
 * @property {Canvas} canvas
 * @property {SpecType} type
 * @property {SpecBand} band
 * @property {SpecDevice} device
 * @property {SpecCapture} capture
 * @property {SpecFonts} fonts
 * @property {ShotFrame[]} frames
 * @property {RawSource} source
 * @property {RawBase} base
 * @property {string} [raw]
 * @property {string} [captions]
 * @property {string} [ref]
 * @property {SpecPaths} paths
 * @property {string} file
 */

/** One frame's copy: a headline, and the subtitle when the copy carries one. */
/** @typedef {{headline: string, subtitle: string|null}} CaptionRuns */

/** Caption copy as loaded: `locale → frameKey → copy`. */
/** @typedef {Record<string, import('./util.mjs').JsonObject>} Captions */

/**
 * A spec as parsed from JSON, before validation and defaulting. Blocks the
 * validator fills unconditionally (`type`, `band`, `paths`, `canvas`, `base`,
 * `source`) are typed as present because every read happens after the fill.
 * @typedef {Object} RawSpec
 * @property {string} mode
 * @property {string} displayType
 * @property {Canvas} canvas
 * @property {RawFrame[]} frames
 * @property {SpecType} type
 * @property {SpecBand} band
 * @property {SpecDevice} [device]
 * @property {SpecCapture} [capture]
 * @property {RawFonts} [fonts]
 * @property {RawSource} source
 * @property {RawBase} base
 * @property {string} [raw]
 * @property {string} [captions]
 * @property {string} [ref]
 * @property {SpecPaths} paths
 */

const MODES = ['device-frame', 'caption-band'];

/** Type defaults. Sizes are canvas pixels, matching Figma's own numbers. */
/** @type {SpecType} */
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
	/**
	 * Optional second text run. Absent — the normal case — a caption is one
	 * headline and every existing app renders byte-identically. Present, a frame
	 * whose copy carries a `subtitle` gets a second, smaller run beneath the
	 * headline, which is what the base art was authored with.
	 */
	subtitle: null,
};

/**
 * Subtitle ramp defaults, filled only when `type.subtitle` exists. The sizes are
 * deliberately not derived from the headline: the designer chose a ratio, and
 * guessing one produces a subtitle that is subtly wrong in every frame.
 */
/** @type {SpecSubtitle} */
const SUBTITLE_DEFAULTS = {
	size: 64,
	lineHeight: 80,
	colour: '#A0A0A0',
	minSize: 40,
	step: 2,
	/**
	 * Baseline-to-baseline: the headline's last baseline to the subtitle's first.
	 * Measured that way because that is what a design tool reports between two
	 * stacked text layers, and it does not move when either run shrinks.
	 */
	gap: 96,
	/**
	 * Variation axis for the subtitle's own face, when it differs from the
	 * headline's. A variable font opens on its default instance, so a subtitle
	 * meant to be lighter than a Bold headline needs the axis stated — inheriting
	 * the headline's `wght` is how the CJK captions once shipped at the wrong
	 * weight. Null keeps the locale's own font entry exactly as the headline uses it.
	 */
	variation: null,
};

/** @type {SpecBand} */
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
 * @param {import('../config.mjs').Config} cfg
 * @returns {(p: string|null|undefined) => string|null}
 */
const resolver = (cfg) => (p) => (p == null ? null : isAbsolute(p) ? p : join(cfg.paths.store, p));

/**
 * Load `store/<shots.spec>`; `null` when the app has no render pipeline, which
 * is the normal case — most repos bring finished PNGs and only upload them.
 * @param {import('../config.mjs').Config} cfg
 * @param {{required?: boolean}} [opts]
 * @returns {Promise<ShotSpec|null>}
 */
export async function loadSpec(cfg, { required = false } = {}) {
	const file = join(cfg.paths.store, cfg.shots.spec);
	if (!existsSync(file)) {
		if (!required) return null;
		throw new ShipError(`no screenshot spec at ${file}`, {
			hint: 'this repo uploads screenshots but does not render them; see `ship shots --help`',
		});
	}
	/** @type {RawSpec} */
	let raw;
	try {
		raw = JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, {
			hint: err instanceof Error ? err.message : String(err),
		});
	}
	return normaliseSpec(raw, cfg, file);
}

/**
 * Validate and fill a spec. Every failure here is one that would otherwise show
 * up as a wrong-looking PNG on the App Store, so they are all fatal.
 */
/**
 * Validate + default the type block, including the two-run subtitle axes.
 * @param {RawSpec} spec
 * @param {string} file
 * @returns {void}
 */
function normaliseType(spec, file) {
	spec.type = { ...TYPE_DEFAULTS, ...spec.type };
	if (!spec.type.subtitle) return;
	spec.type.subtitle = { ...SUBTITLE_DEFAULTS, ...spec.type.subtitle };
	const st = spec.type.subtitle;
	if (!(st.size > 0) || !(st.lineHeight > 0))
		throw new ShipError(`${file}: type.subtitle needs a positive size and lineHeight`);
	if (st.minSize > st.size)
		throw new ShipError(`${file}: type.subtitle.minSize (${st.minSize}) is above its size (${st.size})`, {
			hint: 'the fitter only ever shrinks, so a floor above the design size can never be reached',
		});
	if (!(st.step > 0)) throw new ShipError(`${file}: type.subtitle.step must be positive`);
}

/**
 * Resolve font entries (path or `{file, variation}`) and require a default face.
 * @param {RawSpec} spec
 * @param {(p: string|null|undefined) => string|null} abs
 * @param {string} file
 * @returns {void}
 */
function normaliseFonts(spec, abs, file) {
	// The variation is not decoration: a variable face opens on its default
	// instance, which for Noto Sans is Regular, so a design calling for Bold
	// silently renders light and every caption comes out narrower than the
	// reference.
	/** @param {RawFontEntry|undefined} v @returns {FontEntry} */
	const fontEntry = (v) =>
		typeof v === 'string' ? { file: abs(v), variation: null } : { file: abs(v?.file), variation: v?.variation ?? null };
	/** @type {SpecFonts} */
	const fonts = {
		default: fontEntry(spec.fonts?.default),
		byLocale: Object.fromEntries(
			Object.entries(spec.fonts?.byLocale ?? {}).map(([k, v]) => [k, fontEntry(v)]),
		),
	};
	spec.fonts = fonts;
	if (!fonts.default.file)
		throw new ShipError(`${file}: fonts.default is required`, {
			hint: 'point it at the same face the design uses; a substitute drifts caption widths',
		});
}

/**
 * Caption boxes: record each box's centre and the width wrapping may use.
 * @param {RawSpec} spec
 * @param {string} file
 * @returns {void}
 */
function normaliseCaptionBoxes(spec, file) {
	for (const frame of spec.frames) {
		if (!frame.key) throw new ShipError(`${file}: every frame needs a key`);
		/** @type {RawCaption} */
		const box = frame.caption ?? {};
		const centre = box.x != null && box.w != null ? box.x + box.w / 2 : spec.canvas.w / 2;
		const room =
			spec.type.margin == null
				? (box.w ?? spec.canvas.w)
				: 2 * Math.min(centre, spec.canvas.w - centre) - 2 * spec.type.margin;
		frame.caption = { ...box, centre, wrap: Math.max(box.w ?? 0, room) };
	}
}

/**
 * Validate and fill a spec. Every failure here is one that would otherwise show
 * up as a wrong-looking PNG on the App Store, so they are all fatal. The return
 * cast is the normalisation contract: everything {@link ShotSpec} declares has
 * been checked or filled above, which TS cannot follow through the in-place fills.
 * @param {RawSpec} raw
 * @param {import('../config.mjs').Config} cfg
 * @param {string} [file]
 * @returns {ShotSpec}
 */
export function normaliseSpec(raw, cfg, file = '<spec>') {
	const abs = resolver(cfg);
	// The paths below always pass a defaulted string, so the resolver never sees null.
	const absStr = /** @type {(p: string) => string} */ (abs);
	const spec = { ...raw, file };

	if (!MODES.includes(spec.mode))
		throw new ShipError(`${file}: mode must be one of ${MODES.join(', ')}`, {
			hint: 'device-frame rebuilds the mockup; caption-band repaints an existing composite',
		});
	if (!spec.canvas?.w || !spec.canvas?.h) throw new ShipError(`${file}: canvas.w and canvas.h are required`);
	if (!Array.isArray(spec.frames) || !spec.frames.length) throw new ShipError(`${file}: frames[] is empty`);

	spec.displayType = spec.displayType ?? 'IPHONE_65';
	normaliseType(spec, file);
	spec.band = { ...BAND_DEFAULTS, ...spec.band };
	spec.source = spec.source ?? {};
	normaliseFonts(spec, abs, file);

	spec.paths = {
		raw: absStr(spec.raw ?? 'screenshots-raw'),
		out: join(cfg.paths.store, 'screenshots'),
		captions: absStr(spec.captions ?? 'screenshot-captions.json'),
		parts: absStr(spec.device?.parts ?? 'figma-export/parts'),
		ref: abs(spec.ref ?? null),
		// Filled by normaliseBand; device-frame never reads it.
		base: '',
	};

	normaliseCaptionBoxes(spec, file);

	if (spec.mode === 'device-frame') normaliseDevice(spec, file);
	else normaliseBand(spec, cfg, file);

	return /** @type {ShotSpec} */ (spec);
}

/**
 * @param {RawSpec} spec
 * @param {string} file
 * @returns {void}
 */
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

/**
 * @param {RawSpec} spec
 * @param {import('../config.mjs').Config} cfg
 * @param {string} file
 * @returns {void}
 */
function normaliseBand(spec, cfg, file) {
	spec.base = spec.base ?? {};
	spec.base.sourceLocale = spec.base.sourceLocale ?? cfg.asc.primaryLocale;
	// With `dir` set the resolver always resolves it; its null belongs to absent paths.
	spec.paths.base = spec.base.dir
		? /** @type {string} */ (resolver(cfg)(spec.base.dir))
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
 * One frame's copy, as the renderer wants it.
 *
 * Copy is either a plain string — the headline, which is every app today — or
 * `{ headline, subtitle }`. A missing subtitle is not an error: a frame without
 * one renders the headline alone, positioned exactly as it is now.
 * @param {import('./util.mjs').Json|undefined} entry
 * @returns {CaptionRuns|null}
 */
export function captionRuns(entry) {
	if (entry == null) return null;
	if (typeof entry === 'string') return { headline: entry, subtitle: null };
	if (typeof entry === 'object' && !Array.isArray(entry) && typeof entry.headline === 'string')
		return {
			headline: entry.headline,
			subtitle: typeof entry.subtitle === 'string' ? entry.subtitle : null,
		};
	return null;
}

/**
 * Caption copy, normalised out of the two shapes in the wild:
 *   { "en-US": { "01": "…" } }                     — flat
 *   { "locales": { "en-US": { "captions": {…} } } } — annotated
 * Both round-trip to `locale → frameKey → string`.
 * @param {ShotSpec} spec
 * @returns {Promise<Captions>}
 */
export async function loadCaptions(spec) {
	/** @type {import('./util.mjs').Json} */
	const raw = JSON.parse(await readFile(spec.paths.captions, 'utf8'));
	const src =
		typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw.locales != null ? raw.locales : raw;
	/** @type {Record<string, import('./util.mjs').JsonObject>} */
	const out = {};
	for (const [locale, entry] of Object.entries(/** @type {Record<string, import('./util.mjs').Json>} */ (src))) {
		if (locale.startsWith('_') || locale === 'source' || locale === 'notes' || locale === 'frames')
			continue;
		const captions =
			entry !== null && typeof entry === 'object' && !Array.isArray(entry)
				? entry.captions ?? entry
				: entry;
		if (captions && typeof captions === 'object' && !Array.isArray(captions)) out[locale] = captions;
	}
	if (!Object.keys(out).length)
		throw new ShipError(`${spec.paths.captions} defines no locales`);
	return out;
}

/**
 * Locales to act on: explicit list, else every locale with caption copy.
 * @param {import('../config.mjs').Config} cfg
 * @param {Captions} captions
 * @param {string[]} [requested]
 * @returns {string[]}
 */
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
