// ASO — keyword research against the live App Store, then into the listing.
//
// Everything here is a pipeline over files, because the research half is slow
// (Apple throttles autocomplete to roughly one request per second per storefront
// and answers a burst with 403s) and the authoring half must stay reviewable in
// git. Each stage writes its artifact under aso/<locale>/ and the next stage
// reads it, so a rate-limit wall costs you one stage, never the whole session.
//
// The ranking rule the whole command exists to serve: opportunity is demand
// times competition. Optimising for weak incumbents alone reliably ships a
// perfectly winnable keyword nobody types.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { asc, isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import {
	CACHE_TTL_MS,
	demandTable,
	harvest as harvestTerms,
	lookup,
	marketFor,
	packKeywords,
	pickCandidates,
	progressLine,
	scoreAll,
	useCache,
} from '../lib/appstore.mjs';
import { charCount, indexedWords, isCovered, isNoSpaceLang } from '../lib/text.mjs';
import { keywordList, lintListing, readStaged } from '../lib/locales.mjs';

export const help = `
${c.bold('ship aso')} ${c.dim('— App Store keyword research and packing')}

${c.dim('usage:')} ship aso [subcommand] [flags]

  ${c.cyan('harvest')}      ${c.dim('default')} sweep App Store autocomplete for candidate queries
  ${c.cyan('volume')}       import or show real search volume for those candidates
  ${c.cyan('score')}        score candidates: demand × competition on the live top-10
  ${c.cyan('suggest')}      pack the best terms into a 100-char field ${c.dim('(prints only)')}
  ${c.cyan('apply')}        write that field into store/staged/<locale>.json
  ${c.cyan('competitors')}  profile competing apps and the vocabulary they buy
  ${c.cyan('audit')}        Apple's discoverability tags + keyword audit + offline lint

${c.bold('Flags')}
  ${c.cyan('--locale <l>')}    locale to work on ${c.dim('(default: asc.primaryLocale)')}
  ${c.cyan('--all-locales')}   harvest/volume/score/suggest every locale in store.locales
  ${c.cyan('--seeds "a,b"')}   harvest seeds ${c.dim('(default: aso.seedsByLocale[locale], aso.seeds, else the staged listing)')}
  ${c.cyan('--file <f>')}      ${c.cyan('volume')} import: {"term": 62}, {"terms":{"term":{"popularity":62}}}, or an Apple Ads Platform API v1 response
  ${c.cyan('--limit <n>')}     score at most n candidates, shortest first ${c.dim('(default 120)')}
  ${c.cyan('--words <n>')}     max words per candidate ${c.dim('(default 4)')}
  ${c.cyan('--ids 123,456')}   competitor App Store ids ${c.dim('(default: top 3 from scored.json)')}
  ${c.cyan('--version <v>')}   ASC version for ${c.cyan('audit')} ${c.dim('(default: app.json)')}
  ${c.cyan('--refresh')}       re-fetch even when the response cache still has an answer
  ${c.cyan('--no-cache')}      neither read nor write ${c.dim('.asc/cache/appstore')} ${c.dim(`(TTL ${CACHE_TTL_MS / 86_400_000}d)`)}
  ${c.cyan('--json')}          emit the underlying artifact

${c.bold('Ranking')}
  ${c.dim('opportunity = demand × competition — a term with no demand scores 0 however')}
  ${c.dim('weak its incumbents. Demand comes from measured impressions')}
  ${c.dim('(.asc/analytics/<locale>-terms.json), else aso/<locale>/volume.json, else the')}
  ${c.dim('position Apple gives the term in autocomplete. aso.minVolume drops the rest.')}

${c.dim('Artifacts: aso/<locale>/{candidates,volume,scored,competitors}.json')}
${c.dim('Order: harvest → volume (optional) → score → suggest → apply')}
`;

const emit = (data) => {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	return 0;
};

const localeDir = (cfg, locale) => join(cfg.paths.aso, locale);
const artifactPath = (cfg, locale, kind) => join(localeDir(cfg, locale), `${kind}.json`);

/** Shortest first: one- and two-word queries are the high-volume heads. */
const byLength = (a, b) => a.length - b.length || a.localeCompare(b);

async function writeArtifact(cfg, locale, kind, data) {
	const file = artifactPath(cfg, locale, kind);
	await mkdir(localeDir(cfg, locale), { recursive: true });
	await writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

const NEXT_STAGE = {
	candidates: 'ship aso harvest',
	scored: 'ship aso score',
	competitors: 'ship aso competitors',
};

async function readArtifact(cfg, locale, kind) {
	const file = artifactPath(cfg, locale, kind);
	if (!existsSync(file))
		throw new ShipError(`no ${kind}.json for ${locale}`, {
			hint: `run \`${NEXT_STAGE[kind]} --locale ${locale}\` first`,
		});
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

/** Optional inputs (volume, analytics) never block a stage: absent means "no signal". */
async function readOptional(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		warn(`ignoring ${file}: ${err.message}`);
		return null;
	}
}

/** Terms scored by an earlier run, tolerating the pre-demand `scored` key. */
const scoredTerms = (artifact) => artifact?.terms ?? artifact?.scored ?? [];

/**
 * A repeated harvest is the same 40 requests against a store that changes
 * weekly, so the cache turns a re-run into seconds and, more importantly,
 * keeps a 403 wall halfway through a sweep from costing the locales already paid for.
 */
function configureCache(cfg, flags) {
	useCache({
		dir: join(cfg.paths.root, '.asc', 'cache', 'appstore'),
		mode: flags['no-cache'] ? 'off' : flags.refresh ? 'refresh' : 'on',
	});
}

/** Config + the locale/market pair every subcommand operates on. */
async function context(flags) {
	const cfg = await loadConfig();
	const locale = String(flags.locale ?? cfg.asc.primaryLocale);
	const market = requireMarket(locale);
	configureCache(cfg, flags);
	return { cfg, locale, market };
}

function requireMarket(locale) {
	const market = marketFor(locale);
	if (!market)
		throw new ShipError(`no App Store market known for locale "${locale}"`, {
			hint: 'add it to LOCALE_MARKETS in src/lib/appstore.mjs, or pass a supported --locale',
		});
	return market;
}

/** Progress belongs on stdout, which --json owns exclusively. */
const reporter = (flags) => (flags.json ? undefined : progressLine);

const listingFor = async (cfg, locale) => (await readStaged(cfg)).find((s) => s.locale === locale) ?? null;

/** The locale the app is authored in; everything else is a translation. */
const sourceLocale = (cfg) => cfg.loc.sourceLocale ?? cfg.asc.primaryLocale;

/** Scored terms whose every word is already covered by name/subtitle. */
function coveredTerms(scored, alreadyIndexed, locale) {
	const indexed = indexedWords(alreadyIndexed, locale);
	if (!indexed.size) return [];
	return scored
		.map((e) => (typeof e === 'string' ? e : e.keyword))
		.filter((t) => isCovered(t, indexed, locale));
}

/**
 * Where this locale's seeds come from, and whether they are the wrong language.
 * Feeding English seeds to the German storefront returns Apple's translation of
 * our own copy, not what Germans type into search — the single most expensive
 * mistake in a multi-market harvest, so it warns instead of quietly proceeding.
 */
async function seedsFor(cfg, locale, flags) {
	const split = (s) =>
		String(s ?? '')
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);

	let seeds = split(flags.seeds);
	let origin = '--seeds';
	let translated = seeds.length > 0;
	if (!seeds.length && cfg.aso.seedsByLocale?.[locale]?.length) {
		seeds = [...cfg.aso.seedsByLocale[locale]];
		origin = `aso.seedsByLocale.${locale}`;
		translated = false;
	}
	if (!seeds.length && cfg.aso.seeds?.length) {
		seeds = [...cfg.aso.seeds];
		origin = `aso.seeds in ${cfg.file}`;
		translated = true;
	}
	if (!seeds.length) {
		// Last resort: the listing itself. Short words are stop words in every
		// market we support and return junk from autocomplete — except where the
		// script has no spaces and a two-character token is a whole word.
		const listing = await listingFor(cfg, locale);
		const text = `${listing?.data.name ?? ''} ${listing?.data.subtitle ?? ''}`;
		const min = isNoSpaceLang(locale) ? 1 : 4;
		seeds = [...indexedWords(text, locale)].filter((w) => charCount(w) >= min);
		origin = listing ? `staged ${locale} name + subtitle` : 'nothing';
		translated = false;
	}
	const mismatch = translated && locale !== sourceLocale(cfg);
	return { seeds, origin, mismatch };
}

async function harvestOne(cfg, locale, market, flags) {
	const { seeds, origin, mismatch } = await seedsFor(cfg, locale, flags);
	if (!seeds.length)
		throw new ShipError(`no harvest seeds for ${locale}`, {
			hint: `pass --seeds "car maintenance,service log", or set aso.seedsByLocale.${locale} in ${cfg.file}`,
		});

	if (!flags.json) {
		heading(`Harvest ${locale} ${c.dim(`(${market.country})`)}`);
		info(`${seeds.length} seed${seeds.length === 1 ? '' : 's'} from ${origin}: ${c.cyan(seeds.join(', '))}`);
	}
	if (mismatch) {
		warn(`${locale} is being harvested with ${sourceLocale(cfg)} seeds — autocomplete will answer with`);
		warn('translations of your own copy, not the queries locals type');
		note(c.dim(`fix: ship loc seed --locale ${locale}, or set aso.seedsByLocale.${locale}`));
	}

	const save = async (terms) => {
		const artifact = { generatedAt: new Date().toISOString(), locale, market, seeds, terms };
		return { artifact, file: await writeArtifact(cfg, locale, 'candidates', artifact) };
	};
	const onPartial = async (partial) => {
		const { file } = await save(partial);
		warn(`${locale}: kept ${Object.keys(partial).length} candidates harvested before the wall → ${file}`);
	};

	const terms = await harvestTerms(seeds, market.country, { onProgress: reporter(flags), onPartial });
	const { artifact, file } = await save(terms);
	return { locale, market, seeds, origin, mismatch, terms, artifact, file, count: Object.keys(terms).length };
}

function printHarvest(out) {
	const names = Object.keys(out.terms);
	good(`${names.length} candidate terms → ${c.dim(out.file)}`);
	for (const term of names.slice(0, 15)) note(`${term} ${c.dim(`← ${out.terms[term].seeds.join(', ')}`)}`);
	if (names.length > 15) note(c.dim(`… ${names.length - 15} more`));
	if (!names.length) warn('autocomplete returned nothing — Apple may be throttling; retry in a minute');
	note(c.dim(`next: ship aso score --locale ${out.locale}`));
}

const HARVEST = {
	name: 'harvest',
	run: harvestOne,
	print: printHarvest,
	ok: (out) => out.count > 0,
	summary: (out) => ({ candidates: out.count, seeds: out.seeds.length, file: out.file }),
};

async function harvest({ flags }) {
	if (flags['all-locales']) return sweep(flags, HARVEST);
	const { cfg, locale, market } = await context(flags);
	const out = await harvestOne(cfg, locale, market, flags);
	if (flags.json) return emit(out.artifact);
	printHarvest(out);
	return out.count ? 0 : 1;
}

const VOLUME_TEMPLATE = {
	terms: {
		'car maintenance log': { popularity: 62, difficulty: 30 },
		'service reminder': { popularity: 41 },
	},
};

/**
 * A Platform API v1 response wraps its payload in `result`, and the popularity
 * report wraps it again in `rows`. Unwrapping here rather than at the call site is
 * what lets `--file` take a saved API response with no editing.
 */
const unwrapResult = (raw) => {
	const result = raw?.result ?? raw;
	return result?.rows ?? result;
};

/** `term`/`keyword` are ours, `text` is v1 keyword suggestions, `searchTerm` is the popularity report. */
const termOf = (row) => row?.term ?? row?.keyword ?? row?.text ?? row?.searchTerm;

/**
 * v1 reports popularity on three scales. `searchPopularity1to100` is the same 0-100
 * axis `demandTable` already fuses with autocomplete rank, so it reads as `popularity`
 * unchanged. `searchPopularityInGenre` is genre-relative and is the fallback when the
 * absolute column is absent. `searchPopularity1to5` is deliberately not read: on a
 * 0-100 axis a 5 would bury the term under every rank-estimated candidate.
 */
const popularityOf = (value) =>
	typeof value === 'object' && value !== null
		? (value.popularity ?? value.volume ?? value.searchPopularity1to100 ?? value.searchPopularityInGenre)
		: value;

/** WEEKLY_SUN_SAT rows are keyed `week`; MONTHLY rows and our own dumps vary. */
const dateOf = (row) => String(row?.week ?? row?.date ?? row?.month ?? '');

/**
 * Accept a hand-written map, an MCP dump, one of our own files, or a raw Apple Ads
 * Platform API v1 response, and return our shape. Popularity is Apple-style 0-100;
 * anything unparseable is dropped rather than defaulted, because a fabricated 50
 * outranks real terms.
 *
 * Two v1 payloads carry popularity and both land here unmodified, because the
 * alternative — a bespoke importer per endpoint — is three parsers for one number:
 *   POST /v1/suggestions/keywords/query        → {result:[{text, popularity}]}
 *   POST /v1/insights/apps/search-term-popularity/query
 *                                              → {result:{rows:[{searchTerm, …}]}}
 */
export function normaliseVolume(raw, locale) {
	const terms = {};
	const dated = new Map();
	const add = (term, value, at = '') => {
		const key = String(term ?? '').trim().toLocaleLowerCase();
		if (!key) return;
		const popularity = Number(popularityOf(value));
		if (!Number.isFinite(popularity)) return;
		// A multi-week popularity pull repeats every term once per week, and nothing
		// promises the rows arrive in date order. Newest wins; undated rows keep the
		// old last-one-read behaviour.
		const seen = dated.get(key);
		if (seen !== undefined && seen > at) return;
		dated.set(key, at);
		const row = { popularity: Math.max(0, Math.min(100, popularity)) };
		const difficulty = Number(value?.difficulty);
		if (Number.isFinite(difficulty)) row.difficulty = difficulty;
		terms[key] = row;
	};
	const body = unwrapResult(raw);
	const rows = Array.isArray(body) ? body : Array.isArray(body?.terms) ? body.terms : null;
	if (rows) for (const row of rows) add(termOf(row), row, dateOf(row));
	else for (const [term, value] of Object.entries(body?.terms ?? body ?? {})) add(term, value);
	return { generatedAt: new Date().toISOString(), locale, terms };
}

async function volumeOne(cfg, locale, _market, flags) {
	const file = artifactPath(cfg, locale, 'volume');
	const existing = await readOptional(file);

	if (flags.file) {
		const source = String(flags.file);
		if (!existsSync(source)) throw new ShipError(`no such file: ${source}`);
		let raw;
		try {
			raw = JSON.parse(await readFile(source, 'utf8'));
		} catch (err) {
			throw new ShipError(`${source} is not valid JSON`, { hint: err.message });
		}
		const imported = normaliseVolume(raw, locale);
		if (!Object.keys(imported.terms).length)
			throw new ShipError(`${source} carried no usable terms`, {
				hint: 'expected {"term": 62}, {"terms": {"term": {"popularity": 62}}}, or a saved /v1/suggestions/keywords or /v1/insights/apps/search-term-popularity response',
			});
		// Merge: an MCP dump usually covers one batch of terms, not the whole file.
		const artifact = { ...imported, terms: { ...(existing?.terms ?? {}), ...imported.terms } };
		return { locale, file: await writeArtifact(cfg, locale, 'volume', artifact), artifact, imported: Object.keys(imported.terms).length, source };
	}

	if (existing) return { locale, file, artifact: existing, imported: 0, source: null };
	return { locale, file, artifact: { ...VOLUME_TEMPLATE, locale }, imported: 0, source: null, template: true };
}

function printVolume(out) {
	const rows = Object.entries(out.artifact.terms ?? {}).sort((a, b) => (b[1].popularity ?? 0) - (a[1].popularity ?? 0));
	if (out.template) {
		heading(`No volume data for ${out.locale}`);
		info(`write ${c.dim(out.file)} by hand, or import one with ${c.cyan('--file <f>')}:`);
		process.stdout.write(`\n${JSON.stringify(out.artifact, null, '\t')}\n\n`);
		note(c.dim('popularity is 0-100 and overrides the autocomplete-rank estimate for that term'));
		return;
	}
	if (out.source) good(`imported ${out.imported} terms from ${c.dim(out.source)} → ${c.dim(out.file)}`);
	table(rows.slice(0, 25), [
		{ header: 'term', get: (r) => r[0] },
		{ header: 'popularity', get: (r) => String(r[1].popularity ?? '') },
		{ header: 'difficulty', get: (r) => (r[1].difficulty === undefined ? '' : String(r[1].difficulty)) },
	]);
	if (rows.length > 25) note(c.dim(`… ${rows.length - 25} more`));
	note(c.dim(`next: ship aso score --locale ${out.locale}`));
}

const VOLUME = {
	name: 'volume',
	run: volumeOne,
	print: printVolume,
	summary: (out) => ({ terms: Object.keys(out.artifact.terms ?? {}).length, file: out.file, imported: out.imported }),
};

async function volume({ flags }) {
	if (flags['all-locales']) return sweep(flags, VOLUME);
	const { cfg, locale, market } = await context(flags);
	const out = await volumeOne(cfg, locale, market, flags);
	if (flags.json) return emit(out.artifact);
	printVolume(out);
	return 0;
}

/** Demand per candidate term: measured impressions, else volume.json, else autocomplete rank. */
async function demandFor(cfg, locale, terms) {
	const volumeFile = await readOptional(artifactPath(cfg, locale, 'volume'));
	const analytics = await readOptional(join(cfg.paths.analytics, `${locale}-terms.json`));
	return demandTable(terms, { volume: volumeFile, analytics });
}

async function scoreOne(cfg, locale, market, flags) {
	const candidates = await readArtifact(cfg, locale, 'candidates');
	const terms = candidates.terms ?? {};
	const demands = await demandFor(cfg, locale, terms);

	const maxWords = Number(flags.words ?? 4);
	const limit = Number(flags.limit ?? 120);
	const minVolume = Number(cfg.aso.minVolume ?? 0);
	const picked = pickCandidates(Object.keys(terms), { maxWords });
	const eligible = picked.filter((t) => (demands.get(t)?.demand ?? 0) >= minVolume);
	const chosen = [...eligible].sort(byLength).slice(0, limit);
	if (!chosen.length)
		throw new ShipError(`no scorable candidates for ${locale}`, {
			hint: minVolume
				? `${picked.length} candidates, all under aso.minVolume ${minVolume} — lower it or run \`ship aso volume --locale ${locale}\``
				: `harvest returned ${Object.keys(terms).length} terms; widen with --words`,
		});

	if (!flags.json) {
		heading(`Score ${locale} ${c.dim(`(${market.country})`)}`);
		const dropped = picked.length - eligible.length;
		info(
			`${chosen.length} of ${picked.length} candidates${dropped ? c.dim(` (${dropped} under minVolume ${minVolume})`) : ''}, ~1s each → ${c.dim(`${Math.ceil(chosen.length / 60)} min`)}`,
		);
	}

	const scored = await scoreAll(chosen, candidates.market ?? market, { onProgress: reporter(flags), demands });
	for (const entry of scored) {
		const row = demands.get(entry.keyword);
		if (!row) continue;
		entry.demandSource = row.source;
		if (row.difficulty !== undefined) entry.difficulty = row.difficulty;
	}
	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		market: candidates.market ?? market,
		minVolume,
		terms: scored,
	};
	const file = await writeArtifact(cfg, locale, 'scored', artifact);
	return { locale, market, scored, artifact, file, count: scored.length };
}

function printScore(out) {
	heading(`Top ${Math.min(20, out.count)} of ${out.count} — ${out.locale}`);
	table(out.scored.slice(0, 20), [
		{ header: 'keyword', get: (s) => s.keyword },
		{ header: 'opp', get: (s) => String(s.opportunity) },
		{ header: 'demand', get: (s) => `${s.demand}${s.demandSource === 'rank' ? '' : '*'}` },
		{ header: 'comp', get: (s) => String(s.competition) },
		{ header: 'medRatings', get: (s) => String(s.medianRatings) },
		{ header: 'weak/10', get: (s) => String(s.weakAppsTop10) },
		{ header: 'top competitor', get: (s) => s.top3[0]?.name ?? '' },
	]);
	note(c.dim('* demand measured from analytics or volume.json rather than autocomplete rank'));
	good(`scored ${out.count} terms → ${c.dim(out.file)}`);
	note(c.dim(`next: ship aso suggest --locale ${out.locale}`));
}

const SCORE = {
	name: 'score',
	run: scoreOne,
	print: printScore,
	ok: (out) => out.count > 0,
	summary: (out) => ({ scored: out.count, top: out.scored[0]?.keyword ?? null, file: out.file }),
};

async function score({ flags }) {
	if (flags['all-locales']) return sweep(flags, SCORE);
	const { cfg, locale, market } = await context(flags);
	const out = await scoreOne(cfg, locale, market, flags);
	if (flags.json) return emit(out.artifact);
	printScore(out);
	return 0;
}

/**
 * The shared suggest/apply computation.
 * `strict` is for apply: suggesting against a missing listing is still useful
 * research, but writing one requires a file to write into.
 */
async function proposal(cfg, locale, { strict = false } = {}) {
	const artifact = await readArtifact(cfg, locale, 'scored');
	const minVolume = Number(cfg.aso.minVolume ?? 0);
	// Packing is the last place demand can still be ignored, and the slots are
	// only 100 characters: a term under minVolume never earns one.
	const scored = scoredTerms(artifact).filter((e) => (e.demand ?? 100) >= minVolume);
	const listing = await listingFor(cfg, locale);
	if (!listing && strict)
		throw new ShipError(`no staged listing for ${locale}`, {
			hint: `create ${join(cfg.paths.staged, `${locale}.json`)} — \`ship meta\` scaffolds it`,
		});
	const data = listing?.data ?? {};
	const alreadyIndexed = `${data.name ?? ''} ${data.subtitle ?? ''}`.trim();

	const packed = packKeywords(scored, { limit: LIMITS.keywords, alreadyIndexed, locale });
	const current = keywordList(data.keywords ?? '');
	const next = packed.keywords ? packed.keywords.split(',') : [];
	const currentLower = new Set(current.map((k) => k.toLocaleLowerCase()));
	const nextLower = new Set(next.map((k) => k.toLocaleLowerCase()));

	return {
		locale,
		listing,
		name: data.name ?? '',
		subtitle: data.subtitle ?? '',
		current: data.keywords ?? '',
		keywords: packed.keywords,
		used: packed.used,
		limit: packed.limit,
		minVolume,
		covered: coveredTerms(scored, alreadyIndexed, locale),
		added: next.filter((k) => !currentLower.has(k.toLocaleLowerCase())),
		removed: current.filter((k) => !nextLower.has(k.toLocaleLowerCase())),
	};
}

function printProposal(p) {
	heading(`Keywords for ${p.locale}`);
	if (p.name || p.subtitle) info(`indexed free via listing: ${c.cyan(`${p.name} — ${p.subtitle}`)}`);
	process.stdout.write(`\n  ${c.bold(p.keywords || c.dim('(empty)'))}\n\n`);
	const slack = p.limit - p.used;
	info(`${p.used}/${p.limit} chars${slack ? c.dim(` — ${slack} unused`) : c.green(' — full')}`);
	if (p.covered.length) info(`dropped, already indexed by name/subtitle: ${c.dim(p.covered.join(', '))}`);
	if (p.added.length) note(`${c.green('+')} ${p.added.join(', ')}`);
	if (p.removed.length) note(`${c.red('-')} ${p.removed.join(', ')}`);
	if (!p.added.length && !p.removed.length) good('identical to the current field');
}

const SUGGEST = {
	name: 'suggest',
	run: (cfg, locale) => proposal(cfg, locale),
	print: printProposal,
	summary: (p) => ({ keywords: p.keywords, used: p.used, limit: p.limit }),
};

async function suggest({ flags }) {
	if (flags['all-locales']) return sweep(flags, SUGGEST);
	const { cfg, locale } = await context(flags);
	const p = await proposal(cfg, locale);
	if (flags.json) return emit({ ...p, listing: p.listing?.file ?? null });
	if (!p.listing) warn(`no staged listing for ${locale} — suggesting against an empty name/subtitle`);
	printProposal(p);
	note(c.dim(`write it: ship aso apply --locale ${locale}`));
	return 0;
}

/**
 * Run one stage over every locale in store.locales.
 * Apple throttles per storefront, so a locale that hits a wall must not cost the
 * others their refresh: failures are collected, never thrown. Every locale
 * failing is not throttling, it is a broken setup, and that exits non-zero.
 */
async function sweep(flags, stage) {
	const cfg = await loadConfig();
	configureCache(cfg, flags);
	const locales = cfg.store.locales?.length ? cfg.store.locales : [sourceLocale(cfg)];
	const results = [];
	let failed = 0;

	for (const locale of locales) {
		const market = marketFor(locale);
		if (!market) {
			failed++;
			warn(`${locale}: no App Store market known — skipped`);
			results.push({ locale, ok: false, error: 'no App Store market' });
			continue;
		}
		try {
			const out = await stage.run(cfg, locale, market, flags);
			const ok = stage.ok ? stage.ok(out) : true;
			if (!ok) failed++;
			results.push({ locale, ok, ...stage.summary(out) });
			if (!flags.json) stage.print(out);
		} catch (err) {
			failed++;
			warn(`${locale}: ${err.message} — keeping the last ${stage.name}`);
			if (err.hint) note(c.dim(err.hint));
			results.push({ locale, ok: false, error: err.message });
		}
	}

	if (flags.json) emit({ stage: stage.name, locales: results });
	else {
		heading(`${stage.name}: ${results.length - failed}/${results.length} locales`);
		for (const r of results) note(r.ok ? c.green(r.locale) : `${c.red(r.locale)} ${c.dim(r.error ?? 'no result')}`);
	}
	return failed && failed === results.length ? 1 : 0;
}

async function apply({ flags }) {
	const { cfg, locale } = await context(flags);
	const p = await proposal(cfg, locale, { strict: true });

	const length = charCount(p.keywords);
	if (length > LIMITS.keywords)
		throw new ShipError(`packed keywords are ${length}/${LIMITS.keywords} chars`, {
			hint: 'refusing to write a field App Store Connect will reject',
		});

	if (flags.json) return emit({ ...p, listing: p.listing.file, written: !isDryRun() });
	printProposal(p);

	if (p.current === p.keywords) {
		good(`${p.listing.file} already has this field`);
		return 0;
	}
	step(`${p.listing.file}`);
	note(`${c.red('before')} ${p.current || c.dim('(empty)')}`);
	note(`${c.green('after ')} ${p.keywords}`);
	if (isDryRun()) {
		warn('dry run — nothing written');
		return 0;
	}
	// Re-read and mutate the raw object: the file carries authored keys
	// (notes, per-locale URL overrides) that no model of ours round-trips.
	const raw = JSON.parse(await readFile(p.listing.file, 'utf8'));
	raw.keywords = p.keywords;
	await writeFile(p.listing.file, `${JSON.stringify(raw, null, '\t')}\n`);
	good(`wrote keywords for ${locale}`);
	return 0;
}

async function competitors({ flags }) {
	const { cfg, locale, market } = await context(flags);

	let ids = String(flags.ids ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!ids.length) {
		const scored = scoredTerms(await readArtifact(cfg, locale, 'scored'));
		const seen = new Set();
		for (const s of scored) {
			for (const t of s.top3 ?? []) if (t.id) seen.add(String(t.id));
			if (seen.size >= 3) break;
		}
		ids = [...seen].slice(0, 3);
	}
	if (!ids.length)
		throw new ShipError('no competitor ids', { hint: 'pass --ids 123,456 or run `ship aso score` first' });

	const apps = await lookup(ids, { country: market.country });
	// The lookup endpoint has no subtitle field, so the marketing subtitle only
	// shows up as the tail of trackName ("Glovebox: Car Maintenance Log").
	const freq = new Map();
	for (const a of apps)
		for (const w of indexedWords(`${a.trackName ?? ''} ${a.subtitle ?? ''}`, locale))
			freq.set(w, (freq.get(w) ?? 0) + 1);
	const vocabulary = [...freq]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([word, count]) => ({ word, apps: count }));

	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		market,
		ids,
		apps: apps.map((a) => ({
			id: a.trackId,
			name: a.trackName,
			seller: a.sellerName,
			ratings: a.userRatingCount ?? 0,
			stars: a.averageUserRating,
			price: a.price ?? 0,
			genre: a.primaryGenreName,
		})),
		vocabulary,
	};
	const file = await writeArtifact(cfg, locale, 'competitors', artifact);
	if (flags.json) return emit(artifact);

	heading(`Competitors ${locale} ${c.dim(`(${market.country})`)}`);
	if (!apps.length) {
		warn(`lookup returned nothing for ${ids.join(', ')}`);
		return 1;
	}
	table(artifact.apps, [
		{ header: 'app', get: (a) => a.name ?? '' },
		{ header: 'seller', get: (a) => a.seller ?? '' },
		{ header: 'ratings', get: (a) => String(a.ratings) },
		{ header: 'price', get: (a) => (a.price ? `$${a.price}` : 'free') },
		{ header: 'genre', get: (a) => a.genre ?? '' },
	]);
	heading('Vocabulary they buy');
	for (const v of vocabulary.slice(0, 25)) note(`${c.cyan(String(v.apps))}× ${v.word}`);
	good(`→ ${c.dim(file)}`);
	return 0;
}

/** asc payloads nest their rows differently per subcommand; take the first array we find. */
function rowsOf(payload) {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== 'object') return [];
	for (const key of ['data', 'items', 'results', 'tags', 'findings', 'issues', 'keywords', 'localizations'])
		if (Array.isArray(payload[key])) return payload[key];
	for (const v of Object.values(payload)) if (Array.isArray(v)) return v;
	return [];
}

const LEVELS = { error: 'fail', fail: 'fail', failed: 'fail', critical: 'fail', warning: 'warn', warn: 'warn' };

async function audit({ flags }) {
	const { cfg, locale } = await context(flags);
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, flags.version);
	const report = new Report(`ASO audit — ${cfg.name} ${version}`);

	// Apple derives discoverability tags from the binary and the listing; they
	// are the only view we get of how the App Store itself categorises the app.
	const tags = await asc(['app-tags', 'list', '--app', appId], { fallback: null }).catch(() => null);
	const tagRows = rowsOf(tags);
	const tagNames = tagRows.map((t) => t.name ?? t.displayName ?? t.attributes?.name ?? t.id).filter(Boolean);
	if (tagNames.length) report.ok('app tags', tagNames.join(', '));
	else if (tags) report.warn('app tags', 'Apple has generated none yet — the listing is too thin or too new');
	else report.skip('app tags', 'asc app-tags list failed');

	const kw = await asc(['metadata', 'keywords', 'audit', '--app', appId, '--version', version], {
		fallback: null,
	}).catch(() => null);
	const kwRows = rowsOf(kw);
	if (!kw) report.skip('asc keyword audit', `no result for version ${version}`);
	else if (!kwRows.length) report.ok('asc keyword audit', 'no findings');
	else
		for (const row of kwRows) {
			const level = LEVELS[String(row.level ?? row.severity ?? row.status ?? '').toLocaleLowerCase()] ?? 'warn';
			const name = `asc ${row.locale ?? row.field ?? 'keywords'}`;
			const detail = row.message ?? row.detail ?? row.description ?? JSON.stringify(row);
			report[level](name, detail);
		}

	// Offline lint is the gate that actually blocks: it runs without network and
	// catches the two rejections we keep earning — over-limit and ", " padding.
	const staged = await readStaged(cfg);
	if (!staged.length) report.warn('staged listings', `none under ${cfg.paths.staged}`);
	for (const listing of staged) {
		const problems = lintListing(listing).filter((p) => p.field === 'keywords');
		if (!problems.length) {
			report.ok(`keywords ${listing.locale}`, `${charCount(listing.data.keywords ?? '')}/${LIMITS.keywords} chars`);
			continue;
		}
		for (const p of problems) report[p.level](`keywords ${p.locale}`, p.message);
	}

	report.print({ json: flags.json });
	if (!flags.json && !existsSync(artifactPath(cfg, locale, 'scored')))
		note(c.dim(`no research yet: ship aso harvest --locale ${locale}`));
	return report.code;
}

const SUB = { harvest, volume, score, suggest, apply, competitors, audit };

export async function run({ args, flags }) {
	const [sub = 'harvest', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`aso: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}
