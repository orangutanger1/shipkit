// `ship loc review` is the gate that catches a listing that was translated but
// not localized. Every assertion below is a failure mode that shipped in the
// wild: an English listing with German words, a draft nobody finished, a German
// compound one code point over the ASC limit, keywords no German ever typed, a
// brand name a translator helpfully translated, and an EU storefront shipping
// without the DSA trader declaration. Losing one of these is not a style
// regression — it is a listing that ranks for nothing or gets pulled.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditListing, isEuLocale } from '../src/commands/loc.mjs';
import { words } from '../src/lib/text.mjs';

// ─── fixtures ────────────────────────────────────────────────────────────────

const EN = {
	locale: 'en-US',
	name: 'Glovebox',
	subtitle: 'Car service and repair log',
	keywords: 'car,service,log,maintenance,vehicle,repair,mileage,garage',
	description: 'Glovebox keeps every car service receipt, repair and mileage entry in one place.',
	whatsNew: 'Faster search across your service history.',
};

/** A hand-written German listing: native nouns, brand kept, inside the limits. */
const DE = {
	locale: 'de-DE',
	name: 'Glovebox',
	subtitle: 'Scheckheft für dein Auto',
	keywords: 'kfz kosten,tankbuch,werkstatt,ölwechsel,inspektion',
	description: 'Glovebox sammelt jede Werkstattrechnung, Inspektion und Tankfüllung an einem Ort.',
	whatsNew: 'Schnellere Suche im Wartungsverlauf.',
};

const FR = {
	locale: 'fr-FR',
	name: 'Glovebox',
	subtitle: "Carnet d'entretien auto",
	keywords: 'entretien auto,carnet,garage,vidange,révision',
	description: 'Glovebox conserve chaque facture de garage, vidange et révision de votre voiture.',
	whatsNew: 'Recherche plus rapide dans le carnet.',
};

const GLOSSARY = { sourceLocale: 'en-US', neverTranslate: ['Glovebox'], terms: {} };

/** The shape `harvestIndex` hands `auditListing`: the harvested terms plus their tokens. */
function harvestOf(terms, locale) {
	const index = new Set();
	for (const term of terms) {
		index.add(String(term).toLocaleLowerCase());
		for (const w of words(term, locale)) index.add(w);
	}
	return { terms: terms.length, index };
}

const DE_HARVEST = harvestOf(
	['kfz kosten', 'tankbuch', 'werkstatt', 'ölwechsel', 'inspektion', 'scheckheft'],
	'de-DE',
);
const FR_HARVEST = harvestOf(
	['entretien auto', 'carnet entretien', 'garage', 'vidange', 'révision', 'facture garage'],
	'fr-FR',
);

/** One German listing through the rules, with everything else healthy. */
const audit = (data, over = {}) =>
	auditListing({
		locale: 'de-DE',
		data,
		source: 'en-US',
		sourceData: EN,
		glossary: GLOSSARY,
		harvest: DE_HARVEST,
		euTrader: 'Glovebox GmbH',
		...over,
	});

const rules = (rows) => rows.filter((r) => r.level === 'fail').map((r) => r.rule);

// ─── the rules ───────────────────────────────────────────────────────────────

test('a hand-written locale with none of the problems passes clean', () => {
	assert.deepEqual(audit(DE), []);
});

test('the source locale is never audited against itself', () => {
	assert.deepEqual(audit({ ...EN }, { locale: 'en-US', harvest: null }), []);
});

test('a byte-identical clone of the source listing fails as untranslated', () => {
	const rows = audit({ ...EN, locale: 'de-DE' });
	assert.ok(rules(rows).includes('untranslated'), `expected untranslated, got ${rules(rows).join(', ')}`);
	const row = rows.find((r) => r.rule === 'untranslated');
	assert.match(row.detail, /subtitle/);
	assert.match(row.detail, /keywords/);
});

test('a name identical to the source is fine when the name is the brand', () => {
	// Only the brand is exempt: the same listing with an unlisted name still fails.
	assert.deepEqual(rules(audit({ ...DE, name: EN.name })), []);
	const bare = audit({ ...DE, name: EN.name }, { glossary: { neverTranslate: [], terms: {} } });
	assert.ok(rules(bare).includes('untranslated'));
});

test('a TODO( marker anywhere in the copy fails the listing', () => {
	for (const field of ['name', 'subtitle', 'keywords', 'description', 'promotionalText', 'whatsNew']) {
		const rows = audit({ ...DE, [field]: `TODO(de-DE) ${DE[field] ?? 'übersetzen'}` });
		const row = rows.find((r) => r.rule === 'todo');
		assert.ok(row, `no todo failure for ${field}`);
		assert.match(row.detail, new RegExp(field));
	}
});

test('subtitle length is measured in code points, not UTF-16 units', () => {
	// German compounds land on the limit constantly, and an emoji is one
	// character to App Store Connect and two to String.length. A UTF-16 counter
	// fails the 30 and passes the 31 — exactly backwards.
	const ok = 'Fahrzeug-Scheckheft & Kosten 🚗';
	const over = 'Fahrzeug-Scheckhefte & Kosten 🚗';
	assert.equal(Array.from(ok).length, 30);
	assert.equal(ok.length, 31);
	assert.equal(Array.from(over).length, 31);

	assert.deepEqual(rules(audit({ ...DE, subtitle: ok })), []);
	const rows = audit({ ...DE, subtitle: over });
	assert.deepEqual(rules(rows), ['length']);
	assert.match(rows[0].detail, /subtitle is 31\/30 code points/);
});

test('an astral character counts once against the name limit', () => {
	const name = `${'𝔊'.repeat(29)}x`; // 30 code points, 59 UTF-16 units
	assert.equal(name.length, 59);
	assert.ok(!rules(audit({ ...DE, name })).includes('length'));
	assert.ok(rules(audit({ ...DE, name: `${name}x` })).includes('length'));
});

test('keywords translated from the source but absent from the local harvest fail', () => {
	// Word-for-word translation: half the tokens are still the English ones and
	// not one of them came back from the de-DE storefront.
	const rows = audit({ ...DE, keywords: 'auto,service,log,wartung,fahrzeug,reparatur,mileage,garage' });
	const row = rows.find((r) => r.rule === 'translated-not-harvested');
	assert.ok(row, `expected translated-not-harvested, got ${rules(rows).join(', ')}`);
	assert.match(row.detail, /50% of these tokens are the en-US ones/);
});

test('keywords unrelated to both the source and the harvest fail as unharvested', () => {
	const rows = audit({ ...DE, keywords: 'quietschen,ziegel,bäckerei' });
	assert.deepEqual(rules(rows), ['unharvested']);
});

test('a partly unharvested keyword set warns rather than fails', () => {
	const rows = audit({ ...DE, keywords: 'werkstatt,tankbuch,quietschen' });
	assert.deepEqual(rules(rows), []);
	assert.deepEqual(rows.map((r) => r.level), ['warn']);
	assert.match(rows[0].detail, /1\/3 absent/);
});

test('keywords with no harvest at all warn — missing research is not a bad listing', () => {
	const rows = audit(DE, { harvest: null });
	assert.deepEqual(rules(rows), []);
	assert.match(rows[0].detail, /no aso\/de-DE\/candidates\.json/);
});

test('a translated neverTranslate term fails', () => {
	const rows = audit({
		...DE,
		name: 'Handschuhfach',
		description: 'Handschuhfach sammelt jede Werkstattrechnung an einem Ort.',
	});
	const row = rows.find((r) => r.rule === 'glossary');
	assert.ok(row, `expected glossary, got ${rules(rows).join(', ')}`);
	assert.match(row.detail, /"Glovebox" is neverTranslate/);
});

test('a glossary term left in the source language warns with the agreed translation', () => {
	const glossary = { neverTranslate: ['Glovebox'], terms: { mileage: { 'de-DE': 'Kilometerstand' } } };
	const rows = audit({ ...DE, description: 'Glovebox sammelt jeden mileage Eintrag.' }, { glossary });
	assert.deepEqual(rules(rows), []);
	assert.match(rows[0].detail, /the glossary agreed on "Kilometerstand"/);
});

test('an EU storefront with no trader declaration fails', () => {
	const rows = audit(DE, { euTrader: null });
	assert.deepEqual(rules(rows), ['trader']);
	assert.match(rows[0].detail, /legal\.euTrader is null/);
});

test('isEuLocale follows the region, not the language', () => {
	assert.equal(isEuLocale('de-DE'), true);
	assert.equal(isEuLocale('pt-PT'), true);
	assert.equal(isEuLocale('pt-BR'), false);
	assert.equal(isEuLocale('en-US'), false);
	assert.equal(isEuLocale('en-GB'), false);
});

test('a listing saying GDPR in a language with its own acronym fails', () => {
	const rows = audit({ ...DE, description: 'Glovebox ist GDPR-konform und speichert alles lokal.' });
	const row = rows.find((r) => r.rule === 'legal');
	assert.ok(row, `expected legal, got ${rules(rows).join(', ')}`);
	assert.match(row.detail, /must say DSGVO/);
	assert.deepEqual(
		rules(audit({ ...DE, description: 'Glovebox ist DSGVO-konform und speichert alles lokal.' })),
		[],
	);
});

// ─── review, end to end ──────────────────────────────────────────────────────

const SHIP = fileURLToPath(new URL('../bin/ship', import.meta.url));
const exec = promisify(execFile);

async function ship(cwd, ...args) {
	try {
		const { stdout } = await exec(process.execPath, [SHIP, ...args], { cwd, encoding: 'utf8' });
		return { code: 0, stdout };
	} catch (err) {
		return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

const json = (file, data) => writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);

/** A whole app repo in a tmpdir. Nothing is ever written inside the shipkit checkout. */
async function repo(t, { euTrader = 'Glovebox GmbH', listings = [EN, DE, FR], glossary = GLOSSARY } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'ship-loc-'));
	t.after(() => rm(dir, { recursive: true, force: true }));

	await mkdir(join(dir, 'store', 'staged'), { recursive: true });
	await json(join(dir, 'ship.config.json'), {
		name: 'Glovebox',
		bundleId: 'com.example.glovebox',
		asc: { primaryLocale: 'en-US' },
		store: { dir: 'store', locales: listings.map((l) => l.locale) },
		aso: { dir: 'aso' },
		loc: { sourceLocale: 'en-US', glossary: 'store/glossary.json' },
		legal: { euTrader },
	});
	if (glossary) await json(join(dir, 'store', 'glossary.json'), glossary);
	for (const listing of listings) await json(join(dir, 'store', 'staged', `${listing.locale}.json`), listing);

	for (const [locale, terms] of [['de-DE', DE_HARVEST], ['fr-FR', FR_HARVEST]]) {
		await mkdir(join(dir, 'aso', locale), { recursive: true });
		await json(join(dir, 'aso', locale, 'candidates.json'), {
			generatedAt: '2025-06-01T00:00:00.000Z',
			locale,
			market: locale.slice(-2),
			seeds: [],
			terms: Object.fromEntries(
				[...terms.index].filter((t) => t.includes(' ') || t.length > 4).map((t) => [t, { seeds: [], rank: 1 }]),
			),
		});
	}
	return dir;
}

const byName = (out) => Object.fromEntries(JSON.parse(out).rows.map((r) => [r.name, r]));

test('review fails the repo when one locale is an untranslated clone', async (t) => {
	const dir = await repo(t, { listings: [EN, { ...EN, locale: 'de-DE' }, FR] });
	const { code, stdout } = await ship(dir, 'loc', 'review', '--json');
	assert.equal(code, 1);
	const rows = byName(stdout);
	assert.equal(rows['de-DE untranslated'].level, 'fail');
	assert.equal(rows['en-US'].level, 'ok');
	assert.equal(rows['fr-FR'].level, 'ok');
});

test('review passes a repo whose locales are all hand-written', async (t) => {
	const dir = await repo(t);
	const { code, stdout } = await ship(dir, 'loc', 'review', '--json');
	assert.equal(code, 0, stdout);
	const rows = byName(stdout);
	assert.deepEqual(Object.keys(rows).sort(), ['de-DE', 'en-US', 'fr-FR']);
	for (const row of Object.values(rows)) assert.equal(row.level, 'ok');
});

test('review fails every EU locale when legal.euTrader is null', async (t) => {
	const dir = await repo(t, { euTrader: null });
	const { code, stdout } = await ship(dir, 'loc', 'review', '--json');
	assert.equal(code, 1);
	const rows = byName(stdout);
	assert.equal(rows['de-DE trader'].level, 'fail');
	assert.equal(rows['fr-FR trader'].level, 'fail');
	assert.equal(rows['en-US'].level, 'ok'); // not an EU storefront
});

test('review scoped to one locale reports only that locale', async (t) => {
	const dir = await repo(t, { listings: [EN, { ...EN, locale: 'de-DE' }, FR] });
	const { code, stdout } = await ship(dir, 'loc', 'review', '--json', '--locale', 'fr-FR');
	assert.equal(code, 0, stdout);
	assert.deepEqual(Object.keys(byName(stdout)), ['fr-FR']);
});

test('loc lock is idempotent — the second run writes the same bytes', async (t) => {
	const dir = await repo(t, { glossary: null });
	const file = join(dir, 'store', 'glossary.json');

	const first = await ship(dir, 'loc', 'lock', '--json');
	assert.equal(first.code, 0, first.stderr);
	assert.equal(JSON.parse(first.stdout).changed, true);
	const after1 = await readFile(file, 'utf8');

	const second = await ship(dir, 'loc', 'lock', '--json');
	assert.equal(second.code, 0, second.stderr);
	assert.equal(JSON.parse(second.stdout).changed, false);
	const after2 = await readFile(file, 'utf8');

	assert.equal(after2, after1);
	const glossary = JSON.parse(after2);
	assert.ok(glossary.neverTranslate.includes('Glovebox'));
	// Every target locale gets a visible empty slot rather than a missing key.
	for (const row of Object.values(glossary.terms)) assert.deepEqual(Object.keys(row).sort(), ['de-DE', 'fr-FR']);
});

test('loc lock keys stay sorted so the file diffs line by line', async (t) => {
	const dir = await repo(t, { glossary: null });
	const { code } = await ship(dir, 'loc', 'lock');
	assert.equal(code, 0);
	const glossary = JSON.parse(await readFile(join(dir, 'store', 'glossary.json'), 'utf8'));
	assert.deepEqual(glossary.neverTranslate, [...glossary.neverTranslate].sort());
	assert.deepEqual(Object.keys(glossary.terms), [...Object.keys(glossary.terms)].sort());
});
