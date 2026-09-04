// `ship shots` end to end. The App Store Connect half runs against a fake
// `asc`; the render half runs against the stand-in sharp/fontkit/puppeteer in
// test/fixtures/native, which shipkit resolves out of the app repo exactly as
// it would resolve the real ones. Pixels are really encoded, decoded, masked
// and trimmed — the one thing the stand-in cannot do is rasterise glyph
// outlines, so a caption becomes the box its glyph rectangles cover.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
