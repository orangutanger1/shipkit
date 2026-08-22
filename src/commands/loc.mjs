// Localization — the stage that turns one authored listing into listings the
// other markets actually search for.
//
// What used to happen: `store/staged/de-DE.json` was written by translating the
// English one, and `ship aso harvest --locale de-DE` swept autocomplete with
// English seeds because that is all `aso.seeds` held. Both halves are the same
// mistake — the German listing ends up carrying English phrasing with German
// words, and Apple indexes the words Germans type.
//
// The trick that gets native vocabulary without a translation API: every
// incumbent in a storefront already paid a native copywriter. Their localized
// titles, fetched from that storefront, ARE the vocabulary. `seed` mines them
// into `aso.seedsByLocale`, `ship aso harvest` sweeps with those, `draft` packs
// what came back, and `review` refuses anything that is still English in a hat.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIMITS, loadConfig, saveConfig } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, table, warn } from '../log.mjs';
import { lookup, marketFor, packKeywords, topResults } from '../lib/appstore.mjs';
import { keywordList, readStaged } from '../lib/locales.mjs';
import {
	charCount,
	indexedWords,
	isCovered,
	isNoSpaceLang,
	keywordFieldLength,
	langOf,
	overlap,
	stopwordsFor,
	words,
} from '../lib/text.mjs';

export const help = `
${c.bold('ship loc')} ${c.dim('— authentic localization, not translated English')}

${c.dim('usage:')} ship loc [subcommand] [flags]

  ${c.cyan('status')}   ${c.dim('default')} per-locale readiness: staged · drafted · reviewed · harvested · shots
  ${c.cyan('seed')}     mine native seed terms from each storefront's own top results into aso.seedsByLocale
  ${c.cyan('draft')}    skeleton store/staged/<locale>.json from the source listing, glossary and local research
  ${c.cyan('review')}   offline audit that catches fake localization ${c.dim('(exit 1 on any failure)')}
  ${c.cyan('lock')}     create/update store/glossary.json — brand nouns and their agreed translations

${c.bold('Flags')}
  ${c.cyan('--locale <l>')}    one locale instead of store.locales
  ${c.cyan('--seeds "a,b"')}   ${c.dim('seed')} native terms to record verbatim alongside the mined ones
  ${c.cyan('--terms <n>')}     ${c.dim('seed')} source terms to probe each storefront with ${c.dim('(default 5)')}
  ${c.cyan('--top <n>')}       ${c.dim('seed')} native terms to keep per locale ${c.dim('(default 8)')}
  ${c.cyan('--force')}         ${c.dim('draft')} overwrite fields a human already filled in
  ${c.cyan('--strict')}        ${c.dim('status')} exit 1 unless every locale is green
  ${c.cyan('--json')}          machine-readable output
  ${c.cyan('--dry-run')}       print every mutation, write nothing

${c.dim('Order: lock → seed → ship aso harvest/score → draft → review → ship meta apply')}
${c.dim('Artifacts: aso.seedsByLocale in ship.config.json · store/glossary.json · store/staged/<locale>.json')}
`;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

/** A bare `--flag` parses as `true`; only a real string is a usable value. */
const str = (v) => (typeof v === 'string' && v.length ? v : undefined);
const csv = (v) => (str(v) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const dryRun = (flags) => isDryRun() || flags['dry-run'] === true || flags.n === true;

/** The locale everything is authored in. `loc.sourceLocale` overrides the ASC primary. */
const sourceOf = (cfg) => cfg.loc.sourceLocale ?? cfg.asc.primaryLocale;

/** Fields a listing must fill before it is submittable, and everything a marker can hide in. */
const REQUIRED = ['name', 'subtitle', 'keywords', 'description'];
const COPY_FIELDS = ['name', 'subtitle', 'keywords', 'description', 'promotionalText', 'whatsNew'];

/** Key order for a staged file, so a regenerated draft diffs against the last one. */
const FIELD_ORDER = [
	'locale',
	'name',
	'subtitle',
	'keywords',
	'promotionalText',
	'description',
	'whatsNew',
	'privacyPolicyUrl',
	'supportUrl',
	'marketingUrl',
	'provenance',
	'notes',
];

const todoMarker = (locale) => `TODO(${locale})`;
const hasTodo = (v) => String(v ?? '').includes('TODO(');

const stagedFile = (cfg, locale) => join(cfg.paths.staged, `${locale}.json`);
const asoFile = (cfg, locale, kind) => join(cfg.paths.aso, locale, `${kind}.json`);
const analyticsFile = (cfg, locale) => join(cfg.paths.analytics, `${locale}-terms.json`);
const shotsDir = (cfg, locale) => join(cfg.paths.store, 'screenshots', locale);

async function readJSON(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

async function writeJSON(file, data) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

function order(data) {
	const out = {};
	for (const k of FIELD_ORDER) if (data[k] !== undefined) out[k] = data[k];
	for (const k of Object.keys(data)) if (!(k in out)) out[k] = data[k];
	return out;
}

/**
 * `scored.json` is `{terms:[…]}`; files written before the rename say `{scored:[…]}`
 * and entries may be bare strings. Research is expensive — read every shape.
 */
async function scoredTerms(cfg, locale) {
	const data = await readJSON(asoFile(cfg, locale, 'scored'));
	const rows = data?.terms ?? data?.scored ?? [];
	return rows
		.map((r) =>
			typeof r === 'string'
				? { term: r, opportunity: 0 }
				: { term: r.term ?? r.keyword, opportunity: r.opportunity ?? 0 },
		)
		.filter((r) => r.term);
}

/** Term strings plus their tokens, so a packed single word still matches the phrase it came from. */
function tokenIndex(names, locale) {
	const index = new Set();
	for (const name of names) {
		index.add(String(name).toLocaleLowerCase());
		for (const w of words(name, locale)) index.add(w);
	}
	return { terms: names.length, index };
}

/** What `ship aso harvest` actually saw in this locale's own storefront, or null if it never ran. */
async function harvestIndex(cfg, locale) {
	const data = await readJSON(asoFile(cfg, locale, 'candidates'));
	// `terms` is `{term: {seeds, rank}}` now and `{term: [seeds]}` in older artifacts;
	// only the keys matter here, so both read the same.
	return data ? tokenIndex(Object.keys(data.terms ?? {}), locale) : null;
}

/** Search terms App Store Connect says real users arrived on. Never required. */
async function analyticsIndex(cfg, locale) {
	const data = await readJSON(analyticsFile(cfg, locale));
	if (!data) return null;
	return tokenIndex((data.rows ?? []).map((r) => r.term).filter(Boolean), locale);
}

const supported = (term, index, locale) =>
	index.has(String(term).toLocaleLowerCase()) || words(term, locale).some((w) => index.has(w));

const emptyGlossary = (source) => ({ sourceLocale: source, neverTranslate: [], terms: {} });

async function readGlossary(cfg) {
	return (await readJSON(cfg.paths.glossary)) ?? emptyGlossary(sourceOf(cfg));
}

/**
 * Sorted keys everywhere. This file is read in a pull-request diff, and a map
 * that reorders itself on every write hides the one line that changed.
 */
function stableGlossary(g) {
	const terms = {};
	for (const key of Object.keys(g.terms ?? {}).sort()) {
		const row = g.terms[key] ?? {};
		const sorted = {};
		for (const loc of Object.keys(row).sort()) sorted[loc] = row[loc];
		terms[key] = sorted;
	}
	return {
		sourceLocale: g.sourceLocale,
		neverTranslate: [...new Set(g.neverTranslate ?? [])].sort(),
		terms,
	};
}

/** EU/EEA storefronts. The DSA trader declaration is enforced in all of them. */
const EU_REGIONS = new Set(
	'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '),
);
const EU_LANGS = new Set('de fr es it nl pt da fi sv el pl cs sk hu ro bg hr sl et lv lt ga mt is no'.split(' '));

/** `pt-PT` ships in the EU and `pt-BR` does not, so the region wins whenever there is one. */
export function isEuLocale(locale) {
	const [lang, region] = String(locale ?? '').split(/[-_]/);
	if (region) return EU_REGIONS.has(region.toUpperCase());
	return EU_LANGS.has(String(lang).toLowerCase());
}

/**
 * Privacy law acronyms that differ from the English one. A German listing saying
 * "GDPR" reads as machine-translated boilerplate to a German reviewer and to a
 * German buyer; the local acronym is the one they searched for.
 */
const REGULATORY = { de: 'DSGVO', fr: 'RGPD', es: 'RGPD', pt: 'RGPD', nl: 'AVG', pl: 'RODO' };

const corpusOf = (data) =>
	COPY_FIELDS.map((f) => String(data[f] ?? ''))
		.join('\n')
		.toLocaleLowerCase();

/**
 * The rules that separate a localized listing from a translated one.
 * Pure, offline and shared: `review` prints these rows, `status` counts them.
 * @returns {{level:'fail'|'warn', name:string, detail:string, locale:string, rule:string}[]}
 */
export function auditListing({ locale, data, source, sourceData = {}, glossary = {}, harvest = null, euTrader = null }) {
	const rows = [];
	const add = (level, rule, detail) => rows.push({ level, name: `${locale} ${rule}`, detail, locale, rule });
	const isSource = locale === source;
	const neverTranslate = glossary.neverTranslate ?? [];

	// (a) a draft nobody finished. `ship loc draft` marks what it could not translate.
	const todo = COPY_FIELDS.filter((f) => hasTodo(data[f]));
	if (todo.length) add('fail', 'todo', `unfinished: ${todo.join(', ')} still carry a TODO( marker`);

	// (b) the English listing wearing a German hat.
	if (!isSource) {
		const brand = new Set(neverTranslate.map((t) => t.toLocaleLowerCase()));
		const same = ['name', 'subtitle', 'keywords'].filter(
			(f) => String(data[f] ?? '').trim() && String(data[f]) === String(sourceData[f] ?? ''),
		);
		// A name identical to the source is correct when the name is the brand.
		const flagged = same.filter((f) => !(f === 'name' && brand.has(String(data[f]).toLocaleLowerCase())));
		if (flagged.length) add('fail', 'untranslated', `byte-identical to ${source}: ${flagged.join(', ')}`);
	}

	// (c) keywords with no evidence in this locale's own harvest.
	const kws = keywordList(data.keywords).filter((k) => !hasTodo(k));
	if (!isSource && kws.length) {
		if (!harvest) {
			add('warn', 'harvest', `no aso/${locale}/candidates.json — these keywords have no local evidence`);
		} else {
			const unsupported = kws.filter((k) => !supported(k, harvest.index, locale));
			if (unsupported.length === kws.length) {
				const ov = overlap(kws.join(' '), keywordList(sourceData.keywords).join(' '), locale);
				if (ov >= 0.4)
					add(
						'fail',
						'translated-not-harvested',
						`${Math.round(ov * 100)}% of these tokens are the ${source} ones and none appear in the ${locale} harvest`,
					);
				else
					add(
						'fail',
						'unharvested',
						`no keyword appears in the ${locale} harvest of ${harvest.terms} terms — ship loc seed, then ship aso harvest --locale ${locale}`,
					);
			} else if (unsupported.length) {
				add(
					'warn',
					'unharvested',
					`${unsupported.length}/${kws.length} absent from the ${locale} harvest: ${unsupported.slice(0, 6).join(', ')}`,
				);
			}
		}
	}

	// (d) the glossary is the contract with the translator; both directions matter.
	if (!isSource) {
		const target = corpusOf(data);
		const src = corpusOf(sourceData);
		for (const term of neverTranslate) {
			const t = String(term).toLocaleLowerCase();
			if (!t || !src.includes(t) || target.includes(t)) continue;
			add('fail', 'glossary', `"${term}" is neverTranslate but is gone from the ${locale} copy`);
		}
		for (const [srcTerm, row] of Object.entries(glossary.terms ?? {})) {
			const agreed = row?.[locale];
			const t = String(srcTerm).toLocaleLowerCase();
			if (!agreed || !target.includes(t)) continue;
			if (neverTranslate.some((n) => String(n).toLocaleLowerCase() === t)) continue;
			add('warn', 'glossary', `"${srcTerm}" left untranslated; the glossary agreed on "${agreed}"`);
		}
	}

	// (e) code points, not UTF-16 units. German compounds routinely blow the subtitle.
	for (const [field, max] of Object.entries(LIMITS)) {
		if (data[field] == null) continue;
		const len = charCount(data[field]);
		if (len > max) add('fail', 'length', `${field} is ${len}/${max} code points — over the ASC limit`);
	}

	// (f) local legal copy.
	const acronym = REGULATORY[langOf(locale)];
	if (acronym) {
		const text = corpusOf(data);
		if (/\bgdpr\b/.test(text) && !text.includes(acronym.toLocaleLowerCase()))
			add('fail', 'legal', `says GDPR; a ${locale} listing must say ${acronym}`);
	}
	if (isEuLocale(locale) && !euTrader)
		add(
			'fail',
			'trader',
			`${locale} is an EU storefront and legal.euTrader is null — undeclared traders are removed from EU storefronts`,
		);

	return rows;
}

/**
 * Native vocabulary mined from the localized titles of a storefront's incumbents.
 * A word one app uses is that app's branding; a word two apps use is the market's
 * noun for the thing, which is what autocomplete will complete.
 * @returns {{term:string, apps:number}[]}
 */
export function seedsFromTitles(titles, { locale = 'en', exclude = [], top = 8, minApps = 2 } = {}) {
	const stop = stopwordsFor(locale);
	const skip = new Set(exclude.flatMap((e) => words(e, locale)));
	const joiner = isNoSpaceLang(locale) ? '' : ' ';
	const minLen = isNoSpaceLang(locale) ? 2 : 3;
	const freq = new Map();
	for (const title of titles) {
		const seen = new Set();
		// Store titles are `Brand: the real pitch` far more often than not.
		for (const segment of String(title ?? '').split(/[:：|—–,·・、]+|\s-\s/)) {
			const toks = words(segment, locale).filter((w) => w.length >= minLen && !stop.has(w) && !skip.has(w));
			for (let i = 0; i < toks.length; i++) {
				seen.add(toks[i]);
				if (i + 1 < toks.length) seen.add(toks[i] + joiner + toks[i + 1]);
			}
		}
		for (const term of seen) freq.set(term, (freq.get(term) ?? 0) + 1);
	}
	const entries = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shared = entries.filter(([, n]) => n >= minApps);
	return (shared.length ? shared : entries).slice(0, top).map(([term, apps]) => ({ term, apps }));
}

/** Source-locale terms worth probing a foreign storefront with, best research first. */
async function probeTerms(cfg, source, data, limit) {
	const scored = await scoredTerms(cfg, source);
	if (scored.length)
		return scored
			.sort((a, b) => b.opportunity - a.opportunity)
			.slice(0, limit)
			.map((s) => s.term);
	const fromKeywords = keywordList(data.keywords).filter((k) => !hasTodo(k));
	if (fromKeywords.length) return fromKeywords.slice(0, limit);
	const stop = stopwordsFor(source);
	return [...new Set(words(`${data.name ?? ''} ${data.subtitle ?? ''}`, source))]
		.filter((w) => w.length > 3 && !stop.has(w))
		.slice(0, limit);
}

/** Competitor ids the source-locale scoring already found; looked up abroad they answer in that language. */
async function competitorIds(cfg, source) {
	const data = await readJSON(asoFile(cfg, source, 'scored'));
	const rows = data?.terms ?? data?.scored ?? [];
	const ids = new Set();
	for (const row of rows) for (const app of row?.top3 ?? []) if (app?.id) ids.add(app.id);
	return [...ids];
}

async function seed({ flags }) {
	const cfg = await loadConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const sourceData = staged.find((s) => s.locale === source)?.data ?? {};
	const glossary = await readGlossary(cfg);
	const only = str(flags.locale);
	const locales = (only ? [only] : (cfg.store.locales ?? [])).filter((l) => l !== source);
	if (!locales.length)
		throw new ShipError('no target locales to seed', {
			hint: `add them to store.locales in ${cfg.file}, or pass --locale de-DE`,
		});

	const probes = await probeTerms(cfg, source, sourceData, Number(flags.terms ?? 5));
	if (!probes.length)
		throw new ShipError(`nothing to probe the storefronts with`, {
			hint: `run \`ship aso score --locale ${source}\` first, or stage a ${source} listing`,
		});
	const extra = csv(flags.seeds);
	const top = Number(flags.top ?? 8);
	const brand = [cfg.name, ...(glossary.neverTranslate ?? [])].filter(Boolean);
	const ids = await competitorIds(cfg, source);
	const dry = dryRun(flags);

	if (!flags.json) {
		heading(`Seed native vocabulary ${c.dim(`(source ${source})`)}`);
		info(`probing with ${c.cyan(probes.join(', '))}`);
	}

	const out = {};
	for (const locale of locales) {
		const market = marketFor(locale);
		if (!market) {
			warn(`no App Store market known for ${locale} — skipped`);
			continue;
		}
		const titles = [];
		for (const term of probes) {
			const results = (await topResults(term, { country: market.country, lang: market.lang, limit: 10 })) ?? [];
			for (const r of results) if (r.trackName) titles.push(r.trackName);
			if (!flags.json) note(`${locale} ${c.dim('←')} ${term}: ${results.length} incumbents`);
		}
		if (ids.length) {
			for (const app of await lookup(ids.slice(0, 20), { country: market.country }))
				if (app.trackName) titles.push(app.trackName);
		}

		const from = {};
		const seeds = [];
		const push = (term, origin) => {
			const key = String(term).toLocaleLowerCase().trim();
			if (!key || from[key]) return;
			from[key] = origin;
			seeds.push(key);
		};
		for (const [srcTerm, row] of Object.entries(glossary.terms ?? {}))
			if (row?.[locale]) push(row[locale], `glossary: ${srcTerm}`);
		for (const { term, apps } of seedsFromTitles(titles, { locale, exclude: brand, top }))
			push(term, `top results (${apps} app${apps === 1 ? '' : 's'})`);
		for (const term of extra) push(term, '--seeds');

		out[locale] = { market, seeds, from, titles: titles.length };
		cfg.aso.seedsByLocale = { ...(cfg.aso.seedsByLocale ?? {}), [locale]: seeds };

		if (!flags.json) {
			heading(`${locale} ${c.dim(`(${market.country}, ${titles.length} incumbent titles)`)}`);
			if (!seeds.length) note(c.dim('(nothing mined — the storefront returned no titles)'));
			table(
				seeds.map((term) => ({ term, from: from[term] })),
				[
					{ header: 'seed', get: (r) => r.term },
					{ header: 'inferred from', get: (r) => r.from },
				],
			);
		}
	}

	if (!dry) await saveConfig(cfg);
	if (flags.json) return emit({ source, dryRun: dry, locales: out });
	const total = Object.values(out).reduce((n, r) => n + r.seeds.length, 0);
	if (dry) info(`--dry-run: ${total} seeds not written to ${cfg.file}`);
	else good(`${total} native seeds → aso.seedsByLocale in ${c.dim(cfg.file)}`);
	note(c.dim(`next: ship aso harvest --locale ${locales[0]} ${c.dim('(now sweeping with native seeds)')}`));
	return 0;
}

/** Where each keyword's evidence comes from. `manual` means a human asserted it and nothing corroborates it. */
function provenanceFor(terms, { harvest, analytics, locale }) {
	const out = {};
	for (const term of terms) {
		if (hasTodo(term)) continue;
		out[term] =
			analytics && supported(term, analytics.index, locale)
				? 'analytics'
				: harvest && supported(term, harvest.index, locale)
					? 'harvest'
					: 'manual';
	}
	return out;
}

async function draft({ flags }) {
	const cfg = await loadConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const src = staged.find((s) => s.locale === source);
	if (!src)
		throw new ShipError(`no staged listing for the source locale ${source}`, {
			hint: `author ${stagedFile(cfg, source)} first — everything else is derived from it`,
		});
	const glossary = await readGlossary(cfg);
	const only = str(flags.locale);
	const locales = (only ? [only] : [...new Set([...(cfg.store.locales ?? []), ...staged.map((s) => s.locale)])])
		.filter((l) => l !== source)
		.sort();
	if (!locales.length)
		throw new ShipError('no target locales to draft', {
			hint: `add them to store.locales in ${cfg.file}, or pass --locale de-DE`,
		});

	const force = flags.force === true;
	const dry = dryRun(flags);
	const brand = new Set((glossary.neverTranslate ?? []).map((t) => String(t).toLocaleLowerCase()));
	const results = [];

	for (const locale of locales) {
		const file = stagedFile(cfg, locale);
		const existing = (await readJSON(file)) ?? {};
		const notes = existing.notes && typeof existing.notes === 'object' ? { ...existing.notes } : {};
		if (typeof existing.notes === 'string') notes.note = existing.notes;

		const out = { ...existing, locale };
		const why = {};
		const settle = (field, value, reason) => {
			out[field] = value;
			why[field] = reason;
			notes[field] = reason;
		};
		// A field a human filled in is the whole point of the exercise; only an
		// empty one or one still carrying our own marker is ours to rewrite.
		const human = (field) => !force && String(existing[field] ?? '').trim() && !hasTodo(existing[field]);
		const marker = todoMarker(locale);

		for (const field of ['name', 'subtitle']) {
			if (human(field)) continue;
			const sourceText = String(src.data[field] ?? '');
			const agreed = glossary.terms?.[sourceText]?.[locale];
			if (agreed) settle(field, agreed, `glossary: "${sourceText}"`);
			else if (field === 'name' && (sourceText === cfg.name || brand.has(sourceText.toLocaleLowerCase())))
				settle(field, sourceText, 'brand name — neverTranslate');
			else
				settle(
					field,
					`${marker} ${sourceText}`.trim(),
					`no glossary entry for "${sourceText}" — translate to ≤${LIMITS[field]} code points, then \`ship loc lock\``,
				);
		}

		const harvest = await harvestIndex(cfg, locale);
		const analytics = await analyticsIndex(cfg, locale);
		if (!human('keywords')) {
			const terms = await scoredTerms(cfg, locale);
			if (terms.length) {
				// Only pack against fields Apple will really index: a name still
				// carrying a TODO marker indexes nothing.
				const indexed = indexedWords(
					[out.name, out.subtitle].filter((v) => v && !hasTodo(v)).join(' '),
					locale,
				);
				const pool = terms.filter((t) => !isCovered(t.term, indexed, locale));
				const packed = packKeywords(pool.map((t) => ({ keyword: t.term })), { limit: LIMITS.keywords });
				settle(
					'keywords',
					packed.keywords,
					`packed ${keywordFieldLength(keywordList(packed.keywords))}/${LIMITS.keywords} from aso/${locale}/scored.json`,
				);
			} else {
				settle(
					'keywords',
					marker,
					`no aso/${locale}/scored.json — run \`ship loc seed\` then \`ship aso harvest --locale ${locale}\``,
				);
			}
		}

		if (!human('description'))
			settle(
				'description',
				`${marker} translate from ${source}:\n\n${String(src.data.description ?? '')}`,
				`untranslated ${source} copy — a silent copy would ship an inauthentic listing, so it is marked instead`,
			);

		const provenance = provenanceFor(keywordList(out.keywords), { harvest, analytics, locale });
		out.provenance = { ...(existing.provenance ?? {}), keywords: provenance };
		out.notes = notes;
		const data = order(out);
		const created = !existsSync(file);
		if (!dry) await writeJSON(file, data);
		results.push({
			locale,
			file,
			created,
			generated: Object.keys(why),
			notes: why,
			keywords: String(out.keywords ?? ''),
			provenance,
			todo: COPY_FIELDS.filter((f) => hasTodo(data[f])),
		});
	}

	if (flags.json) return emit({ source, dryRun: dry, locales: results });

	heading(`Draft from ${source} ${dry ? c.dim('(dry run)') : ''}`);
	table(results, [
		{ header: 'locale', get: (r) => r.locale },
		{ header: '', get: (r) => (r.created ? 'created' : 'refreshed') },
		{ header: 'generated', get: (r) => r.generated.join(', ') || '(nothing — all human-written)' },
		{ header: 'todo', get: (r) => r.todo.join(', ') },
	]);
	for (const r of results) {
		if (!r.generated.length) continue;
		heading(r.locale);
		for (const field of r.generated) note(`${c.cyan(field)}: ${r.notes[field]}`);
	}
	const todo = results.filter((r) => r.todo.length);
	if (todo.length)
		info(`${todo.length} locale${todo.length === 1 ? '' : 's'} need a translator: ${todo.map((r) => r.locale).join(', ')}`);
	if (dry) info('--dry-run: nothing written');
	note(c.dim('next: fill the TODO( fields, then ship loc review'));
	return 0;
}

async function review({ flags }) {
	const cfg = await loadConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	if (!staged.length)
		throw new ShipError(`no staged listings in ${cfg.paths.staged}`, {
			hint: 'run `ship loc draft` to derive them from the source listing',
		});
	const only = str(flags.locale);
	const sourceData = staged.find((s) => s.locale === source)?.data ?? {};
	const glossary = await readGlossary(cfg);
	const report = new Report(`Localization review (source ${source})`);

	for (const { locale, data } of staged) {
		if (only && locale !== only) continue;
		const rows = auditListing({
			locale,
			data,
			source,
			sourceData,
			glossary,
			harvest: await harvestIndex(cfg, locale),
			euTrader: cfg.legal.euTrader,
		});
		if (!rows.length)
			report.ok(locale, locale === source ? 'source listing' : 'translated, harvested locally, within limits');
		else for (const r of rows) report[r.level](r.name, r.detail);
	}
	if (!report.rows.length) report.skip(only ?? '(all)', 'no staged listing matched');
	return report.print({ json: flags.json });
}

/**
 * Words a translator must leave alone: the app's own name, plus any capitalised
 * token in the source name/subtitle that is not the field's first word. Sentence
 * case makes the first word ambiguous, so it only counts when it is the app name.
 */
function brandNouns(cfg, data) {
	const out = new Set();
	if (cfg.name) out.add(cfg.name);
	for (const field of ['name', 'subtitle']) {
		const tokens = String(data[field] ?? '').split(/\s+/).filter(Boolean);
		tokens.forEach((token, i) => {
			const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
			if (word.length < 2) return;
			if (word[0] === word[0].toLocaleLowerCase()) return;
			if (i > 0 || word === cfg.name) out.add(word);
		});
	}
	return [...out];
}

/** The nouns a listing is actually about — what a translator has to agree on once. */
function productNouns(data, { locale, exclude }) {
	const stop = stopwordsFor(locale);
	const skip = new Set(exclude.flatMap((t) => words(t, locale)));
	const out = new Set();
	for (const field of ['name', 'subtitle']) {
		const text = String(data[field] ?? '').trim();
		if (text) out.add(text);
		for (const w of words(text, locale)) if (w.length >= 3 && !stop.has(w) && !skip.has(w)) out.add(w);
	}
	return [...out];
}

async function lock({ flags }) {
	const cfg = await loadConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const src = staged.find((s) => s.locale === source);
	if (!src)
		throw new ShipError(`no staged listing for the source locale ${source}`, {
			hint: `author ${stagedFile(cfg, source)} first — the glossary is seeded from it`,
		});
	const existing = await readJSON(cfg.paths.glossary);
	const targets = [...new Set([...(cfg.store.locales ?? []), ...staged.map((s) => s.locale)])]
		.filter((l) => l !== source)
		.sort();

	const neverTranslate = [...new Set([...(existing?.neverTranslate ?? []), ...brandNouns(cfg, src.data)])];
	const terms = {};
	for (const [key, row] of Object.entries(existing?.terms ?? {})) terms[key] = { ...row };
	for (const key of productNouns(src.data, { locale: source, exclude: neverTranslate })) terms[key] ??= {};
	// Every target locale gets a slot, empty until a human fills it. An absent key
	// looks like an oversight; an empty one is a visible piece of work.
	for (const row of Object.values(terms)) for (const locale of targets) row[locale] ??= '';

	const glossary = stableGlossary({ sourceLocale: source, neverTranslate, terms });
	const dry = dryRun(flags);
	const before = existsSync(cfg.paths.glossary) ? await readFile(cfg.paths.glossary, 'utf8') : null;
	const after = `${JSON.stringify(glossary, null, '\t')}\n`;
	if (!dry && before !== after) await writeJSON(cfg.paths.glossary, glossary);

	if (flags.json) return emit({ file: cfg.paths.glossary, changed: before !== after, dryRun: dry, glossary });

	heading(`Glossary ${c.dim(cfg.paths.glossary)}`);
	info(`neverTranslate: ${c.cyan(glossary.neverTranslate.join(', ') || '(none)')}`);
	const rows = Object.entries(glossary.terms).map(([term, row]) => ({
		term,
		done: targets.filter((l) => row[l]).length,
		missing: targets.filter((l) => !row[l]).join(', '),
	}));
	table(rows, [
		{ header: 'source term', get: (r) => r.term },
		{ header: 'translated', get: (r) => `${r.done}/${targets.length}` },
		{ header: 'missing', get: (r) => r.missing },
	]);
	if (before === after) good('already current — nothing changed');
	else if (dry) info('--dry-run: nothing written');
	else good(`${rows.length} source terms → ${c.dim(cfg.paths.glossary)}`);
	note(c.dim('fill the blanks by hand; `ship loc draft` uses them and `ship loc review` enforces them'));
	return 0;
}

const IMAGE = /\.(png|jpe?g)$/i;

async function shotCount(cfg, locale) {
	const root = shotsDir(cfg, locale);
	if (!existsSync(root)) return 0;
	let n = 0;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) stack.push(join(dir, entry.name));
			else if (IMAGE.test(entry.name)) n++;
		}
	}
	return n;
}

async function status({ flags }) {
	const cfg = await loadConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const byLocale = new Map(staged.map((s) => [s.locale, s.data]));
	const sourceData = byLocale.get(source) ?? {};
	const glossary = await readGlossary(cfg);
	const only = str(flags.locale);
	const locales = [...new Set([source, ...(cfg.store.locales ?? []), ...byLocale.keys()])]
		.filter((l) => !only || l === only)
		.sort();

	const rows = [];
	for (const locale of locales) {
		const data = byLocale.get(locale);
		const harvest = await harvestIndex(cfg, locale);
		const findings = data
			? auditListing({
					locale,
					data,
					source,
					sourceData,
					glossary,
					harvest,
					euTrader: cfg.legal.euTrader,
				})
			: [];
		const fails = findings.filter((f) => f.level === 'fail').length;
		const warns = findings.length - fails;
		rows.push({
			locale,
			staged: !!data,
			drafted: !!data && REQUIRED.every((f) => String(data[f] ?? '').trim()),
			review: !data ? '-' : fails ? `${fails} fail` : warns ? `${warns} warn` : 'clean',
			fails,
			seeds: (cfg.aso.seedsByLocale?.[locale] ?? []).length,
			harvested: harvest?.terms ?? 0,
			shots: await shotCount(cfg, locale),
		});
	}

	const green = (r) => r.staged && r.drafted && r.review === 'clean' && r.shots > 0;
	if (flags.json) return emit({ source, locales: rows.map((r) => ({ ...r, green: green(r) })) });

	const mark = (ok) => (ok ? c.green('yes') : c.red('no'));
	heading(`Localization status ${c.dim(`(source ${source})`)}`);
	table(rows, [
		{ header: 'locale', get: (r) => (r.locale === source ? `${r.locale} ${c.dim('(source)')}` : r.locale) },
		{ header: 'staged', get: (r) => mark(r.staged) },
		{ header: 'drafted', get: (r) => mark(r.drafted) },
		{ header: 'review', get: (r) => (r.review === 'clean' ? c.green(r.review) : r.fails ? c.red(r.review) : c.yellow(r.review)) },
		{ header: 'seeds', get: (r) => String(r.seeds) },
		{ header: 'harvested', get: (r) => String(r.harvested) },
		{ header: 'shots', get: (r) => String(r.shots) },
	]);
	const blocked = rows.filter((r) => !green(r));
	if (!blocked.length) good('every locale is staged, clean and has screenshots');
	else note(c.dim(`not ready: ${blocked.map((r) => r.locale).join(', ')} — ship loc review for the detail`));
	return flags.strict && blocked.length ? 1 : 0;
}

const SUB = { status, seed, draft, review, lock };

export async function run({ args, flags }) {
	const [sub = 'status', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`loc: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}
