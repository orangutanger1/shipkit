// Screenshots — measured, rendered, uploaded.
//
// There is still no macOS, no Xcode and no simulator here, and nothing below
// pretends otherwise. `plan`, `validate` and `upload` read PNG/JPEG files that
// already exist on disk, measure them by parsing their own headers
// (src/lib/img-size.mjs), and hand them to `asc` (src/lib/shots-asc.mjs) — the
// whole contract for a repo that brings finished images from a Mac, a device,
// or a designer's export. With a committed design spec (store/figma-geometry.json),
// `capture` + `render` make the images here — the app's web build driven
// headless, composited into the design's mockup, or Apple's own composites with
// only the caption band repainted — and `verify` proves them against the
// design's own reference render. Neither is a simulator shot; both are real pixels.
//
// Directory names carry the display type, and getting that wrong is the common
// failure: /home/myen/tour's 13 captures at docs/ad-assets/slides-src/*.png are
// 1170x2532, which is IPHONE_58 — dropping them into an IPHONE_65 directory
// fails validate. `ship shots validate` names the directory they belong in.
// Sizes are never hardcoded: `asc screenshots sizes` is the only source of truth,
// and Apple changes it whenever a new device ships.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { asc } from '../exec.mjs';
import { loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { Report, ShipError, c, heading, info, note, step, table, warn } from '../log.mjs';
import { emit } from '../lib/output.mjs';
import { readImageSize } from '../lib/img-size.mjs';
import {
	ascFindings, capPreflight, dirNameOf, dimsOf, fetchSizes, fmtDims, MAX_PER_GROUP,
	reportUpload, typeKey, uploadAppScoped, uploadPerLocale,
} from '../lib/shots-asc.mjs';
import { loadCaptions, loadSpec, localesFor } from '../lib/shots-spec.mjs';
import { renderLocales, verify as verifyRender } from '../lib/shots-render.mjs';
import { captureWeb, fetchLiveComposites } from '../lib/shots-capture.mjs';
import { downloadImages, driftOf, fileMeta, figmaToken, renderNodes } from '../lib/figma.mjs';

// Re-exported for `test/assets.test.mjs` and `ship preflight`.
export { readImageSize };
export { capVerdict, localizationId } from '../lib/shots-asc.mjs';

export const help = `
${c.bold('ship shots')} ${c.dim('— App Store screenshots, from files on disk')}

${c.dim('usage:')} ship shots [subcommand] [flags]

  ${c.cyan('sizes')}     ${c.dim('default')} display types and pixel dimensions Apple accepts (live from asc)
  ${c.cyan('capture')}   ${c.dim('spec')} take the raw inputs: web-build screens, or the live App Store composites
  ${c.cyan('render')}    ${c.dim('spec')} composite raw + captions into store/screenshots/<locale>/
  ${c.cyan('verify')}    ${c.dim('spec')} calibration + safety report against the design reference
  ${c.cyan('figma')}     ${c.dim('spec')} has the design moved? ${c.dim('(cheap; --export spends the render quota)')}
  ${c.cyan('plan')}      scan store/screenshots, measure every image, write .asc/screenshots.json
  ${c.cyan('validate')}  gate — wrong pixel size, empty group, or >10 images per group exits 1
  ${c.cyan('upload')}    push each locale/displayType group to a version localisation

${c.bold('Flags')}
  ${c.cyan('--all')}             ${c.dim('sizes')} every display type, including tv/vision/desktop
  ${c.cyan('--locale <l,…>')}    ${c.dim('all')} only these locales ${c.dim('(comma-separated; render/verify also take bare locale args)')}
  ${c.cyan('--display-type <t,…>')} ${c.dim('validate, upload')} only these display types ${c.dim('(e.g. IPHONE_65,IPHONE_67)')}
  ${c.cyan('--version <v>')}     ${c.dim('upload')} target version (default: app.json)
  ${c.cyan('--render')}          ${c.dim('upload')} re-render the in-scope locales first, then validate and push
  ${c.cyan('--force')}           ${c.dim('upload')} upload even though validate failed ${c.dim('· capture: re-download existing bases')}
  ${c.cyan('--replace')}         ${c.dim('upload')} clear the existing set first (default: skip by checksum)
  ${c.cyan('--pin')}             ${c.dim('figma')} record the live file version as the committed-export baseline
  ${c.cyan('--export <ids>')}    ${c.dim('figma')} re-export node images ${c.dim('(quota-limited; 429 keeps the committed copies)')}
  ${c.cyan('--json')}            machine-readable output
  ${c.cyan('--dry-run')}         ${c.dim('upload')} print the asc calls, change nothing

${c.bold('Layout')} ${c.dim('store/screenshots/<locale>/<displayType>/*.png')}
${c.dim('  e.g. store/screenshots/en-US/IPHONE_65/01-home.png')}

${c.dim('Capture is not a simulator: with a design spec, `capture` drives the app\'s own')}
${c.dim('web build headless, or downloads the composites Apple already serves. Without')}
${c.dim('one, bring the images yourself — shipkit will not invent pixels.')}
`;

const IMAGE_RE = /\.(png|jpe?g)$/i;

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */
/** @typedef {import('../lib/shots-spec.mjs').ShotSpec} ShotSpec */
/** @typedef {import('../lib/shots-spec.mjs').Captions} Captions */

/** @typedef {{file: string, path: string, bytes: number, width: number|null, height: number|null, format: string|null}} ScanFile */
/** @typedef {{displayType: string, dirName: string, dir: string, relDir: string, count: number, files: ScanFile[]}} ScanGroup */
/** @typedef {{locale: string, dir: string, groups: ScanGroup[]}} ScanLocale */
/** @typedef {{root: string, locales: ScanLocale[]}} ScanResult */
/** @typedef {ScanGroup & {locale: string}} FlatGroup */
/** @typedef {{locales: Set<string>|null, types: Set<string>|null}} Scope */

/**
 * @param {Config} cfg
 * @returns {Promise<ScanResult>}
 */
async function scan(cfg) {
	const root = join(cfg.paths.store, 'screenshots');
	if (!existsSync(root))
		throw new ShipError(`no screenshots directory: ${relative(cfg.root, root) || root}`, {
			hint: 'mkdir -p store/screenshots/en-US/IPHONE_65 and drop your captures in (Apple rejects a version with zero iPhone screenshots)',
		});

	const locales = [];
	for (const localeEnt of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!localeEnt.isDirectory()) continue;
		const localeDir = join(root, localeEnt.name);
		const groups = [];
		for (const typeEnt of (await readdir(localeDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!typeEnt.isDirectory()) continue;
			const dir = join(localeDir, typeEnt.name);
			const files = [];
			for (const name of (await readdir(dir)).sort()) {
				if (!IMAGE_RE.test(name)) continue;
				const buf = await readFile(join(dir, name));
				const size = readImageSize(buf);
				files.push({ file: name, path: join(dir, name), bytes: buf.length, width: size?.width ?? null, height: size?.height ?? null, format: size?.format ?? null });
			}
			groups.push({
				displayType: typeEnt.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
				dirName: typeEnt.name, dir, relDir: relative(cfg.root, dir), count: files.length, files,
			});
		}
		locales.push({ locale: localeEnt.name, dir: localeDir, groups });
	}
	// A missing tree is a hard error: a version with no screenshots is unsubmittable.
	if (!locales.length)
		throw new ShipError(`${relative(cfg.root, root) || root} has no locale directories`, {
			hint: 'expected store/screenshots/<locale>/<displayType>/*.png',
		});
	return { root, locales };
}

/**
 * Requested scope: comma-separated flags, absent = everything on disk; `iphone-6.5` matches `IPHONE_65`.
 * @param {Flags} flags
 * @returns {Scope}
 */
export function scopeOf(flags) {
	/** @param {string|boolean} [v] */
	const list = (v) =>
		typeof v === 'string'
			? v.split(',').map((s) => s.trim()).filter(Boolean)
			: [];
	const locales = list(flags.locale);
	const types = list(flags['display-type']);
	return {
		locales: locales.length ? new Set(locales) : null,
		types: types.length ? new Set(types.map(typeKey)) : null,
	};
}

/** @param {Scope} scope */
const scopeLabel = (scope) =>
	[scope.locales ? [...scope.locales].join(',') : null, scope.types ? [...scope.types].join(',') : null]
		.filter(Boolean)
		.join(' · ');

/**
 * Every group on disk, flattened, narrowed to `scope`. Callers report an empty match as an error.
 * @param {ScanResult} plan
 * @param {Scope} [scope]
 * @returns {FlatGroup[]}
 */
const flatGroups = (plan, scope = { locales: null, types: null }) =>
	plan.locales
		.filter((l) => !scope.locales || scope.locales.has(l.locale))
		.flatMap((l) =>
			l.groups
				.filter((g) => !scope.types || scope.types.has(typeKey(g.displayType)))
				.map((g) => ({ ...g, locale: l.locale })),
		);

/**
 * Names the operator asked for that no directory answers — a typo, not an empty
 * store. Kind-tagged, because a missing locale and a missing display type are
 * different mistakes, and checked as pairs once both axes exist (`--locale a,b
 * --display-type X,Y` asks for four groups); an absent axis is reported alone.
 * @param {FlatGroup[]} groups
 * @param {Scope} scope
 * @returns {string[]}
 */
export function unmatched(groups, scope) {
	/** @param {string|null} locale @param {string|null} type */
	const has = (locale, type) =>
		groups.some((g) => (!locale || g.locale === locale) && (!type || typeKey(g.displayType) === type));
	const miss = [];
	for (const l of scope.locales ?? []) if (!has(l, null)) miss.push(`locale ${l}`);
	for (const t of scope.types ?? []) if (!has(null, t)) miss.push(`display type ${t}`);
	if (miss.length || !scope.locales || !scope.types) return miss;
	for (const l of scope.locales)
		for (const t of scope.types) if (!has(l, t)) miss.push(`${l}/${t}`);
	return miss;
}

/** @param {SubCtx} ctx */
async function sizes({ flags }) {
	const rows = await fetchSizes({ all: !!flags.all });
	if (flags.json) return emit(rows);
	heading(`Accepted screenshot sizes ${c.dim(flags.all ? '(all families)' : '(iOS defaults — --all for everything)')}`);
	table(rows, [
		{ header: 'DISPLAY TYPE', get: (r) => r.displayType },
		{ header: 'FAMILY', get: (r) => r.family ?? '' },
		{ header: 'PIXEL DIMENSIONS', get: (r) => fmtDims(dimsOf(r)) },
	]);
	note(`${rows.length} display type${rows.length === 1 ? '' : 's'} — source: asc screenshots sizes`);
	note('directory name for `ship shots plan` = display type without the APP_ prefix, e.g. IPHONE_65');
	return 0;
}

// ----------------------------- render pipeline ------------------------------
// Everything above this line is file-driven: it measures PNGs and hands them to
// asc. Everything below *makes* those PNGs, and only runs for a committed design
// spec — the heavy libraries are resolved out of the app repo at call time.

/**
 * cfg + spec + caption copy + the locale list, the four things every render subcommand needs.
 * @param {SubCtx} ctx
 * @param {{required?: boolean}} [opts]
 * @returns {Promise<{cfg: Config, spec: ShotSpec, captions: Captions, locales: string[]}>}
 */
async function renderContext({ args, flags }, { required = true } = {}) {
	const cfg = await loadConfig();
	const spec = await loadSpec(cfg, { required });
	if (!spec) return /** @type {{cfg: Config, spec: ShotSpec, captions: Captions, locales: string[]}} */ (/** @type {unknown} */ ({ cfg, spec: null }));
	const captions = await loadCaptions(spec);
	const scope = scopeOf(flags);
	const requested = args.length ? args : scope.locales ? [...scope.locales] : [];
	const locales = localesFor(cfg, captions, requested);
	if (!locales.length) throw new ShipError('no locales to render');
	return { cfg, spec, captions, locales };
}

/**
 * Acquire the raw inputs; the mode split is the whole reason both modes exist.
 * @param {SubCtx} ctx
 */
async function capture({ args, flags }) {
	const { cfg, spec, locales } = await renderContext({ args, flags });
	if (spec.mode === 'caption-band') {
		heading(`Base composites ${c.dim(`${cfg.name} · live App Store images`)}`);
		const files = await fetchLiveComposites(cfg, spec, { force: !!flags.force });
		info(`${files.length} base image${files.length === 1 ? '' : 's'} in ${relative(cfg.root, spec.paths.base)}`);
		return files.length ? 0 : 1;
	}

	heading(`Capture ${c.dim(`${locales.length} locale${locales.length === 1 ? '' : 's'} · ${spec.capture?.url ?? ''}`)}`);
	const shot = await captureWeb(cfg, spec, locales, {
		onFrame: (/** @type {{locale: string, frame: string}} */ { locale, frame }) => step(`${locale}/${frame}`),
	});
	info(`${shot.length} capture${shot.length === 1 ? '' : 's'} → ${relative(cfg.root, spec.paths.raw)}`);
	note('these are inputs, not deliverables — run `ship shots render` to composite them');
	return 0;
}

/**
 * Composite raw captures + caption copy into the tree `upload` reads.
 * @param {SubCtx} ctx
 */
async function render({ args, flags }) {
	const { cfg, spec, captions, locales } = await renderContext({ args, flags });
	heading(`Render ${c.dim(`${spec.mode} · ${locales.length} locale${locales.length === 1 ? '' : 's'} · ${spec.displayType}`)}`);

	const rows = await renderLocales(cfg, spec, captions, locales, {
		onFrame: (r) =>
			flags.json
				? null
				: note(
						`${r.locale}/${r.frame} ${r.lines.length}L${r.size === spec.type.size ? '' : ` [${r.size}px]`} ${r.lines.join(' / ')}${
							r.subtitle ? c.dim(` — ${r.subtitle.join(' / ')}`) : ''
						}`,
					),
	});

	if (flags.json)
		return emit({ mode: spec.mode, displayType: spec.displayType, frames: rows.map((r) => ({ ...r, file: relative(cfg.root, r.file) })) });
	// A shrunk caption is the early warning for a locale whose copy is too long.
	const shrunk = rows.filter((r) => r.size !== spec.type.size);
	info(`${rows.length} image${rows.length === 1 ? '' : 's'} → ${relative(cfg.root, spec.paths.out)}`);
	if (shrunk.length)
		warn(`${shrunk.length} caption${shrunk.length === 1 ? '' : 's'} shrunk below ${spec.type.size}px: ${[...new Set(shrunk.map((r) => r.locale))].join(', ')}`);
	note('run `ship shots validate` next, then `ship shots upload`');
	return 0;
}

/** @typedef {{frame: string, ref: string|null, differing?: number, max?: number, measures?: string}} CalRowDeviceFrame */
/** @typedef {{frame: string, flat: number, size: number, inkDelta: number, changed: string|null, lines: string[]}} CalRowCaptionBand */
/** @typedef {{locale: string, maxOutsideBand: number}} SafetyRow */
/** @typedef {{mode: 'device-frame', calibration: CalRowDeviceFrame[], safety: SafetyRow[]}} VerifyDeviceFrame */
/** @typedef {{mode: 'caption-band', calibration: CalRowCaptionBand[], safety: SafetyRow[]}} VerifyCaptionBand */
/** @typedef {VerifyDeviceFrame|VerifyCaptionBand} VerifyResult */

/**
 * Calibration + safety: the evidence that the renderer still reproduces the design.
 * @param {SubCtx} ctx
 */
async function verifyShots({ args, flags }) {
	const { cfg, spec, captions, locales } = await renderContext({ args, flags });
	const res = /** @type {VerifyResult} */ (await verifyRender(cfg, spec, captions, locales));

	if (flags.json) {
		emit(/** @type {import('../lib/util.mjs').Json} */ (/** @type {unknown} */ (res)));
	} else if (res.mode === 'device-frame') {
		heading(`Calibration ${c.dim('re-render of the source locale vs the design tool\'s own export')}`);
		table(res.calibration, [
			{ header: 'FRAME', get: (r) => r.frame },
			{ header: 'REFERENCE', get: (r) => r.ref ?? c.yellow('none') },
			{ header: 'BG+BEZEL DIFFERING', get: (r) => (r.differing == null ? '' : `${(r.differing * 100).toFixed(2)}%`) },
			{ header: 'MAX Δ', get: (r) => (r.max == null ? '' : r.max) },
		]);
		note('the glass and the caption are excluded: the reference shows placeholder screens, and two rasterisers never agree on antialiased 128px type');
	} else {
		heading(`Calibration ${c.dim('re-render of the source locale vs the live App Store images')}`);
		table(res.calibration, [
			{ header: 'FRAME', get: (r) => r.frame },
			{ header: 'BAND FLAT', get: (r) => `${(r.flat * 100).toFixed(1)}%` },
			{ header: 'PT', get: (r) => r.size },
			{ header: 'Δ INK WIDTH', get: (r) => (r.changed ? c.dim(`${r.inkDelta}px (copy changed)`) : `${r.inkDelta > 0 ? '+' : ''}${r.inkDelta}px`) },
			{ header: 'LINES', get: (r) => r.lines.join(' / ') },
		]);
		heading('Safety — pixels changed outside the caption band');
		table(res.safety, [{ header: 'LOCALE', get: (r) => r.locale }, { header: 'MAX Δ OUTSIDE BAND', get: (r) => r.maxOutsideBand }]);
	}

	// Thresholds, not vibes. Ink width that far off means the wrap algorithm is
	// not reproducing the designer's line breaks; any pixel changed outside the
	// band means the band bounds are wrong and artwork is being destroyed.
	const fails = [];
	if (res.mode === 'caption-band') {
		const drift = res.calibration.filter((r) => !r.changed && Math.abs(r.inkDelta) > /** @type {number} */ (/** @type {unknown} */ (flags['ink-tolerance'] ?? 2)));
		if (drift.length) fails.push(`ink width drifted on ${drift.map((r) => r.frame).join(', ')}`);
		const bled = res.safety.filter((r) => r.maxOutsideBand > 0);
		if (bled.length) fails.push(`pixels changed outside the band for ${bled.map((r) => r.locale).join(', ')}`);
	} else {
		const off = res.calibration.filter((r) => (r.differing ?? 1) > /** @type {number} */ (/** @type {unknown} */ (flags['pixel-tolerance'] ?? 0.03)));
		if (off.length) fails.push(`reference mismatch on ${off.map((r) => r.frame).join(', ')}`);
	}
	if (fails.length && !flags.json) for (const f of fails) warn(f);
	return fails.length ? 1 : 0;
}

/**
 * Figma, which is a quota and not a service you call: the default drift check is cheap, --export spends the day's budget.
 * @param {SubCtx} ctx
 */
async function figma({ args, flags }) {
	const { cfg, spec } = await renderContext({ args, flags });
	const token = await figmaToken();
	if (!token)
		throw new ShipError('no Figma token', { hint: 'export FIGMA_API_KEY, or put it in ~/.omp/figma.key' });
	const fileKey = spec.source?.figmaFile;
	if (!fileKey) throw new ShipError(`${spec.file}: source.figmaFile is not set`);

	heading(`Figma ${c.dim(fileKey)}`);
	const meta = await fileMeta(fileKey, token);
	const drift = driftOf(spec, meta);
	info(`${meta.name} · version ${meta.version} · edited ${meta.lastModified}`);
	if (drift.drifted === null) note('spec records no version — run with --pin to record this one as the baseline');
	else if (drift.drifted) warn(`design has moved since the committed exports (spec ${drift.known} → live ${drift.live})`);
	else info('committed exports match the live file');

	if (flags.pin) {
		const raw = JSON.parse(await readFile(spec.file, 'utf8'));
		raw.source = { ...raw.source, version: meta.version, lastModified: meta.lastModified, checkedAt: new Date().toISOString() };
		await writeFile(spec.file, `${JSON.stringify(raw, null, '\t')}\n`);
		note(`pinned ${relative(cfg.root, spec.file)} to version ${meta.version}`);
	}

	// Only now do we touch the endpoint that runs out. Refusing by default is
	// the point: the committed exports are build inputs, and re-exporting them
	// on a whim is how a repo ends up unable to render for the rest of the day.
	if (flags.export) {
		const ids = flags.export === true ? Object.values(spec.source.frameIds ?? {}) : String(flags.export).split(',');
		if (!ids.length) throw new ShipError('nothing to export — pass --export <nodeId,…> or set source.frameIds');
		const dir = join(spec.paths.ref ?? spec.paths.parts);
		try {
			const images = await renderNodes(fileKey, ids, token, { scale: flags.scale ? Number(flags.scale) : 1 });
			const files = await downloadImages(images, dir);
			info(`exported ${files.length} node${files.length === 1 ? '' : 's'} → ${relative(cfg.root, dir)}`);
			note('commit these — they are build inputs, and the quota will not serve them again today');
		} catch (err) {
			if (!(/** @type {{quota?: boolean}} */ (err)).quota) throw err;
			// The committed copies are exactly the fallback this design bought.
			warn('Figma render quota exhausted (429) — keeping the committed exports');
			note('this is survivable by design; re-run tomorrow if you actually need new artwork');
			return existsSync(dir) ? 0 : 1;
		}
	}
	return drift.drifted ? 1 : 0;
}

/** @typedef {{displayType: string, dir: string, count: number, files: Omit<ScanFile, 'path'>[]}} PlanGroup */
/** @typedef {{generatedAt: string, app: string|undefined, root: string, locales: {locale: string, groups: PlanGroup[]}[], totals?: {locales: number, groups: number, files: number}}} PlanOutput */

/** @param {SubCtx} ctx */
async function plan({ flags }) {
	const cfg = await loadConfig();
	const found = await scan(cfg);
	/** @type {PlanOutput} */
	const out = {
		generatedAt: new Date().toISOString(),
		app: cfg.name,
		root: relative(cfg.root, found.root),
		locales: found.locales.map((l) => ({
			locale: l.locale,
			groups: l.groups.map((g) => ({
				displayType: g.displayType, dir: g.relDir, count: g.count, files: g.files.map(({ path: _path, ...f }) => f),
			})),
		})),
	};
	const groups = flatGroups(found);
	out.totals = { locales: found.locales.length, groups: groups.length, files: groups.reduce((n, g) => n + g.count, 0) };

	const file = join(cfg.root, '.asc', 'screenshots.json');
	await mkdir(join(cfg.root, '.asc'), { recursive: true });
	await writeFile(file, `${JSON.stringify(out, null, '\t')}\n`);

	if (flags.json) return emit(/** @type {import('../lib/util.mjs').Json} */ (/** @type {unknown} */ (out)));
	heading(`Screenshot inventory ${c.dim(out.root)}`);
	table(groups, [
		{ header: 'LOCALE', get: (g) => g.locale },
		{ header: 'DISPLAY TYPE', get: (g) => g.displayType },
		{ header: 'N', get: (g) => g.count },
		{ header: 'DIMENSIONS', get: (g) => [...new Set(g.files.map((f) => (f.width ? `${f.width}x${f.height}` : 'unreadable')))].join(' ') },
	]);
	for (const l of found.locales) {
		const n = l.groups.reduce((acc, g) => acc + g.count, 0);
		info(`${c.bold(l.locale)}: ${n} image${n === 1 ? '' : 's'} across ${l.groups.length} display type${l.groups.length === 1 ? '' : 's'}`);
	}
	const unreadable = groups.flatMap((g) => g.files.filter((f) => !f.width).map((f) => `${g.locale}/${g.displayType}/${f.file}`));
	if (unreadable.length) warn(`unreadable image header: ${unreadable.join(', ')}`);
	note(`wrote ${relative(cfg.root, file)}`);
	return 0;
}

/**
 * Offline gate: wrong pixel size, an empty group, or more than ten images —
 * everything here fails a submission at Apple, so it fails here first.
 * `asc screenshots validate` runs per group on top, and its findings fold in.
 * `--locale`/`--display-type` narrow it to the same groups `upload` would push;
 * `pre` lets `upload` hand over the config and inventory it already read.
 * @param {{flags: Flags}} ctx
 * @param {{cfg?: Config, found?: ScanResult}} [pre]
 */
async function validate({ flags }, pre = {}) {
	const cfg = pre.cfg ?? (await loadConfig());
	const scope = scopeOf(flags);
	const [found, sizeRows] = await Promise.all([pre.found ?? scan(cfg), fetchSizes({ all: true })]);
	const accepted = new Map(sizeRows.map((r) => [typeKey(r.displayType), dimsOf(r)]));
	const scoped = flatGroups(found, scope);
	const label0 = scopeLabel(scope);

	const report = new Report(`Screenshots — ${cfg.name}${label0 ? ` ${c.dim(`(${label0})`)}` : ''}`);
	for (const name of unmatched(scoped, scope))
		report.fail(name, 'no screenshot directory on disk — see `ship shots plan`');
	for (const g of scoped) {
		const label = `${g.locale}/${g.displayType}`;
		const dims = accepted.get(typeKey(g.displayType));
		if (!dims) {
			report.fail(label, `unknown display type — see \`ship shots sizes --all\``);
			continue;
		}
		if (g.count === 0) {
			report.fail(label, 'no images — Apple requires at least one per display type it lists');
			continue;
		}
		if (g.count > MAX_PER_GROUP) report.fail(label, `${g.count} images, Apple accepts at most ${MAX_PER_GROUP}`);

		const wrong = g.files.filter((f) => !dims.some((d) => d.width === f.width && d.height === f.height));
		for (const f of wrong) {
			// A capture fitting a *different* display type is just in the wrong
			// directory, and saying which one turns a rejection into a `mv`.
			const fits = sizeRows.filter((r) => dimsOf(r).some((d) => d.width === f.width && d.height === f.height)).map((r) => dirNameOf(r.displayType));
			const suggestion = fits.length ? ` — move it to ${[...new Set(fits)].join(' or ')}/` : '';
			report.fail(`${label}/${f.file}`, `${f.width ?? '?'}x${f.height ?? '?'} — accepted: ${fmtDims(dims)}${suggestion}`);
		}
		if (!wrong.length && g.count <= MAX_PER_GROUP)
			report.ok(label, `${g.count} × ${g.files[0].width}x${g.files[0].height}`);

		// asc knows things we don't (alpha channel, colour space, aspect rules).
		const res = await asc(['screenshots', 'validate', '--path', g.dir, '--device-type', g.displayType], {
			fallback: null,
			allowFail: true,
		});
		for (const finding of ascFindings(/** @type {Parameters<typeof ascFindings>[0]} */ (res))) {
			if (finding.level === 'fail') report.fail(`asc ${label}`, finding.message);
			else report.warn(`asc ${label}`, finding.message);
		}
	}
	return report.print({ json: !!flags.json });
}

/**
 * Step 1 of `upload`: `--render` renders, then upload measures what was just
 * written, in one command. Scope has to agree across both halves or the upload
 * is incoherent: with --locale only those locales move; without it, asc's
 * app-scoped fan-out walks every locale directory on disk, so render must cover
 * every configured locale too — hence the same scope resolution, not a separate list.
 * @param {SubCtx} ctx
 */
async function renderChain({ args, flags }) {
	if (!flags.render) return 0;
	const code = await render({ args, flags });
	if (code !== 0) return code;
	// Re-rendered bytes are new bytes, so --skip-existing will not skip them:
	// they append beside the attached set unless it is replaced.
	if (!flags.replace)
		note('re-rendered images differ byte-wise from what is attached — `--replace` swaps the set instead of appending');
	return 0;
}

/** @param {{args?: string[], flags: Flags}} ctx */
async function upload({ args = [], flags }) {
	const cfg = await loadConfig();
	const rendered = await renderChain({ args, flags });
	if (rendered !== 0) return rendered;
	const found = await scan(cfg);
	if (!flags.force) {
		const code = await validate({ flags: { ...flags, json: false } }, { cfg, found });
		if (code !== 0)
			throw new ShipError('screenshots failed validation — refusing to upload', {
				hint: 'fix the failures above, or re-run with --force',
			});
	}

	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, /** @type {string|undefined} */ (flags.version));

	const scope = scopeOf(flags);
	const groups = flatGroups(found, scope);
	const missing = unmatched(groups, scope);
	if (missing.length)
		throw new ShipError(`no screenshots on disk for ${missing.join(', ')}`, {
			hint: 'run `ship shots plan` to see which locales and display types exist on disk',
		});
	if (!groups.length)
		throw new ShipError('no screenshot groups match the requested scope', {
			hint: 'run `ship shots plan` to see which locales and display types exist on disk',
		});

	// Skip by checksum by default; --replace clears the set first. A set silently
	// grown past 10 is rejected at submission.
	const mode = flags.replace ? ['--replace'] : ['--skip-existing'];

	const ascGroups = /** @type {import('../lib/shots-asc.mjs').ShotGroup[]} */ (/** @type {unknown} */ (groups));
	await capPreflight({ appId, version, groups: ascGroups, replace: !!flags.replace, force: !!flags.force });

	const results = scope.locales ? await uploadPerLocale({ appId, version, groups: ascGroups, mode }) : await uploadAppScoped({
		appId, version, platform: cfg.asc.platform ?? 'IOS', root: join(cfg.paths.store, 'screenshots'), groups: ascGroups, mode,
	});
	return reportUpload({ appId, version, results, flags });
}

const SUB = { sizes, capture, render, verify: verifyShots, figma, plan, validate, upload };

/** @param {SubCtx} ctx */
export async function run({ args, flags }) {
	const [sub = 'sizes', ...rest] = args;
	const fn = SUB[/** @type {keyof typeof SUB} */ (sub)];
	if (!fn)
		throw new ShipError(`shots: unknown subcommand "${sub}"`, {
			hint: `try: ${Object.keys(SUB).join(', ')}`,
		});
	return fn({ args: rest, flags });
}
