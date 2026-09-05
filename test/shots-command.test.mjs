// `ship shots` end to end. The App Store Connect half runs against a fake
// `asc`; the render half runs against the stand-in sharp/fontkit/puppeteer in
// test/fixtures/native, which shipkit resolves out of the app repo exactly as
// it would resolve the real ones. Pixels are really encoded, decoded, masked
// and trimmed — the one thing the stand-in cannot do is rasterise glyph
// outlines, so a caption becomes the box its glyph rectangles cover.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { calls, capture, fakeBins, fakeHome, inDir, json, linkNativeDeps, repo, resetCalls, setBin, withFetch, writeFiles } from './fixtures/cmd.mjs';

await fakeHome();
await fakeBins(['asc']);

const { run } = await import('../src/commands/shots.mjs');
const sharp = (await import('../test/fixtures/native/sharp/index.cjs', { with: { type: 'commonjs' } }).catch(() => null))?.default
	?? (await import('node:module')).createRequire(import.meta.url)('./fixtures/native/sharp/index.cjs');

const CONFIG = {
	name: 'Demo', bundleId: 'com.demo.app', version: '1.2.0',
	asc: { appId: '111', primaryLocale: 'en-US', platform: 'IOS' },
	store: { locales: ['en-US', 'de-DE'] },
	shots: { spec: 'figma-geometry.json' },
};

const SIZES = { sizes: [
	{ displayType: 'APP_IPHONE_65', family: 'iPhone', dimensions: [{ width: 1242, height: 2688 }, { width: 1284, height: 2778 }] },
	{ displayType: 'APP_IPAD_PRO_3GEN_129', family: 'iPad', dimensions: [{ width: 2048, height: 2732 }] },
] };

/** @param {any[]} [extra] */
function ascOk(extra = []) {
	setBin('asc', [
		...extra,
		['screenshots sizes', { out: SIZES }],
		['versions list', { out: { data: [{ id: 'ver-1', attributes: { versionString: '1.2.0' } }] } }],
		['localizations list', { out: { data: [{ id: 'loc-1', attributes: { locale: 'en-US' } }] } }],
		['screenshots list', { out: { sets: [] } }],
		['screenshots validate', { out: { findings: [] } }],
		['screenshots upload', { out: { data: { id: 'up-1' } } }],
	]);
}

/** @param {string[]} args @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function shots(args, { flags = {}, dir, fetch = async () => json({}) }) {
	await resetCalls();
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

/** A PNG of exactly these pixel dimensions, written where the tree wants it. */
const png = (dir, rel, width, height, background = { r: 200, g: 200, b: 200, alpha: 1 }) =>
	sharp({ create: { width, height, channels: 4, background } }).png().toFile(join(dir, rel));

const shotsRepo = (files = {}, config = {}) => repo({ config: { ...CONFIG, ...config }, files, prefix: 'ship-shots-' });

test('an unknown subcommand names the ones that exist', async () => {
	const dir = await shotsRepo();
	await assert.rejects(() => shots(['sniff'], { dir }), /unknown subcommand "sniff"/);
});

test('sizes lists what Apple accepts', async () => {
	ascOk();
	const dir = await shotsRepo();
	const { code, out } = await shots(['sizes'], { dir });
	assert.equal(code, 0);
	assert.match(out, /APP_IPHONE_65/);
	assert.match(out, /1242x2688/);
	const { out: raw } = await shots(['sizes'], { dir, flags: { json: true, all: true } });
	assert.equal(JSON.parse(raw).length, 2);
});

test('plan inventories the tree and writes .asc/screenshots.json', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	await png(dir, 'store/screenshots/en-US/IPHONE_65/02.png', 1242, 2688);
	await writeFiles(dir, { 'store/screenshots/en-US/IPHONE_65/notes.txt': 'ignored' });
	const { code, out } = await shots(['plan'], { dir });
	assert.equal(code, 0);
	const doc = JSON.parse(await readFile(join(dir, '.asc', 'screenshots.json'), 'utf8'));
	assert.equal(doc.totals.files, 2, 'only images count');
	assert.equal(doc.locales[0].groups[0].displayType, 'IPHONE_65');
	assert.match(out, /1242x2688/);

	const { out: raw } = await shots(['plan'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).totals.locales, 1);
});

test('plan refuses a repo with no screenshot tree, and one with no locale directories', async () => {
	ascOk();
	const bare = await shotsRepo();
	await assert.rejects(() => shots(['plan'], { dir: bare }), /no screenshots directory/);
	const empty = await shotsRepo({ 'store/screenshots/.keep': '' });
	await assert.rejects(() => shots(['plan'], { dir: empty }), /has no locale directories/);
});

test('plan names an image whose header it cannot read', async () => {
	ascOk();
	const dir = await shotsRepo({ 'store/screenshots/en-US/IPHONE_65/broken.png': 'not a png' });
	const { out } = await shots(['plan'], { dir });
	assert.match(out, /unreadable image header/);
});

test('validate passes a correctly sized set and fails everything Apple would', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['validate'], { dir });
	assert.equal(code, 0);
	assert.match(out, /1 × 1242x2688/);

	const wrong = await shotsRepo();
	await png(wrong, 'store/screenshots/en-US/IPHONE_65/01.png', 2048, 2732);
	const { code: bad, out: badOut } = await shots(['validate'], { dir: wrong });
	assert.equal(bad, 1);
	assert.match(badOut, /accepted: 1242x2688/);
	assert.match(badOut, /move it to IPAD_PRO_3GEN_129/, 'a capture in the wrong directory is a `mv`, not a re-render');

	// A size that fits nothing Apple accepts at all is a bad export, not a
	// misfiled one — there is no `mv` to suggest.
	const nowhere = await shotsRepo();
	await png(nowhere, 'store/screenshots/en-US/IPHONE_65/01.png', 999, 999);
	const { out: nowhereOut } = await shots(['validate'], { dir: nowhere });
	assert.match(nowhereOut, /999x999 — accepted: 1242x2688 {2}1284x2778\n/, 'no size anywhere accepts this, so no "move it to" is appended');
});

test('validate fails an unknown display type, an empty group and an over-full one', async () => {
	ascOk();
	const unknown = await shotsRepo();
	await png(unknown, 'store/screenshots/en-US/WATCH_ULTRA/01.png', 100, 100);
	const { out } = await shots(['validate'], { dir: unknown });
	assert.match(out, /unknown display type/);

	const empty = await shotsRepo({ 'store/screenshots/en-US/IPHONE_65/.keep': '' });
	const { out: none } = await shots(['validate'], { dir: empty });
	assert.match(none, /no images — Apple requires at least one/);

	const many = await shotsRepo();
	for (let i = 0; i < 11; i++) await png(many, `store/screenshots/en-US/IPHONE_65/${i}.png`, 1242, 2688);
	const { out: over } = await shots(['validate'], { dir: many });
	assert.match(over, /11 images, Apple accepts at most 10/);
});

test('validate folds in what asc found, and narrows to the requested scope', async () => {
	ascOk([['screenshots validate', { out: { errors: [{ message: 'alpha channel present' }], warnings: ['unusual aspect'] } }]]);
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['validate'], { dir, flags: { locale: 'en-US', 'display-type': 'iphone-6.5' } });
	assert.equal(code, 1);
	assert.match(out, /alpha channel present/);
	assert.match(out, /unusual aspect/);

	const { out: typo } = await shots(['validate'], { dir, flags: { locale: 'fr-FR' } });
	assert.match(typo, /locale fr-FR/);
	assert.match(typo, /no screenshot directory on disk/);
});

test('validate names a --display-type that exists nowhere on its own', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { out: badType } = await shots(['validate'], { dir, flags: { 'display-type': 'watch-ultra' } });
	assert.match(badType, /display type WATCHULTRA/);
});

test('validate names a specific locale/display-type pairing that is missing, even though each axis exists elsewhere', async () => {
	// en-US never shipped an iPad shot, and de-DE never shipped an iPhone one —
	// each requested locale and each requested display type exists *somewhere*
	// in scope, so neither axis alone is the miss; only the pairing is.
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	await png(dir, 'store/screenshots/de-DE/IPAD_PRO_3GEN_129/01.png', 2048, 2732);
	const { out } = await shots(['validate'], {
		dir,
		flags: { locale: 'en-US,de-DE', 'display-type': 'iphone-6.5,ipad-pro-3gen-12.9' },
	});
	assert.match(out, /en-US\/IPADPRO3GEN129/);
	assert.match(out, /de-DE\/IPHONE65/);
});

test('upload pushes each display type app-scoped, and reports what asc said', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['upload'], { dir });
	assert.equal(code, 0);
	const upload = (await calls()).find((call) => call.args.includes('upload'));
	assert.ok(upload.args.includes('--app'), 'no --locale means asc fans out across the tree itself');
	assert.ok(upload.args.includes('--skip-existing'));
	assert.match(out, /IPHONE_65/);
});

test('upload --locale pushes against that localization, and --replace swaps the set', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code } = await shots(['upload'], { dir, flags: { locale: 'en-US', replace: true } });
	assert.equal(code, 0);
	const upload = (await calls()).find((call) => call.args.includes('upload'));
	assert.ok(upload.args.includes('--version-localization'));
	assert.ok(upload.args.includes('--replace'));
});

test('upload refuses when validation fails, unless forced', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 100, 100);
	await assert.rejects(() => shots(['upload'], { dir }), /screenshots failed validation — refusing to upload/);
	const { code } = await shots(['upload'], { dir, flags: { force: true } });
	assert.equal(code, 0);
});

test('upload refuses a scope nothing on disk answers', async () => {
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	await assert.rejects(() => shots(['upload'], { dir, flags: { force: true, locale: 'fr-FR' } }), /no screenshots on disk for locale fr-FR/);
});

test('upload refuses to append past Apple\'s cap', async () => {
	ascOk([['screenshots list', { out: { sets: [{ set: { attributes: { screenshotDisplayType: 'APP_IPHONE_65' } }, screenshots: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, attributes: { imageAsset: { width: 1242, height: 2688 } } })) }] } }]]);
	const dir = await shotsRepo();
	for (let i = 0; i < 3; i++) await png(dir, `store/screenshots/en-US/IPHONE_65/${i}.png`, 1242, 2688);
	await assert.rejects(() => shots(['upload'], { dir, flags: { locale: 'en-US' } }), /refusing to append/);
});

test('an upload asc rejected exits non-zero rather than reading as a success', async () => {
	ascOk([['screenshots upload', { out: '', err: 'asset rejected', code: 1 }]]);
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	await assert.rejects(() => shots(['upload'], { dir }), /1 upload rejected by asc/);
	const { code, out } = await shots(['upload'], { dir, flags: { json: true } });
	assert.equal(code, 1, '--json reports the rejection as an exit code rather than throwing');
	assert.equal(JSON.parse(out.slice(out.indexOf('{'))).ok, false);
});

// ── the render half ─────────────────────────────────────────────────────────
// From here on the stand-in sharp/fontkit/puppeteer do the work. The specs are
// small (a 200×400 canvas) so a test renders in milliseconds; the geometry is
// the real geometry.

const TYPE = { size: 20, lineHeight: 24, colour: '#111111', targetMinSize: 14, minSize: 10, step: 2, margin: 10, gap: 8 };

const DEVICE_SPEC = {
	mode: 'device-frame', displayType: 'IPHONE_65',
	canvas: { w: 200, h: 400 },
	fonts: { default: 'fonts/face.ttf' },
	captions: 'captions.json',
	raw: 'screenshots-raw',
	type: TYPE,
	device: {
		w: 120, h: 240, parts: 'figma-export/parts',
		layers: [{ file: 'back.png', x: 0, y: 0, w: 120, h: 240 }, { file: 'front.png', x: 0, y: 0, w: 120, h: 240 }],
		screenIndex: 1,
		screenGroup: { x: 10, y: 20, w: 100, h: 200 },
		artboard: { x: -10, y: -20, w: 120, h: 240 },
	},
	frames: [{ key: 'one', src: '01.png', caption: { x: 10, y: 10, w: 180 }, phone: { x: 40, y: 140 }, bg: '#ffffff', crop: [[1, 0, 0], [0, 1, 0]] }],
};

const BAND_SPEC = {
	mode: 'caption-band', displayType: 'IPHONE_65',
	canvas: { w: 200, h: 400 },
	fonts: { default: 'fonts/face.ttf' },
	captions: 'captions.json',
	raw: 'screenshots-raw',
	base: { dir: 'base' },
	type: TYPE,
	band: { flatMin: 0.5, pad: 4, clearance: 2, inkTolerance: 26 },
	frames: [{ key: 'one', mockTop: 120, mockH: 260, caption: { x: 10, y: 10, w: 180 } }],
};

const CAPTIONS = { 'en-US': { one: 'Track it' }, 'de-DE': { one: 'Verfolge alles' } };

const SUB_TYPE = { ...TYPE, subtitle: { size: 12, lineHeight: 14, colour: '#888888', minSize: 8, step: 1, gap: 20 } };
const LONG_HEADLINE = 'Every service, repair and fill-up for your car tracked automatically in one place';
const SUBTITLE_SPEC = { ...DEVICE_SPEC, type: SUB_TYPE };
const SUBTITLE_CAPTIONS = { 'en-US': { one: { headline: LONG_HEADLINE, subtitle: 'No manual entry' } } };

/** A repo whose native dependencies are the stand-ins, with a spec and a font. */
async function renderRepo(spec, files = {}, config = {}) {
	const dir = await shotsRepo({ 'store/figma-geometry.json': spec, 'store/fonts/face.ttf': 'not really a font', 'store/captions.json': CAPTIONS, ...files }, config);
	await linkNativeDeps(dir);
	return dir;
}

/** The committed Figma layer exports a device-frame render composites. */
async function deviceParts(dir) {
	await png(dir, 'store/figma-export/parts/back.png', 120, 240, { r: 30, g: 30, b: 30, alpha: 1 });
	await png(dir, 'store/figma-export/parts/front.png', 120, 240, { r: 0, g: 0, b: 0, alpha: 0 });
	await png(dir, 'store/figma-export/parts/screen-shape.png', 100, 200, { r: 255, g: 255, b: 255, alpha: 1 });
}

/** A base composite with a flat band and some ink in it, as the live store image would have. */
async function baseComposite(dir, name = 'one.png') {
	const flat = await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } })
		.composite([{ input: { create: { width: 60, height: 12, channels: 3, background: { r: 10, g: 10, b: 10 } } }, left: 70, top: 40 }])
		.png()
		.toBuffer();
	await sharp(flat).png().toFile(join(dir, 'store', 'base', name));
}

test('render composites a device frame for every locale and writes it where upload looks', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC);
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200, { r: 20, g: 90, b: 160, alpha: 1 });
	await png(dir, 'store/screenshots-raw/de-DE/IPHONE_65/01.png', 100, 200, { r: 20, g: 90, b: 160, alpha: 1 });

	const { code, out } = await shots(['render'], { dir });
	assert.equal(code, 0);
	for (const locale of ['en-US', 'de-DE']) {
		// device-frame keeps the capture's own filename; caption-band numbers them.
		const file = join(dir, 'store', 'screenshots', locale, 'IPHONE_65', '01.png');
		assert.ok(existsSync(file), `${locale} rendered`);
		const meta = await sharp(file).metadata();
		assert.deepEqual({ w: meta.width, h: meta.height }, { w: 200, h: 400 }, 'the render is canvas-sized');
	}
	assert.match(out, /2 images/);
	assert.match(out, /ship shots validate/);
});

test('render --json reports each frame, and one locale can be asked for by name', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC);
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render', 'en-US'], { dir, flags: { json: true } });
	const doc = JSON.parse(out.slice(out.indexOf('{')));
	assert.equal(doc.mode, 'device-frame');
	assert.equal(doc.frames.length, 1);
	assert.equal(doc.frames[0].locale, 'en-US');
});

test('render honours --locale when no positional locale is given', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC);
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/de-DE/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir, flags: { json: true, locale: 'de-DE' } });
	const doc = JSON.parse(out.slice(out.indexOf('{')));
	assert.equal(doc.frames.length, 1);
	assert.equal(doc.frames[0].locale, 'de-DE');
});

test('render refuses when the configured locales have no caption copy at all', async () => {
	// `localesFor` with no requested locales falls back to store.locales
	// filtered by what has captions — a config naming a locale nobody wrote
	// copy for yet leaves nothing to render, which is not the same failure as
	// a typo'd --locale (that names the locale; this can only name none).
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC, {}, { store: { locales: ['fr-FR'] } });
	await assert.rejects(() => shots(['render'], { dir }), /no locales to render/);
});

test('a long headline shrinks below the design size, and a subtitle prints beside it', async () => {
	ascOk();
	const dir = await renderRepo(SUBTITLE_SPEC, { 'store/captions.json': SUBTITLE_CAPTIONS }, { store: { locales: ['en-US'] } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { code, out } = await shots(['render'], { dir });
	assert.equal(code, 0);
	assert.match(out, /\[\d+px\]/, 'a caption too long for the design size reports the size it actually shrank to');
	assert.match(out, /No manual entry/, 'the subtitle text prints alongside the headline it sits under');
	assert.match(out, /caption.*shrunk below 20px/);
});

test('render refuses a locale with no caption copy, and a missing raw capture', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC);
	await deviceParts(dir);
	await assert.rejects(() => shots(['render', 'fr-FR'], { dir }), /no caption copy for fr-FR/);
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /missing raw capture/);
});

test('render refuses a missing Figma layer export rather than compositing without it', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /missing mockup layer/);
});

test('a repo with no spec at all is told what it is missing', async () => {
	ascOk();
	const dir = await shotsRepo();
	await assert.rejects(() => shots(['render'], { dir }), /no screenshot spec at/);
});

test('a spec that is not valid JSON names the file', async () => {
	ascOk();
	const dir = await shotsRepo({ 'store/figma-geometry.json': '{oops' });
	await assert.rejects(() => shots(['render'], { dir }), /is not valid JSON/);
});

test('the caption-band mode repaints the band on the live composite', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await baseComposite(dir);
	const { code, out } = await shots(['render', 'en-US'], { dir });
	assert.equal(code, 0);
	const file = join(dir, 'store', 'screenshots', 'en-US', 'IPHONE_65', '01-one.png');
	const meta = await sharp(file).metadata();
	assert.deepEqual({ w: meta.width, h: meta.height }, { w: 200, h: 400 });
	assert.match(out, /caption-band/);
});

test('caption-band refuses a base composite that is missing or the wrong size', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /missing base composite/);
	await png(dir, 'store/base/one.png', 100, 100);
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /spec canvas is 200x400/);
});

test('capture drives the browser once per frame and writes the raw inputs', async () => {
	ascOk();
	const spec = { ...DEVICE_SPEC, capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 }, timeoutMs: 1000, screens: [{ frame: 'one', path: '/' }] } };
	const dir = await renderRepo(spec);
	const { code, out } = await shots(['capture', 'en-US'], { dir });
	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, 'store', 'screenshots-raw', 'en-US', 'IPHONE_65', '01.png')));
	assert.match(out, /run `ship shots render`/);
});

test('verify reports the calibration and safety evidence for a rendered set', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await baseComposite(dir);
	await shots(['render', 'en-US'], { dir });
	const { code, out } = await shots(['verify', 'en-US'], { dir });
	assert.ok(code === 0 || code === 1);
	assert.ok(out.length);
	const { out: raw } = await shots(['verify', 'en-US'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).mode, 'caption-band');
});

test('caption-band verify skips the ink check on a frame flagged as a deliberate copy change, and reports a narrower caption', async () => {
	ascOk();
	// `captionChanged` on the spec is the paper trail for "the ink is supposed
	// to be a different width now" — a frame without it that renders shorter
	// than the live composite is exactly the un-flagged drift the check exists
	// to catch, so both need their own row.
	const spec = { ...BAND_SPEC, frames: [{ ...BAND_SPEC.frames[0], captionChanged: 'redesigned copy' }] };
	const dir = await renderRepo(spec, { 'store/captions.json': { 'en-US': { one: 'Hi' } } });
	await baseComposite(dir);
	await shots(['render', 'en-US'], { dir });
	const { out } = await shots(['verify', 'en-US'], { dir });
	assert.match(out, /copy changed/);
	assert.doesNotMatch(out, /ink width drifted/, 'a flagged frame is exempt from the drift gate');
});

test('caption-band verify flags a shorter caption on an unflagged frame as ink drift', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC, { 'store/captions.json': { 'en-US': { one: 'Hi' } } });
	await baseComposite(dir);
	await shots(['render', 'en-US'], { dir });
	const { code, out } = await shots(['verify', 'en-US'], { dir });
	assert.equal(code, 1);
	assert.match(out, /ink width drifted/);
});

test('caption-band verify fails a render that changed pixels outside its own band', async () => {
	// The band composite always copies everything below y0..y1 straight from
	// the base image — this can only differ if the file on disk was touched
	// after `render` wrote it, which is exactly the corruption this guards.
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await baseComposite(dir);
	await shots(['render', 'en-US'], { dir });
	const outFile = join(dir, 'store', 'screenshots', 'en-US', 'IPHONE_65', '01-one.png');
	const tampered = await sharp(outFile)
		.composite([{ input: { create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } }, left: 5, top: 200 }])
		.png()
		.toBuffer();
	await sharp(tampered).png().toFile(outFile);
	const { code, out } = await shots(['verify', 'en-US'], { dir });
	assert.equal(code, 1);
	assert.match(out, /pixels changed outside the band/);
});

// ── figma ───────────────────────────────────────────────────────────────────
// The committed layer exports are build inputs. This subcommand exists to say
// whether the design has moved since they were taken — cheaply, from the file
// metadata endpoint — and only re-exports when asked.

const FIGMA_SPEC = { ...DEVICE_SPEC, source: { figmaFile: 'FILEKEY', frameIds: { one: '1:2' } } };

/** @param {{version?: string, images?: object, status?: number}} [opts] */
const figmaApi = ({ version = 'v9', images = { '1:2': 'https://figma.example/img/1.png' }, status = 200 } = {}) =>
	async (url) => {
		const href = String(url);
		if (href.includes('/images/')) return json({ images }, status);
		if (href.includes('/files/')) return json({ version, lastModified: '2026-09-01T00:00:00Z', name: 'Design' }, status);
		return new Response(Buffer.from(await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()));
	};

test('figma reports drift against the pinned version, and --pin records the new one', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	const dir = await renderRepo(FIGMA_SPEC);
	const { code, out } = await shots(['figma'], { dir, fetch: figmaApi() });
	assert.equal(code, 0);
	assert.match(out, /spec records no version/);

	const { out: pinned } = await shots(['figma'], { dir, flags: { pin: true }, fetch: figmaApi() });
	assert.match(pinned, /pinned .* to version v9/);
	assert.equal(JSON.parse(await readFile(join(dir, 'store', 'figma-geometry.json'), 'utf8')).source.version, 'v9');

	const { code: drifted, out: moved } = await shots(['figma'], { dir, fetch: figmaApi({ version: 'v10' }) });
	assert.equal(drifted, 1, 'a moved design is a finding, not a surprise later');
	assert.match(moved, /design has moved since the committed exports/);

	const { code: same } = await shots(['figma'], { dir, fetch: figmaApi({ version: 'v9' }) });
	assert.equal(same, 0);
});

test('figma needs a token and a file key', async () => {
	ascOk();
	const dir = await renderRepo(FIGMA_SPEC);
	const saved = process.env.FIGMA_API_KEY;
	delete process.env.FIGMA_API_KEY;
	delete process.env.FIGMA_TOKEN;
	try {
		await assert.rejects(() => shots(['figma'], { dir, fetch: figmaApi() }), /no Figma token/);
	} finally {
		process.env.FIGMA_API_KEY = saved;
	}
	const noKey = await renderRepo(DEVICE_SPEC);
	await assert.rejects(() => shots(['figma'], { dir: noKey, fetch: figmaApi() }), /source.figmaFile is not set/);
});

test('--export downloads the nodes the spec names, and survives the quota running out', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	const dir = await renderRepo(FIGMA_SPEC);
	await deviceParts(dir);
	const { code, out } = await shots(['figma'], { dir, flags: { export: true, scale: 2 }, fetch: figmaApi() });
	assert.equal(code, 0);
	assert.match(out, /exported 1 node/);
	assert.match(out, /commit these/);

	const quota = async (url) => (String(url).includes('/images/') ? new Response('', { status: 429 }) : figmaApi()(url));
	const { code: survived, out: warned } = await shots(['figma'], { dir, flags: { export: true }, fetch: quota });
	assert.equal(survived, 0, 'the committed exports are exactly the fallback this buys');
	assert.match(warned, /quota exhausted/);
});

test('--export <ids> names the nodes explicitly, overriding source.frameIds, and pluralizes more than one', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	const dir = await renderRepo(FIGMA_SPEC);
	await deviceParts(dir);
	const two = figmaApi({ images: { '1:2': 'https://figma.example/img/1.png', '3:4': 'https://figma.example/img/2.png' } });
	const { code, out } = await shots(['figma'], { dir, flags: { export: '1:2,3:4' }, fetch: two });
	assert.equal(code, 0);
	assert.match(out, /exported 2 nodes/);
});

test('--export rethrows a Figma failure that is not the render quota', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	const dir = await renderRepo(FIGMA_SPEC);
	await deviceParts(dir);
	const broken = async (url) => (String(url).includes('/images/') ? new Response('', { status: 500 }) : figmaApi()(url));
	await assert.rejects(() => shots(['figma'], { dir, flags: { export: true }, fetch: broken }), /Figma 500/);
});

test('--export surviving the quota with no prior export at all still fails: there is nothing committed to fall back to', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	// No deviceParts this time: the parts/ref directory this spec exports into
	// has never been written, so the "committed exports" fallback does not exist.
	const dir = await renderRepo(FIGMA_SPEC);
	const quota = async (url) => (String(url).includes('/images/') ? new Response('', { status: 429 }) : figmaApi()(url));
	const { code, out } = await shots(['figma'], { dir, flags: { export: true }, fetch: quota });
	assert.equal(code, 1, 'a quota hit with nothing committed yet cannot be waved through');
	assert.match(out, /quota exhausted/);
});

test('--export with nothing to export says so', async () => {
	ascOk();
	process.env.FIGMA_API_KEY = 'figma-token';
	const dir = await renderRepo({ ...DEVICE_SPEC, source: { figmaFile: 'FILEKEY' } });
	await assert.rejects(() => shots(['figma'], { dir, flags: { export: true }, fetch: figmaApi() }), /nothing to export/);
});

test('capture in caption-band mode downloads the composites the store is serving', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	const store = async (url) => {
		const href = String(url);
		if (href.includes('/lookup')) return json({ results: [{ screenshotUrls: ['https://is1.example/img/source/400x800bb.png'] }] });
		return new Response(await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer());
	};
	const { code, out } = await shots(['capture'], { dir, fetch: store });
	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, 'store', 'base', 'one.png')));
	assert.match(out, /1 base image/);

	const { out: again } = await shots(['capture'], { dir, fetch: store });
	assert.match(again, /one.png already present/);
});

test('caption-band capture reports zero base images, and a failing exit, when the full-size fetch fails', async () => {
	// The lookup succeeds and names a screenshot, but Apple's own asset host
	// refuses the full-size composite (a transient CDN hiccup, a size the
	// device no longer serves) — nothing was written, so this cannot read as
	// the same success as a real download.
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	const flaky = async (url) => {
		const href = String(url);
		if (href.includes('/lookup')) return json({ results: [{ screenshotUrls: ['https://is1.example/img/source/400x800bb.png'] }] });
		return new Response('', { status: 500 });
	};
	const { code, out } = await shots(['capture'], { dir, fetch: flaky });
	assert.equal(code, 1);
	assert.match(out, /0 base images/);
});

test('device-frame capture reports more than one capture as plural', async () => {
	ascOk();
	const spec = {
		...DEVICE_SPEC,
		capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 }, timeoutMs: 1000, screens: [{ frame: 'one', path: '/' }] },
		frames: [{ key: 'one', src: '01.png', caption: { x: 10, y: 10, w: 180 }, phone: { x: 40, y: 140 }, bg: '#ffffff', crop: [[1, 0, 0], [0, 1, 0]] }],
	};
	const dir = await renderRepo(spec, {}, { store: { locales: ['en-US', 'de-DE'] } });
	const { code, out } = await shots(['capture'], { dir });
	assert.equal(code, 0);
	assert.match(out, /2 captures/);
});

test('caption-band capture refuses an app the store serves nothing for', async () => {
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await assert.rejects(
		() => shots(['capture'], { dir, fetch: async () => json({ results: [{ screenshotUrls: [] }] }) }),
		/the App Store is serving no screenshots for this app/,
	);
	await assert.rejects(
		() => shots(['capture'], { dir, fetch: async () => new Response('', { status: 404 }) }),
		/App Store lookup failed: 404/,
	);
});

test('verify a device-frame render reports its calibration rows', async () => {
	ascOk();
	// `ref` is the design tool's own export of the source-locale frames: the
	// thing the renderer is calibrated against, and without which there is
	// nothing to calibrate.
	const dir = await renderRepo({ ...DEVICE_SPEC, ref: 'figma-export/ref' });
	await deviceParts(dir);
	await png(dir, 'store/figma-export/ref/one.png', 200, 400);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await shots(['render', 'en-US'], { dir });
	const { code, out } = await shots(['verify', 'en-US'], { dir });
	assert.ok(code === 0 || code === 1);
	assert.match(out, /one/);
	const { out: raw } = await shots(['verify', 'en-US'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw.slice(raw.indexOf('{'))).mode, 'device-frame');
});

test('verify reports a frame with no matching reference export as uncalibrated rather than crashing', async () => {
	// `ref` names a directory that exists (so verify does not refuse outright)
	// but has nothing for this frame yet — a reference export still pending
	// from the design tool, not the same failure as no `ref` directory at all.
	ascOk();
	const dir = await renderRepo({ ...DEVICE_SPEC, ref: 'figma-export/ref' });
	await deviceParts(dir);
	await mkdir(join(dir, 'store', 'figma-export', 'ref'), { recursive: true });
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await shots(['render', 'en-US'], { dir });
	const { out } = await shots(['verify', 'en-US'], { dir });
	assert.match(out, /none/, 'the missing-reference row reads "none", not a blank cell');
});

test('upload --render renders first, and says why a re-render is not a skip', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC, {}, { store: { locales: ['en-US'] } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['upload'], { dir, flags: { render: true, force: true } });
	assert.equal(code, 0);
	assert.match(out, /re-rendered images differ byte-wise/);
});

test('upload --render --replace skips the byte-diff warning: the set is cleared, not appended to', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC, {}, { store: { locales: ['en-US'] } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['upload'], { dir, flags: { render: true, force: true, replace: true } });
	assert.equal(code, 0);
	assert.doesNotMatch(out, /re-rendered images differ byte-wise/);
});

test('upload defaults to IOS when the config names no platform', async () => {
	ascOk();
	const dir = await shotsRepo({}, { asc: { appId: '111', primaryLocale: 'en-US', platform: undefined } });
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code } = await shots(['upload'], { dir });
	assert.equal(code, 0);
	const upload = (await calls()).find((call) => call.args.includes('upload'));
	assert.ok(upload.args.includes('IOS'));
});

test('upload refuses a scope where every matched locale has zero display types on disk', async () => {
	// `--locale`/`--display-type` both absent, so `unmatched` has nothing to
	// name — but a locale directory with no display-type subdirectories still
	// yields zero groups, which is just as unsubmittable.
	ascOk();
	const dir = await shotsRepo({ 'store/screenshots/en-US/.keep': '' });
	await assert.rejects(
		() => shots(['upload'], { dir, flags: { force: true } }),
		/no screenshot groups match the requested scope/,
	);
});

// ── scan: the two structural edges around the tree itself ──────────────────

test('plan ignores a stray file sitting directly in a locale directory, outside any display-type folder', async () => {
	ascOk();
	const dir = await shotsRepo({ 'store/screenshots/en-US/read-me.txt': 'not a display type' });
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code, out } = await shots(['plan'], { dir });
	assert.equal(code, 0);
	const doc = JSON.parse(await readFile(join(dir, '.asc', 'screenshots.json'), 'utf8'));
	assert.equal(doc.locales[0].groups.length, 1, 'the stray file names no display type and is skipped, not a phantom group');
	assert.match(out, /1 image/);
});

test('a repo whose store directory sits one level above the repo root itself gets the bare path in the error', async () => {
	// store.dir can be absolute, and nothing stops it from pointing at the repo
	// root's own parent — if the project directory happens to be named
	// "screenshots", `store/screenshots` *is* the repo root, and `relative()`
	// between identical paths is '', not a path to fall back to.
	const parent = await mkdtemp(join(tmpdir(), 'ship-store-'));
	const dir = join(parent, 'screenshots');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'ship.config.json'), JSON.stringify({ ...CONFIG, store: { ...CONFIG.store, dir: parent } }));
	ascOk();
	await assert.rejects(() => shots(['plan'], { dir }), new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has no locale directories`));
});

test('plan counts the display types in a locale, not just the images', async () => {
	// One locale with two device families is the normal shape of a real tree,
	// and the summary line has to pluralise both halves independently.
	ascOk();
	const dir = await shotsRepo();
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	await png(dir, 'store/screenshots/en-US/IPAD_PRO_3GEN_129/01.png', 2048, 2732);
	const { out } = await shots(['plan'], { dir });
	assert.match(out, /2 images across 2 display types/);
});

test('validate names the dimensions it could not read rather than printing undefined', async () => {
	// A truncated or half-written PNG has no header to read. The failure has to
	// say the file is unreadable, not claim it is "undefinedxundefined".
	ascOk();
	const dir = await shotsRepo({ 'store/screenshots/en-US/IPHONE_65/broken.png': 'not a png' });
	const { code, out } = await shots(['validate'], { dir });
	assert.equal(code, 1);
	assert.match(out, /\?x\?/);
	assert.doesNotMatch(out, /undefined/);
});

test('upload asks asc for the platform the repo configured, falling back to iOS', async () => {
	// `asc.platform` is default-backed, but a config may null it out; the upload
	// still has to name a platform because asc requires one.
	ascOk();
	const dir = await shotsRepo({}, { asc: { appId: '111', primaryLocale: 'en-US', platform: null } });
	await png(dir, 'store/screenshots/en-US/IPHONE_65/01.png', 1242, 2688);
	const { code } = await shots(['upload'], { dir });
	assert.equal(code, 0);
	const upload = (await calls()).find((call) => call.args.includes('upload'));
	assert.ok(upload.args.includes('IOS'));
});

test('capture with no url in the spec is refused before a browser is started', async () => {
	// The spec is what says where to point the browser. Without a url there is
	// nothing to capture, and the heading must not read "· undefined".
	ascOk();
	const spec = { ...DEVICE_SPEC, capture: { viewport: { width: 100, height: 200 }, screens: [{ frame: 'one', path: '/' }] } };
	const dir = await renderRepo(spec);
	const { out } = await shots(['capture', 'en-US'], { dir }).catch((err) => ({ out: String(err) }));
	assert.doesNotMatch(out, /· undefined/);
});

test('every locale whose copy had to shrink is named, not just the first', async () => {
	// The shrink warning is the early signal that a translation is too long. If
	// it only ever named one locale, the second would ship at the wrong size.
	ascOk();
	const long = { 'en-US': { one: LONG_HEADLINE }, 'de-DE': { one: LONG_HEADLINE } };
	const dir = await renderRepo(DEVICE_SPEC, { 'store/captions.json': long });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await png(dir, 'store/screenshots-raw/de-DE/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir });
	assert.match(out, /2 captions shrunk below/);
	assert.match(out, /en-US, de-DE|de-DE, en-US/);
});

// ── what the spec loader refuses ────────────────────────────────────────────
//
// A spec is hand-written and lives in the app repo, so every one of these is a
// typo somebody will make. Each has to name the key, because "cannot read
// property of undefined" three files deeper is not an answer.

const specRejects = [
	['a frame with no key', { ...DEVICE_SPEC, frames: [{ src: '01.png' }] }, /every frame needs a key/],
	['a device with no layers', { ...DEVICE_SPEC, device: { ...DEVICE_SPEC.device, layers: [] } }, /device\.layers\[\] is required/],
	['a device with no screenIndex', { ...DEVICE_SPEC, device: { ...DEVICE_SPEC.device, screenIndex: undefined } }, /device\.screenIndex is required/],
	['a device with no screenGroup', { ...DEVICE_SPEC, device: { ...DEVICE_SPEC.device, screenGroup: undefined } }, /device\.screenGroup and device\.artboard are required/],
	['a device frame with no src', { ...DEVICE_SPEC, frames: [{ key: 'one', caption: { x: 10, y: 10, w: 180 } }] }, /frame one needs src/],
	['a subtitle with no size', { ...DEVICE_SPEC, type: { ...TYPE, subtitle: { size: 0, lineHeight: 14 } } }, /type\.subtitle needs a positive size and lineHeight/],
	['a subtitle that cannot shrink', { ...DEVICE_SPEC, type: { ...TYPE, subtitle: { size: 12, lineHeight: 14, minSize: 8, step: 0 } } }, /type\.subtitle\.step must be positive/],
];

for (const [what, spec, expected] of specRejects)
	test(`the spec loader refuses ${what}`, async () => {
		ascOk();
		const dir = await renderRepo(spec);
		await assert.rejects(() => shots(['render', 'en-US'], { dir }), expected);
	});

test('a font named by absolute path is used where it is, not under store/', async () => {
	// A monorepo keeps its brand fonts outside the app; the spec has to be able
	// to point at one without the loader prefixing store/ onto it.
	ascOk();
	const shared = join(await mkdtemp(join(tmpdir(), 'ship-shots-fonts-')), 'face.ttf');
	await writeFile(shared, 'not really a font');
	const dir = await renderRepo({ ...DEVICE_SPEC, fonts: { default: shared } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { code } = await shots(['render', 'en-US'], { dir });
	assert.equal(code, 0);
});

// ── the caption file's shapes ───────────────────────────────────────────────

test('captions may be wrapped in a locales key, and the bookkeeping keys are not locales', async () => {
	// The loc pipeline writes `{source, notes, locales: {...}}`; a hand-written
	// file is just `{...}`. Both are the same file to everything downstream, and
	// "source" must never be rendered as a locale called source.
	ascOk();
	const wrapped = {
		source: 'en-US',
		notes: 'reviewed 2026-08',
		_draft: { one: 'ignore me' },
		locales: { 'en-US': { captions: { one: 'Track it' } }, 'de-DE': { one: 'Verfolge alles' } },
	};
	const dir = await renderRepo(DEVICE_SPEC, { 'store/captions.json': wrapped });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await png(dir, 'store/screenshots-raw/de-DE/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir, flags: { json: true } });
	const locales = new Set(JSON.parse(out.slice(out.indexOf('{'))).frames.map((f) => f.locale));
	assert.deepEqual([...locales].sort(), ['de-DE', 'en-US']);
});

test('an unwrapped caption file keeps its bookkeeping keys out of the locale list', async () => {
	// A hand-written file grows a `notes` key and a `_draft` block beside the
	// real locales. Rendering either as a locale writes a directory called
	// "notes" into the upload tree.
	ascOk();
	const flat = { notes: 'reviewed 2026-08', _draft: { one: 'ignore me' }, 'en-US': { one: 'Track it' } };
	const dir = await renderRepo(DEVICE_SPEC, { 'store/captions.json': flat }, { store: {} });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir, flags: { json: true } });
	const locales = new Set(JSON.parse(out.slice(out.indexOf('{'))).frames.map((f) => f.locale));
	assert.deepEqual([...locales], ['en-US']);
});

test('a caption entry that is not a map of frames is not a locale', async () => {
	// A file half-edited into `{"en-US": "Track it"}` has no frame keys in it.
	// Reading it as a locale would render a caption called "0".
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC, { 'store/captions.json': { 'en-US': 'Track it' } });
	await assert.rejects(() => shots(['render'], { dir }), /defines no locales/);
});

test('with no store.locales configured, every locale with copy is rendered', async () => {
	ascOk();
	const dir = await renderRepo(DEVICE_SPEC, {}, { store: {} });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await png(dir, 'store/screenshots-raw/de-DE/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir });
	assert.match(out, /2 images/, 'the caption file is the locale list when the config names none');
});

// ── compositing: the geometry and the type ──────────────────────────────────

test('render names the font file it cannot find rather than the library error', async () => {
	// The spec points at the exact face the design used; a repo that renamed it
	// must be told which path failed, not handed a fontkit stack trace.
	ascOk();
	const dir = await renderRepo({ ...DEVICE_SPEC, fonts: { default: 'fonts/missing.ttf' } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /font not found: .*missing\.ttf/);
});

test('a subtitle set on its own axis loads the face at that variation', async () => {
	// A variable font inherits the headline's weight unless the subtitle asks
	// for its own — which is the difference between the design and a subtitle
	// that silently renders bold.
	ascOk();
	const spec = { ...DEVICE_SPEC, type: { ...SUB_TYPE, subtitle: { ...SUB_TYPE.subtitle, variation: { wght: 400 } } } };
	const dir = await renderRepo(spec, { 'store/captions.json': SUBTITLE_CAPTIONS }, { store: { locales: ['en-US'] } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { code, out } = await shots(['render'], { dir });
	assert.equal(code, 0);
	assert.match(out, /No manual entry/);
});

test('a subtitle that will not fit even at its floor is dropped out loud', async () => {
	// Silently dropping it is the failure this feature exists to prevent: the
	// locale would ship a headline-only screenshot and nobody would know.
	ascOk();
	const tight = { ...SUB_TYPE, subtitle: { size: 12, lineHeight: 14, colour: '#888888', minSize: 11, step: 1, gap: 20 } };
	const spec = { ...DEVICE_SPEC, type: tight };
	const captions = { 'en-US': { one: { headline: 'Track it', subtitle: `${LONG_HEADLINE} ${LONG_HEADLINE} ${LONG_HEADLINE} ${LONG_HEADLINE}` } } };
	const dir = await renderRepo(spec, { 'store/captions.json': captions }, { store: { locales: ['en-US'] } });
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { out } = await shots(['render'], { dir });
	assert.match(out, /subtitle dropped, will not fit at minSize/);
});

test('a frame set to cover fills the artboard and centre-crops the overflow', async () => {
	// scaleMode FILL in the design tool. A plain resize would letterbox instead,
	// and the device screen would show background where the capture should be.
	ascOk();
	const spec = { ...DEVICE_SPEC, frames: [{ ...DEVICE_SPEC.frames[0], cover: true, crop: undefined }] };
	const dir = await renderRepo(spec);
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 300, 200);
	const { code } = await shots(['render', 'en-US'], { dir });
	assert.equal(code, 0);
	const meta = await sharp(join(dir, 'store', 'screenshots', 'en-US', 'IPHONE_65', '01.png')).metadata();
	assert.deepEqual({ w: meta.width, h: meta.height }, { w: 200, h: 400 });
});

test('a capture that does not reach the edges of its transform has its edge rows replicated', async () => {
	// The design tool clamps when the transform samples outside the source. A
	// crop that leaves a margin must replicate edge pixels, not leave a gap.
	ascOk();
	const spec = { ...DEVICE_SPEC, frames: [{ ...DEVICE_SPEC.frames[0], crop: [[2, 0, 0], [0, 2, 0]] }] };
	const dir = await renderRepo(spec);
	await deviceParts(dir);
	await png(dir, 'store/screenshots-raw/en-US/IPHONE_65/01.png', 100, 200);
	const { code } = await shots(['render', 'en-US'], { dir });
	assert.equal(code, 0);
});

test('render refuses a translation that dropped a frame the source locale has', async () => {
	// A translator returned the file with a frame key missing. The source locale
	// still lays out, so the hole is only found on the locale that has it, and
	// rendering the rest would ship a set one screenshot short.
	ascOk();
	const spec = { ...DEVICE_SPEC, frames: [DEVICE_SPEC.frames[0], { key: 'two', src: '02.png', caption: { x: 10, y: 10, w: 180 }, phone: { x: 40, y: 140 }, bg: '#ffffff', crop: [[1, 0, 0], [0, 1, 0]] }] };
	const captions = { 'en-US': { one: 'Track it', two: 'And again' }, 'de-DE': { one: 'Verfolge alles' } };
	const dir = await renderRepo(spec, { 'store/captions.json': captions });
	await deviceParts(dir);
	for (const locale of ['en-US', 'de-DE'])
		for (const file of ['01.png', '02.png']) await png(dir, `store/screenshots-raw/${locale}/IPHONE_65/${file}`, 100, 200);
	await assert.rejects(() => shots(['render'], { dir }), /de-DE: no caption for frame two/);
});

test('caption-band refuses a band that is no longer flat background', async () => {
	// Repainting a band that has artwork in it destroys the artwork. The check
	// is the difference between a caption swap and a ruined screenshot.
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	// Three colours across the band, so no single one is half of it.
	const busy = await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } })
		.composite([
			{ input: { create: { width: 200, height: 40, channels: 3, background: { r: 10, g: 90, b: 200 } } }, left: 0, top: 0 },
			{ input: { create: { width: 200, height: 40, channels: 3, background: { r: 200, g: 40, b: 10 } } }, left: 0, top: 40 },
		])
		.png()
		.toBuffer();
	await sharp(busy).png().toFile(join(dir, 'store', 'base', 'one.png'));
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /one colour/);
});

test('caption-band refuses a band with no caption ink to align to', async () => {
	// The source ink top is what every other locale is aligned on. An empty
	// band means there is nothing to align to, and guessing would drift the set.
	ascOk();
	const dir = await renderRepo(BAND_SPEC);
	await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } })
		.png()
		.toFile(join(dir, 'store', 'base', 'one.png'));
	await assert.rejects(() => shots(['render', 'en-US'], { dir }), /found no caption ink in the band/);
});

test('a caption-band render with a subtitle keeps both runs on the axis the design put them on', async () => {
	// Two runs are trimmed as one block: trimming them separately would close
	// the gap the design left between headline and subtitle, and centring the
	// subtitle on its own ink would pull it off the headline's axis.
	ascOk();
	const spec = { ...BAND_SPEC, type: SUB_TYPE };
	const captions = { 'en-US': { one: { headline: 'Track it', subtitle: 'No manual entry' } } };
	const dir = await renderRepo(spec, { 'store/captions.json': captions }, { store: { locales: ['en-US'] } });
	await baseComposite(dir);
	const { code, out } = await shots(['render', 'en-US'], { dir });
	assert.equal(code, 0);
	assert.match(out, /No manual entry/, 'the subtitle is set, not dropped');
	// caption-band numbers its outputs; device-frame keeps the capture's name.
	const meta = await sharp(join(dir, 'store', 'screenshots', 'en-US', 'IPHONE_65', '01-one.png')).metadata();
	assert.deepEqual({ w: meta.width, h: meta.height }, { w: 200, h: 400 });
});

// ── capture: what the browser is told to do ─────────────────────────────────

/** A caption-band spec that downloads its base composites from the live store. */
const LIVE_SPEC = { ...BAND_SPEC, base: { dir: 'base', live: true }, frames: [{ ...BAND_SPEC.frames[0], base: 'one.png' }] };

test('capture seeds storage, follows the route placeholders, and waits for what the screen asks', async () => {
	// Every one of these is a screenshot that would otherwise be taken of the
	// wrong thing: an unseeded empty state, last month's invoice, or a screen
	// caught mid-render.
	ascOk();
	const spec = {
		...DEVICE_SPEC,
		capture: {
			url: 'http://localhost:8081',
			viewport: { width: 100, height: 200 },
			localeParam: 'lng',
			settleMs: 0,
			storage: { seed: 'seed.json' },
			screens: [{ frame: 'one', path: '/invoice/{{month}}', waitFor: '#ready', evaluate: 'window.scrollTo(0,0)' }],
		},
	};
	const seed = { default: { currency: 'USD' }, byLocale: { 'de-DE': { currency: 'EUR' } } };
	const dir = await renderRepo(spec, { 'store/seed.json': seed });
	const puppeteer = (await import('./fixtures/native/puppeteer/index.cjs', { with: { type: 'commonjs' } }).catch(() => null))?.default
		?? (await import('node:module')).createRequire(import.meta.url)('./fixtures/native/puppeteer/index.cjs');
	puppeteer.calls.length = 0;

	const { code } = await shots(['capture', 'de-DE'], { dir });
	assert.equal(code, 0);
	const seeded = puppeteer.calls.find((call) => call[0] === 'evaluate' && call[2]);
	assert.deepEqual(seeded[2], { currency: 'EUR' }, 'the locale overlay is what lands in storage');
	const routed = puppeteer.calls.filter((call) => call[0] === 'goto').at(-1)[1];
	assert.match(routed, /\/invoice\/\d{4}-\d{2}\?lng=de-DE/, 'the route resolves its month and carries the locale');
	assert.ok(puppeteer.calls.some((call) => call[0] === 'waitFor' && call[1] === '#ready'));
	assert.ok(puppeteer.calls.some((call) => call[0] === 'evaluate' && call[1] === 'window.scrollTo(0,0)'));
});

test('the seeding that runs in the page writes strings as-is and objects as JSON', async () => {
	// This is the only code here that executes inside the browser: a seed object
	// double-encoded, or an already-JSON string encoded twice, is an app that
	// boots to an empty state and a screenshot of nothing.
	ascOk();
	const spec = {
		...DEVICE_SPEC,
		capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 }, settleMs: 0, storage: { default: { token: 'abc', car: { name: 'Wagon' } } }, screens: [{ frame: 'one' }] },
	};
	const dir = await renderRepo(spec);
	const puppeteer = (await import('./fixtures/native/puppeteer/index.cjs', { with: { type: 'commonjs' } }).catch(() => null))?.default
		?? (await import('node:module')).createRequire(import.meta.url)('./fixtures/native/puppeteer/index.cjs');
	/** @type {Record<string, string>} */
	const store = {};
	globalThis.localStorage = { setItem: (k, v) => { store[k] = v; } };
	puppeteer.inProcess.run = true;
	try {
		await shots(['capture', 'en-US'], { dir });
	} finally {
		puppeteer.inProcess.run = false;
		delete globalThis.localStorage;
	}
	assert.equal(store.token, 'abc', 'a string is stored as it is, not re-encoded');
	assert.deepEqual(JSON.parse(store.car), { name: 'Wagon' });
});

test('capture --live falls back to the US storefront when nothing names a locale', async () => {
	ascOk();
	const dir = await renderRepo(LIVE_SPEC, {}, { asc: { appId: '111', primaryLocale: null, platform: 'IOS' } });
	const pixels = await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
	let looked = '';
	const fetch = async (url) => {
		if (!String(url).includes('itunes.apple.com')) return new Response(pixels, { status: 200 });
		looked = String(url);
		return json({ results: [{ screenshotUrls: ['https://is1.example/app/a/b/392x696bb.png'] }] });
	};
	const { code } = await shots(['capture'], { dir, flags: { live: true }, fetch });
	assert.equal(code, 0);
	assert.match(looked, /country=us/);
});

test('capture defaults a screen with no path to the app root', async () => {
	ascOk();
	const spec = { ...DEVICE_SPEC, capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 }, settleMs: 0, screens: [{ frame: 'one' }] } };
	const dir = await renderRepo(spec);
	const { code } = await shots(['capture', 'en-US'], { dir });
	assert.equal(code, 0);
	assert.ok(existsSync(join(dir, 'store', 'screenshots-raw', 'en-US', 'IPHONE_65', '01.png')));
});

test('capture refuses a spec with no screens, and one naming a frame that does not exist', async () => {
	ascOk();
	const none = await renderRepo({ ...DEVICE_SPEC, capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 } } });
	await assert.rejects(() => shots(['capture', 'en-US'], { dir: none }), /screens\[\] is empty/);

	const wrong = await renderRepo({ ...DEVICE_SPEC, capture: { url: 'http://localhost:8081', viewport: { width: 100, height: 200 }, screens: [{ frame: 'ghost' }] } });
	await assert.rejects(() => shots(['capture', 'en-US'], { dir: wrong }), /references unknown frame ghost/);
});

// ── capture --live: the base composites Apple is already serving ────────────

test('capture --live downloads one base composite per frame at the spec canvas', async () => {
	ascOk();
	const dir = await renderRepo(LIVE_SPEC);
	const pixels = await sharp({ create: { width: 200, height: 400, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
	const fetch = async (url) =>
		String(url).includes('itunes.apple.com')
			? json({ results: [{ screenshotUrls: ['https://is1.example/app/a/b/392x696bb.png', 'https://is1.example/app/a/b/second.png'] }] })
			: new Response(pixels, { status: 200 });
	const { code, out } = await shots(['capture'], { dir, flags: { live: true }, fetch });
	assert.equal(code, 0);
	assert.match(out, /fetched one\.png/);
	assert.ok(existsSync(join(dir, 'store', 'base', 'one.png')));

	// A second run leaves what is already there alone unless --force says so.
	const { out: again } = await shots(['capture'], { dir, flags: { live: true }, fetch });
	assert.match(again, /one\.png already present/);
});

test('capture --live says so when Apple is serving this app no screenshots', async () => {
	ascOk();
	const dir = await renderRepo(LIVE_SPEC);
	const fetch = async () => json({ results: [{}] });
	await assert.rejects(
		() => shots(['capture'], { dir, flags: { live: true }, fetch }),
		/App Store is serving no screenshots/,
	);
});

test('capture --live needs an app id to look up', async () => {
	ascOk();
	const dir = await renderRepo(LIVE_SPEC, {}, { asc: { primaryLocale: 'en-US', platform: 'IOS' } });
	await assert.rejects(() => shots(['capture'], { dir, flags: { live: true } }), /asc\.appId is required/);
});
