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

// ── seed ────────────────────────────────────────────────────────────────────

test('seed folds named competitors\' own localized titles in beside the probed ones', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	const { code, out } = await loc(['seed'], { dir, flags: { ids: '1,2', locale: 'de-DE' } });
	assert.equal(code, 0);
	const cfg = await readJson(dir, 'ship.config.json');
	assert.ok(cfg.aso.seedsByLocale['de-DE'].length);
	assert.match(out, /incumbent titles/);
});

test('seed says so when the storefront returned no titles to mine', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	const { code, out } = await loc(['seed'], { dir, fetch: storefront([]) });
	assert.equal(code, 0);
	assert.match(out, /nothing mined — the storefront returned no titles/);
});

test('seed --json emits one row per locale and prints no table', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	const { out } = await loc(['seed'], { dir, flags: { json: true } });
	const doc = JSON.parse(out);
	assert.equal(doc.source, 'en-US');
	assert.deepEqual(Object.keys(doc.locales), ['de-DE']);
});

// ── draft ───────────────────────────────────────────────────────────────────

test('draft packs the keyword field from the locale\'s own scored terms', async () => {
	const dir = await locRepo({
		'aso/de-DE/scored.json': { terms: [{ keyword: 'kfz scheckheft' }, { keyword: 'werkstatt kilometerstand' }] },
	});
	const { code, out } = await loc(['draft'], { dir });
	assert.equal(code, 0);
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.ok(de.keywords.length, 'the field is packed, not left as a marker');
	assert.ok(!de.keywords.includes('TODO'), 'a locale with its own research does not owe a keyword translation');
	assert.match(out, /packed \d+\/100 from aso\/de-DE\/scored\.json/);
	assert.ok(de.provenance.keywords, 'where each keyword came from is recorded beside it');
});

test('draft keeps a name the glossary already agreed, and passes the brand through untouched', async () => {
	const dir = await locRepo({
		'store/glossary.json': { sourceLocale: 'en-US', neverTranslate: ['Glovebox'], terms: { 'Car maintenance log': { 'de-DE': 'Auto-Serviceheft' } } },
	});
	const { out } = await loc(['draft'], { dir });
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.equal(de.subtitle, 'Auto-Serviceheft');
	assert.equal(de.name, 'Glovebox', 'the brand name is not translated');
	assert.match(out, /glossary: "Car maintenance log"/);
	assert.match(out, /brand name — neverTranslate/);
});

test('a locale a human has finished is refreshed with nothing, and says so', async () => {
	const done = { locale: 'de-DE', name: 'Glovebox', subtitle: 'Auto-Serviceheft', keywords: 'auto,serviceheft', description: 'Pflege dein Auto.', notes: 'translated by a human' };
	const dir = await locRepo({ 'store/staged/de-DE.json': done });
	const { out } = await loc(['draft'], { dir });
	assert.match(out, /refreshed/, 'the file already existed');
	assert.match(out, /\(nothing — all human-written\)/);
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.equal(de.subtitle, 'Auto-Serviceheft', 'nothing a human wrote was overwritten');
	assert.equal(de.notes.note, 'translated by a human', 'a plain-string note is kept as one entry beside the generated ones');
});

test('two locales owing a translator are counted in the plural', async () => {
	const dir = await locRepo({}, { store: { locales: ['en-US', 'de-DE', 'fr-FR'] } });
	const { out } = await loc(['draft'], { dir });
	assert.match(out, /2 locales need a translator: de-DE, fr-FR/);
});

test('--force rewrites a field a human wrote', async () => {
	const dir = await locRepo({ 'store/staged/de-DE.json': { locale: 'de-DE', name: 'Handschuhfach', subtitle: 'Wartungsheft' } });
	await loc(['draft'], { dir, flags: { force: true } });
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.ok(de.subtitle.includes('TODO'), 'with no glossary entry, forcing puts the marker back');
});

// ── lock and status ─────────────────────────────────────────────────────────

test('lock --dry-run on its own still prints what it would have written', async () => {
	const dir = await locRepo();
	const { out } = await loc(['lock'], { dir, flags: { 'dry-run': true } });
	assert.match(out, /--dry-run: nothing written/);
});

test('status is green when every locale is staged, clean and shot', async () => {
	const dir = await repo({
		config: { ...CONFIG, store: { locales: ['en-US'] } },
		files: { 'store/staged/en-US.json': EN, 'store/screenshots/en-US/IPHONE_65/1.png': 'x' },
		prefix: 'ship-loc-',
	});
	const { code, out } = await loc(['status'], { dir, flags: { strict: true } });
	assert.equal(code, 0);
	assert.match(out, /every locale is staged, clean and has screenshots/);
});

test('status marks a locale that only warns differently from one that fails', async () => {
	const dir = await locRepo({ 'store/staged/de-DE.json': { ...EN, locale: 'de-DE' } });
	const { out } = await loc(['status'], { dir, flags: { locale: 'de-DE' } });
	assert.match(out, /fail|warn/);
	const { out: raw } = await loc(['status'], { dir, flags: { json: true, locale: 'de-DE' } });
	const row = JSON.parse(raw).locales[0];
	assert.equal(row.locale, 'de-DE');
	assert.ok(row.review !== 'clean');
});

test('status counts the seeds and harvested terms a locale already has', async () => {
	const dir = await locRepo(
		{ 'aso/de-DE/candidates.json': { locale: 'de-DE', terms: { 'kfz scheckheft': { rank: 1 }, 'werkstatt': { rank: 2 } } } },
		{ aso: { seedsByLocale: { 'de-DE': ['kfz scheckheft'] } } },
	);
	const { out } = await loc(['status'], { dir, flags: { json: true } });
	const de = JSON.parse(out).locales.find((r) => r.locale === 'de-DE');
	assert.equal(de.seeds, 1);
	assert.equal(de.harvested, 2);
});

test('seed pulls in the competitors the source locale already scored', async () => {
	const dir = await locRepo({
		'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log', top3: [{ id: 1 }, { id: 2 }] }] },
	});
	const { code, out } = await loc(['seed'], { dir });
	assert.equal(code, 0);
	// The lookup answers with the German incumbents, so their titles join the
	// probed ones — which is the point: a competitor's own localized name is the
	// best vocabulary there is.
	assert.match(out, /2 incumbent titles|incumbent titles/);
	assert.ok((await readJson(dir, 'ship.config.json')).aso.seedsByLocale['de-DE'].length);
});

test('a config that nulls out its lists is read as empty ones, not as a crash', async () => {
	// deepMerge lets a user replace a default outright, null included. Every list
	// this command reads has to survive that.
	const nulled = { store: { locales: null, dir: 'store' }, aso: { seedsByLocale: null, dir: 'aso' } };
	const dir = await locRepo({ 'store/staged/de-DE.json': { ...EN, locale: 'de-DE' } }, nulled);
	await assert.rejects(() => loc(['seed'], { dir }), /no target locales to seed/);

	const { code } = await loc(['status'], { dir });
	assert.equal(code, 0, 'status lists the locales that are staged');
	const { code: drafted } = await loc(['draft'], { dir });
	assert.equal(drafted, 0, 'draft still has the staged locale to work on');
	const { code: locked } = await loc(['lock'], { dir });
	assert.equal(locked, 0);
});

test('a source listing with empty fields drafts markers rather than empty strings', async () => {
	const dir = await repo({
		config: CONFIG,
		files: { 'store/staged/en-US.json': { locale: 'en-US', name: 'Glovebox' } },
		prefix: 'ship-loc-',
	});
	const { code } = await loc(['draft'], { dir });
	assert.equal(code, 0);
	const de = await readJson(dir, 'store/staged/de-DE.json');
	assert.ok(de.subtitle.includes('TODO'), 'a subtitle the source never wrote is still a translator\'s job');
	assert.ok(de.description.includes('TODO'));
});

test('a name in neverTranslate is passed through even when it is not the app name', async () => {
	const dir = await locRepo({
		'store/staged/en-US.json': { ...EN, name: 'Serviceheft' },
		'store/glossary.json': { sourceLocale: 'en-US', neverTranslate: ['serviceheft'], terms: {} },
	});
	const { out } = await loc(['draft'], { dir });
	assert.equal((await readJson(dir, 'store/staged/de-DE.json')).name, 'Serviceheft');
	assert.match(out, /brand name — neverTranslate/);
});

test('review and status work with no listing staged for the source locale', async () => {
	const dir = await repo({
		config: CONFIG,
		files: { 'store/staged/de-DE.json': { locale: 'de-DE', name: 'Handschuhfach', subtitle: 'Wartungsheft', keywords: 'auto', description: 'Pflege.' } },
		prefix: 'ship-loc-',
	});
	const { code } = await loc(['review'], { dir });
	assert.ok(code === 0 || code === 1);
	const { out } = await loc(['status'], { dir, flags: { json: true } });
	assert.ok(JSON.parse(out).locales.some((r) => r.locale === 'de-DE'));
});

test('a locale whose harvest supports only some of its keywords warns rather than fails', async () => {
	const dir = await locRepo({
		'store/staged/de-DE.json': { locale: 'de-DE', name: 'Handschuhfach', subtitle: 'Wartungsheft', keywords: 'auto,serviceheft', description: 'Pflege dein Auto.' },
		'aso/de-DE/candidates.json': { locale: 'de-DE', terms: { auto: { rank: 1 }, 'kfz werkstatt': { rank: 2 } } },
	}, { legal: { euTrader: 'Demo GmbH' } });
	const { out } = await loc(['status'], { dir, flags: { json: true, locale: 'de-DE' } });
	const row = JSON.parse(out).locales[0];
	assert.equal(row.fails, 0, 'one keyword the harvest does know is not a failure');
	assert.match(row.review, /^\d+ warn$/);
});

test('a staged listing missing a required field is not drafted yet', async () => {
	const dir = await locRepo({ 'store/staged/de-DE.json': { locale: 'de-DE', name: 'Handschuhfach' } });
	const { out } = await loc(['status'], { dir, flags: { json: true, locale: 'de-DE' } });
	const row = JSON.parse(out).locales[0];
	assert.equal(row.staged, true);
	assert.equal(row.drafted, false);
});

test('a glossary with no neverTranslate list still seeds, drafts and locks', async () => {
	const bare = { sourceLocale: 'en-US', terms: {} };
	const dir = await locRepo({ 'store/glossary.json': bare, 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	assert.equal((await loc(['seed'], { dir })).code, 0);
	assert.equal((await loc(['draft'], { dir })).code, 0);
	const { code, out } = await loc(['lock'], { dir });
	assert.equal(code, 0);
	assert.match(out, /neverTranslate: .*Glovebox/, 'the app name is added even when the file listed none');
});

test('draft --locale drafts that locale alone', async () => {
	const dir = await locRepo({}, { store: { locales: ['en-US', 'de-DE', 'fr-FR'] } });
	const { code } = await loc(['draft'], { dir, flags: { locale: 'fr-FR' } });
	assert.equal(code, 0);
	await readJson(dir, 'store/staged/fr-FR.json');
	await assert.rejects(() => readJson(dir, 'store/staged/de-DE.json'), /ENOENT/);
});

test('a storefront that answers nothing at all is no titles, not a crash', async () => {
	const dir = await locRepo({ 'aso/en-US/scored.json': { terms: [{ keyword: 'car maintenance log' }] } });
	const dead = async () => new Response('', { status: 500 });
	const { code, out } = await loc(['seed'], { dir, fetch: dead });
	assert.equal(code, 0);
	assert.match(out, /0 incumbents/);
});
