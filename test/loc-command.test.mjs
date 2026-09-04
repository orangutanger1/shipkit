// `ship loc` end to end: status, seed, draft, review and lock. The one network
// dependency is the storefront each target locale is probed against, stubbed on
// globalThis.fetch — the point of the command is that native vocabulary comes
// from incumbents' own localized titles, so those titles are what the stub
// serves.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { capture, inDir, json, repo, withFetch } from './fixtures/cmd.mjs';

const { run } = await import('../src/commands/loc.mjs');
const { setDryRun } = await import('../src/exec.mjs');

/** German incumbents, as the DE storefront names them. */
const DE_TITLES = [
	{ trackName: 'Autopflege Serviceheft', trackId: 1, sellerName: 'A', userRatingCount: 100, averageUserRating: 4.5, price: 0, releaseDate: '2020-01-01T00:00:00Z' },
	{ trackName: 'Werkstatt Kilometerstand Tracker', trackId: 2, sellerName: 'B', userRatingCount: 50, averageUserRating: 4.2, price: 0, releaseDate: '2021-01-01T00:00:00Z' },
];

const storefront = (apps = DE_TITLES) => async (url) => {
	const href = String(url);
	if (href.includes('MZSearchHints')) return new Response('<dict></dict>');
	if (href.includes('/search') || href.includes('/lookup')) return json({ results: apps });
	return new Response('<html></html>');
};

const CONFIG = {
	name: 'Glovebox', bundleId: 'com.demo.app',
	asc: { appId: 111, primaryLocale: 'en-US' },
	store: { locales: ['en-US', 'de-DE'] },
	legal: { euTrader: null },
};
const EN = { locale: 'en-US', name: 'Glovebox', subtitle: 'Car maintenance log', keywords: 'car,service,log', description: 'Track your car maintenance.', promotionalText: 'New', whatsNew: 'First release' };

/** @param {string[]} args @param {{flags?: object, dir: string, fetch?: typeof globalThis.fetch}} opts */
async function loc(args, { flags = {}, dir, fetch = storefront() }) {
	const { result, out } = await capture(() => inDir(dir, () => withFetch(fetch, () => run({ args, flags }))));
	return { code: result, out };
}

const locRepo = (files = {}, config = {}) => repo({ config: { ...CONFIG, ...config }, files: { 'store/staged/en-US.json': EN, ...files }, prefix: 'ship-loc-' });
const readJson = (dir, rel) => readFile(join(dir, rel), 'utf8').then(JSON.parse);

test('an unknown subcommand names the ones that exist', async () => {
	const dir = await locRepo();
	await assert.rejects(() => loc(['sniff'], { dir }), /unknown subcommand|try:/);
});

test('status reports every locale, and --strict fails while one is not ready', async () => {
	const dir = await locRepo();
	const { code, out } = await loc(['status'], { dir });
	assert.equal(code, 0);
	assert.match(out, /Localization status/);
	assert.match(out, /de-DE/);
	assert.match(out, /not ready/);

	const { code: strict } = await loc(['status'], { dir, flags: { strict: true } });
	assert.equal(strict, 1);
	const { out: raw } = await loc(['status'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).source, 'en-US');
});

test('status counts the screenshots a locale has', async () => {
	const dir = await locRepo({ 'store/screenshots/en-US/IPHONE_65/1.png': 'x', 'store/screenshots/en-US/IPHONE_65/notes.txt': 'ignored' });
	const { out } = await loc(['status'], { dir, flags: { json: true } });
	const rows = JSON.parse(out).locales;
	assert.equal(rows.find((r) => r.locale === 'en-US').shots, 1);
});

test('seed mines native vocabulary from the target storefront into the config', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log', opportunity: 40 }, { keyword: 'service history', opportunity: 30 }] } });
	const { code, out } = await loc(['seed'], { dir });
	assert.equal(code, 0);
	const cfg = await readJson(dir, 'ship.config.json');
	assert.ok(cfg.aso.seedsByLocale['de-DE'].length, 'the German seeds are written back');
	assert.ok(!cfg.aso.seedsByLocale['en-US'], 'the source locale is not seeded from itself');
	assert.match(out, /native seeds/);
});

test('seed --dry-run leaves the config alone', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	setDryRun(true);
	try {
		const { out } = await loc(['seed'], { dir });
		assert.match(out, /not written/);
		assert.equal((await readJson(dir, 'ship.config.json')).aso?.seedsByLocale, undefined);
	} finally {
		setDryRun(false);
	}
});

test('seed refuses without target locales or probe terms', async () => {
	const alone = await locRepo({}, { store: { locales: ['en-US'] } });
	await assert.rejects(() => loc(['seed'], { dir: alone }), /no target locales to seed/);
	const bare = await repo({ config: CONFIG, prefix: 'ship-loc-' });
	await assert.rejects(() => loc(['seed'], { dir: bare }), /nothing to probe the storefronts with/);
});

test('seed skips a locale with no App Store market rather than failing the run', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } }, { store: { locales: ['en-US', 'xx-XX'] } });
	const { code, out } = await loc(['seed'], { dir });
	assert.equal(code, 0);
	assert.match(out, /no App Store market known for xx-XX — skipped/);
});

test('draft derives every locale from the source and marks what a human still owes', async () => {
	const dir = await locRepo();
	const { code, out } = await loc(['draft'], { dir });
	assert.equal(code, 0);
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.equal(de.locale, 'de-DE');
	assert.match(out, /Draft from en-US/);
	assert.match(out, /ship loc review/);
	const { out: raw } = await loc(['draft'], { dir, flags: { json: true } });
	assert.equal(JSON.parse(raw).locales[0].locale, 'de-DE');
});

test('draft refuses without a source listing or target locales', async () => {
	const noSource = await repo({ config: CONFIG, prefix: 'ship-loc-' });
	await assert.rejects(() => loc(['draft'], { dir: noSource }), /no staged listing for the source locale/);
	const alone = await locRepo({}, { store: { locales: ['en-US'] } });
	await assert.rejects(() => loc(['draft'], { dir: alone }), /no target locales to draft/);
});

test('draft --dry-run writes nothing', async () => {
	const dir = await locRepo();
	const { out } = await loc(['draft'], { dir, flags: { 'dry-run': true } });
	assert.match(out, /nothing written/);
	await assert.rejects(() => readJson(dir, 'store/staged/de-DE.json'), /ENOENT/);
});

test('review passes the source listing and finds what is still English in a hat', async () => {
	const dir = await locRepo({ 'store/staged/de-DE.json': { ...EN, locale: 'de-DE' } });
	const { code, out } = await loc(['review'], { dir });
	assert.equal(code, 1, 'a listing identical to the source is not a translation');
	assert.match(out, /de-DE/);
	const { out: raw } = await loc(['review'], { dir, flags: { json: true, locale: 'en-US' } });
	assert.equal(JSON.parse(raw).rows.some((r) => r.name === 'en-US'), true);
});

test('review says when no staged listing matched the filter, and when there are none at all', async () => {
	const dir = await locRepo();
	const { out } = await loc(['review'], { dir, flags: { locale: 'fr-FR' } });
	assert.match(out, /no staged listing matched/);
	const bare = await repo({ config: CONFIG, prefix: 'ship-loc-' });
	await assert.rejects(() => loc(['review'], { dir: bare }), /no staged listings in/);
});

test('lock seeds the glossary from the source listing and leaves a slot per locale', async () => {
	const dir = await locRepo();
	const { code, out } = await loc(['lock'], { dir });
	assert.equal(code, 0);
	const glossary = await readJson(dir, 'store/glossary.json');
	assert.equal(glossary.sourceLocale, 'en-US');
	assert.ok(glossary.neverTranslate.includes('Glovebox'), 'the app name is never translated');
	for (const row of Object.values(glossary.terms)) assert.ok('de-DE' in row, 'every target locale gets a visible blank');
	assert.match(out, /source terms/);

	const { out: again } = await loc(['lock'], { dir });
	assert.match(again, /already current/);
});

test('lock --dry-run and --json report without writing', async () => {
	const dir = await locRepo();
	const { out } = await loc(['lock'], { dir, flags: { 'dry-run': true, json: true } });
	assert.equal(JSON.parse(out).dryRun, true);
	await assert.rejects(() => readJson(dir, 'store/glossary.json'), /ENOENT/);
});
