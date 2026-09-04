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
// The audit rules live in lib/listing-audit.mjs and the index/cache helpers in
// lib/loc-index.mjs; this file is orchestration only.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, loadConfig, saveConfig } from '../config.mjs';
import { isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, table, warn } from '../log.mjs';
import { lookup, marketFor, packKeywords, topResults } from '../lib/appstore.mjs';
import {
	analyticsIndex,
	brandNouns,
	competitorIds,
	harvestIndex,
	mineSeeds,
	order,
	probeTerms,
	productNouns,
	provenanceFor,
	scoredTerms,
} from '../lib/loc-index.mjs';
import {
	COPY_FIELDS,
	auditListing,
	hasTodo,
	isEuLocale,
	readGlossary,
	stableGlossary,
	todoMarker,
} from '../lib/listing-audit.mjs';
import { readJSONIfExists, writeJSON } from '../lib/jsonio.mjs';
import { emit } from '../lib/output.mjs';
import { keywordList, readStaged } from '../lib/locales.mjs';
import { indexedWords, isCovered, keywordFieldLength } from '../lib/text.mjs';
import { objOrEmpty, resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../lib/util.mjs').Json} Json */
/** @typedef {import('../lib/util.mjs').JsonObject} JsonObject */
/** @typedef {import('../lib/util.mjs').Flags} Flags */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../config.mjs').Limits} Limits */
/** @typedef {import('../lib/locales.mjs').ListingData} ListingData */
/** @typedef {import('../lib/locales.mjs').StagedListing} StagedListing */
/** @typedef {import('../lib/listing-audit.mjs').Glossary} Glossary */
/** @typedef {import('../lib/listing-audit.mjs').Finding} Finding */
/** @typedef {import('../lib/loc-index.mjs').HarvestIndex} HarvestIndex */

/** One locale's seed pass result. */
/** @typedef {{market: Json, seeds: string[], from: Record<string, string>, titles: number}} SeedRow */
/** One locale's draft pass result. */
/** @typedef {{locale: string, file: string, created: boolean, generated: string[], notes: Record<string, string>, keywords: string, provenance: Record<string, 'analytics'|'harvest'|'manual'>, todo: string[]}} DraftRow */
/** One locale's readiness row for `ship loc status`. */
/** @typedef {{locale: string, staged: boolean, drafted: boolean, review: string, fails: number, seeds: number, harvested: number, shots: number}} StatusRow */

// The audit is the shared contract (`review` prints it, `status` counts it);
// re-exported so consumers can keep importing it from the command.
export { auditListing, isEuLocale };

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

/** @param {string|boolean|undefined} v @returns {string[]} */
const csv = (v) => (strOf(v) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** @param {Flags} flags @returns {boolean} */
const dryRun = (flags) => isDryRun() || flags['dry-run'] === true || flags.n === true;

/** The locale everything is authored in. `loc.sourceLocale` overrides the ASC primary. */
/** @param {Config} cfg @returns {string} */
const sourceOf = (cfg) => cfg.loc.sourceLocale ?? cfg.asc.primaryLocale;

/** Fields a listing must fill before it is submittable. */
const REQUIRED = ['name', 'subtitle', 'keywords', 'description'];

/** @param {Config} cfg @param {string} locale @returns {string} */
const stagedFile = (cfg, locale) => join(cfg.paths.staged, `${locale}.json`);
/** @param {Config} cfg @param {string} locale @returns {string} */
const shotsDir = (cfg, locale) => join(cfg.paths.store, 'screenshots', locale);

/**
 * The non-optional loadConfig throws before it can return null; this narrows
 * the type so callers do not repeat the check.
 *
 * @returns {Promise<Config>}
 */
async function requireConfig() {
	const cfg = await loadConfig();
	if (!cfg) throw new ShipError('no ship.config.json found', { hint: 'run `ship init` inside the app repo to create one' });
	return cfg;
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function seed({ flags }) {
	const cfg = await requireConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const sourceData = staged.find((s) => s.locale === source)?.data ?? /** @type {ListingData} */ ({});
	const glossary = await readGlossary(cfg, source);
	const only = strOf(flags.locale);
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

	/** @type {Record<string, SeedRow>} */
	const out = {};
	for (const locale of locales) {
		const row = await seedLocale({ locale, probes, ids, glossary, brand, extra, top, json: !!flags.json });
		if (!row) continue;
		out[locale] = row;
		cfg.aso.seedsByLocale = { ...cfg.aso.seedsByLocale, [locale]: row.seeds };
	}

	if (!dry) await saveConfig(cfg);
	if (flags.json) return emit({ source, dryRun: dry, locales: out });
	const total = Object.values(out).reduce((n, r) => n + r.seeds.length, 0);
	if (dry) info(`--dry-run: ${total} seeds not written to ${cfg.file}`);
	else good(`${total} native seeds → aso.seedsByLocale in ${c.dim(cfg.file)}`);
	note(c.dim(`next: ship aso harvest --locale ${locales[0]} ${c.dim('(now sweeping with native seeds)')}`));
	return 0;
}

/**
 * One locale's seed pass: probe its storefront with the source terms, look up
 * the source-locale competitors abroad, then mine the titles into seed terms.
 * Returns null (after a warning) when no App Store market is known.
 *
 * @param {{locale: string, probes: string[], ids: string[], glossary: Glossary, brand: string[], extra: string[], top: number, json: boolean}} p
 * @returns {Promise<SeedRow|null>}
 */
async function seedLocale({ locale, probes, ids, glossary, brand, extra, top, json }) {
	const market = marketFor(locale);
	if (!market) {
		warn(`no App Store market known for ${locale} — skipped`);
		return null;
	}
	const titles = await probeTitles({ probes, market, locale, json });
	if (ids.length) {
		for (const app of await lookup(ids.slice(0, 20), { country: market.country }))
			if (app.trackName) titles.push(app.trackName);
	}
	const { seeds, from } = mineSeeds({ titles, glossary, locale, exclude: brand, extra, top });

	if (!json) {
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
	return { market, seeds, from, titles: titles.length };
}

/** Titles from the storefront's own top results, one probe term at a time. */
/**
 * @param {{probes: string[], market: {country: string, lang: string}, locale: string, json: boolean}} p
 * @returns {Promise<string[]>}
 */
async function probeTitles({ probes, market, locale, json }) {
	const titles = [];
	for (const term of probes) {
		const results = (await topResults(term, { country: market.country, lang: market.lang, limit: 10 })) ?? [];
		for (const r of results) if (r.trackName) titles.push(r.trackName);
		if (!json) note(`${locale} ${c.dim('←')} ${term}: ${results.length} incumbents`);
	}
	return titles;
}

/**
 * Load the config and the staged listing for the source locale — the prologue
 * every subcommand that derives from the authored listing shares.
 *
 * @param {string} hint what to do when the source listing is missing
 * @returns {Promise<{cfg: Config, source: string, staged: StagedListing[], src: StagedListing}>}
 */
async function sourceListing(hint) {
	const cfg = await requireConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	const src = staged.find((s) => s.locale === source);
	if (!src)
		throw new ShipError(`no staged listing for the source locale ${source}`, {
			hint: `author ${stagedFile(cfg, source)} first — ${hint}`,
		});
	return { cfg, source, staged, src };
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function draft({ flags }) {
	const { cfg, source, staged, src } = await sourceListing('everything else is derived from it');
	const glossary = await readGlossary(cfg, source);
	const only = strOf(flags.locale);
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
	/** @type {DraftRow[]} */
	const results = [];
	for (const locale of locales)
		results.push(await draftLocale({ cfg, src, glossary, brand, source, locale, force, dry }));

	if (flags.json) return emit({ source, dryRun: dry, locales: results });
	printDraft(results, { source, dry });
	return 0;
}

/** The human summary after a draft pass: one table row per locale, then per-field notes. */
/**
 * @param {DraftRow[]} results
 * @param {{source: string, dry: boolean}} p
 * @returns {void}
 */
function printDraft(results, { source, dry }) {
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
}

/** Derive every un-held field of one locale: glossary, brand rule, local research, or a marked TODO. */
/**
 * @param {{cfg: Config, src: StagedListing, glossary: Glossary, brand: Set<string>, source: string, locale: string, force: boolean, dry: boolean}} p
 * @returns {Promise<DraftRow>}
 */
async function draftLocale({ cfg, src, glossary, brand, source, locale, force, dry }) {
	const file = stagedFile(cfg, locale);
	const existing = /** @type {Partial<ListingData>} */ ((await readJSONIfExists(file)) ?? {});
	/** @type {JsonObject} */
	const notes = { ...objOrEmpty(existing.notes) };
	if (typeof existing.notes === 'string') notes.note = existing.notes;

	/** @type {JsonObject} */
	const out = { ...existing, locale };
	/** @type {Record<string, string>} */
	const why = {};
	/**
	 * @param {string} field
	 * @param {Json} value
	 * @param {string} reason
	 */
	const settle = (field, value, reason) => {
		out[field] = value;
		why[field] = reason;
		notes[field] = reason;
	};
	// A field a human filled in is the whole point of the exercise; only an
	// empty one or one still carrying our own marker is ours to rewrite.
	/** @param {string} field @returns {boolean} */
	const human = (field) => !force && Boolean(String(existing[field] ?? '').trim()) && !hasTodo(existing[field]);
	const marker = todoMarker(locale);

	for (const field of /** @type {('name'|'subtitle')[]} */ (['name', 'subtitle'])) {
		if (human(field)) continue;
		const plan = copyFieldPlan({
			field,
			sourceText: String(src.data[field] ?? ''),
			locale,
			glossary,
			brand,
			cfg,
			marker,
		});
		settle(field, plan.value, plan.reason);
	}

	const harvest = await harvestIndex(cfg, locale);
	const analytics = await analyticsIndex(cfg, locale);
	if (!human('keywords')) {
		const plan = await keywordsPlan({ cfg, locale, out, marker });
		settle('keywords', plan.value, plan.reason);
	}
	if (!human('description'))
		settle(
			'description',
			`${marker} translate from ${source}:\n\n${String(src.data.description ?? '')}`,
			`untranslated ${source} copy — a silent copy would ship an inauthentic listing, so it is marked instead`,
		);

	const provenance = provenanceFor(keywordList(out.keywords), { harvest, analytics, locale });
	out.provenance = { ...existing.provenance, keywords: provenance };
	out.notes = notes;
	const data = order(out);
	const created = !existsSync(file);
	if (!dry) await writeJSON(file, data);
	return {
		locale,
		file,
		created,
		generated: Object.keys(why),
		notes: why,
		keywords: String(out.keywords ?? ''),
		provenance,
		todo: COPY_FIELDS.filter((f) => hasTodo(data[f])),
	};
}

/**
 * How one copy field (name/subtitle) is derived when no human wrote it: the
 * glossary agreement, the brand passthrough, or a marked TODO for a translator.
 *
 * @param {{field: keyof Limits, sourceText: string, locale: string, glossary: Glossary, brand: Set<string>, cfg: Config, marker: string}} p
 * @returns {{value: string, reason: string}}
 */
function copyFieldPlan({ field, sourceText, locale, glossary, brand, cfg, marker }) {
	const agreed = glossary.terms?.[sourceText]?.[locale];
	if (agreed) return { value: agreed, reason: `glossary: "${sourceText}"` };
	if (field === 'name' && (sourceText === cfg.name || brand.has(sourceText.toLocaleLowerCase())))
		return { value: sourceText, reason: 'brand name — neverTranslate' };
	return {
		value: `${marker} ${sourceText}`.trim(),
		reason: `no glossary entry for "${sourceText}" — translate to ≤${LIMITS[field]} code points, then \`ship loc lock\``,
	};
}

/** Keywords packed from this locale's own scored terms around what Apple already indexes, or a marker. */
/**
 * @param {{cfg: Config, locale: string, out: JsonObject, marker: string}} p
 * @returns {Promise<{value: string, reason: string}>}
 */
async function keywordsPlan({ cfg, locale, out, marker }) {
	const terms = await scoredTerms(cfg, locale);
	if (!terms.length)
		return {
			value: marker,
			reason: `no aso/${locale}/scored.json — run \`ship loc seed\` then \`ship aso harvest --locale ${locale}\``,
		};
	// Only pack against fields Apple will really index: a name still
	// carrying a TODO marker indexes nothing.
	const indexed = indexedWords([out.name, out.subtitle].filter((v) => v && !hasTodo(v)).join(' '), locale);
	const pool = terms.filter((t) => !isCovered(t.term, indexed, locale));
	const packed = packKeywords(pool.map((t) => ({ keyword: t.term })), { limit: LIMITS.keywords });
	return {
		value: packed.keywords,
		reason: `packed ${keywordFieldLength(keywordList(packed.keywords))}/${LIMITS.keywords} from aso/${locale}/scored.json`,
	};
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function review({ flags }) {
	const cfg = await requireConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	if (!staged.length)
		throw new ShipError(`no staged listings in ${cfg.paths.staged}`, {
			hint: 'run `ship loc draft` to derive them from the source listing',
		});
	const only = strOf(flags.locale);
	const sourceData = staged.find((s) => s.locale === source)?.data ?? /** @type {ListingData} */ ({});
	const glossary = await readGlossary(cfg, source);
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
	return report.print({ json: !!flags.json });
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function lock({ flags }) {
	const { cfg, source, staged, src } = await sourceListing('the glossary is seeded from it');
	const existing = /** @type {Glossary} */ ((await readJSONIfExists(cfg.paths.glossary)) ?? {});
	const targets = [...new Set([...(cfg.store.locales ?? []), ...staged.map((s) => s.locale)])]
		.filter((l) => l !== source)
		.sort();

	const neverTranslate = [...new Set([...(existing?.neverTranslate ?? []), ...brandNouns(cfg, src.data)])];
	/** @type {{[srcTerm: string]: {[locale: string]: string}}} */
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
	info(`neverTranslate: ${c.cyan((glossary.neverTranslate ?? []).join(', ') || '(none)')}`);
	const rows = Object.entries(glossary.terms ?? {}).map(([term, row]) => ({
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

/**
 * @param {Config} cfg
 * @param {string} locale
 * @returns {Promise<number>}
 */
async function shotCount(cfg, locale) {
	const root = shotsDir(cfg, locale);
	if (!existsSync(root)) return 0;
	let n = 0;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		if (dir === undefined) continue;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) stack.push(join(dir, entry.name));
			else if (IMAGE.test(entry.name)) n++;
		}
	}
	return n;
}

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
async function status({ flags }) {
	const cfg = await requireConfig();
	const source = sourceOf(cfg);
	const staged = await readStaged(cfg);
	/** @type {Map<string, ListingData>} */
	const byLocale = new Map(staged.map((s) => [s.locale, s.data]));
	const sourceData = byLocale.get(source) ?? /** @type {ListingData} */ ({});
	const glossary = await readGlossary(cfg, source);
	const only = strOf(flags.locale);
	const locales = [...new Set([source, ...(cfg.store.locales ?? []), ...byLocale.keys()])]
		.filter((l) => !only || l === only)
		.sort();

	/** @type {StatusRow[]} */
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

	/** @param {StatusRow} r @returns {boolean} */
	const green = (r) => r.staged && r.drafted && r.review === 'clean' && r.shots > 0;
	if (flags.json) return emit({ source, locales: rows.map((r) => ({ ...r, green: green(r) })) });

	/** @param {boolean} ok @returns {string} */
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

/** @type {Record<string, (ctx: SubCtx) => Promise<number>>} */
const SUB = { status, seed, draft, review, lock };

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'loc', args, subs: SUB, fallback: 'status' });
	return fn({ args: rest, flags });
}
