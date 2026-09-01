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
// The scoring, seed resolution, findings and stage renderings those artifacts
// feed live in lib/aso-report.mjs; this file is the pipeline: artifacts, ASC
// calls, stages.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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
	pickCandidates,
	scoreAll,
	useCache,
} from '../lib/appstore.mjs';
import { rowsOf } from '../lib/asc-report.mjs';
import { readJSONIfExists, writeJSON } from '../lib/jsonio.mjs';
import { emit } from '../lib/output.mjs';
import { resolveSubcommand } from '../lib/util.mjs';
import { charCount } from '../lib/text.mjs';
import { readStaged } from '../lib/locales.mjs';
import {
	announceSeeds,
	auditFindings,
	byLength,
	competitorRows,
	competitorVocabulary,
	keywordLintFindings,
	mergeDemands,
	normaliseVolume,
	packedProposal,
	printCompetitors,
	printHarvest,
	printProposal,
	printScore,
	printVolume,
	reporter,
	scoredTerms,
	seedsFor,
	sourceLocale,
	tagNames,
	topCompetitorIds,
	VOLUME_TEMPLATE,
} from '../lib/aso-report.mjs';

// The volume importer is pure payload handling; the test suite pins it from here.
export { normaliseVolume } from '../lib/aso-report.mjs';

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

const artifactPath = (cfg, locale, kind) => join(cfg.paths.aso, locale, `${kind}.json`);

const writeArtifact = (cfg, locale, kind, data) => writeJSON(artifactPath(cfg, locale, kind), data);

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
	// The shared reader's bad-JSON error is this command's word for word; only
	// the missing-file case needs the stage-aware message above.
	return readJSONIfExists(file);
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

const listingFor = async (cfg, locale) => (await readStaged(cfg)).find((s) => s.locale === locale) ?? null;

async function harvestOne(cfg, locale, market, flags) {
	const { seeds, origin, mismatch } = await seedsFor(cfg, locale, flags, listingFor);
	if (!seeds.length)
		throw new ShipError(`no harvest seeds for ${locale}`, {
			hint: `pass --seeds "car maintenance,service log", or set aso.seedsByLocale.${locale} in ${cfg.file}`,
		});

	announceSeeds(cfg, { locale, market, seeds, origin, mismatch, json: flags.json });

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
	mergeDemands(scored, demands);
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
	return { listing, ...packedProposal(scored, listing?.data ?? {}, locale, minVolume) };
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
	if (!ids.length) ids = topCompetitorIds(scoredTerms(await readArtifact(cfg, locale, 'scored')));
	if (!ids.length)
		throw new ShipError('no competitor ids', { hint: 'pass --ids 123,456 or run `ship aso score` first' });

	const apps = await lookup(ids, { country: market.country });
	const vocabulary = competitorVocabulary(apps, locale);

	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		market,
		ids,
		apps: competitorRows(apps),
		vocabulary,
	};
	const file = await writeArtifact(cfg, locale, 'competitors', artifact);
	if (flags.json) return emit(artifact);
	return printCompetitors({ locale, market, ids, apps: artifact.apps, vocabulary, file });
}

async function audit({ flags }) {
	const { cfg, locale } = await context(flags);
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, flags.version);
	const report = new Report(`ASO audit — ${cfg.name} ${version}`);

	// Apple derives discoverability tags from the binary and the listing; they
	// are the only view we get of how the App Store itself categorises the app.
	const tags = await asc(['app-tags', 'list', '--app', appId], { fallback: null }).catch(() => null);
	const names = tagNames(rowsOf(tags, { allowSingle: false }));
	if (names.length) report.ok('app tags', names.join(', '));
	else if (tags) report.warn('app tags', 'Apple has generated none yet — the listing is too thin or too new');
	else report.skip('app tags', 'asc app-tags list failed');

	const kw = await asc(['metadata', 'keywords', 'audit', '--app', appId, '--version', version], {
		fallback: null,
	}).catch(() => null);
	const kwRows = rowsOf(kw, { allowSingle: false });
	if (!kw) report.skip('asc keyword audit', `no result for version ${version}`);
	else if (!kwRows.length) report.ok('asc keyword audit', 'no findings');
	else for (const f of auditFindings(kwRows)) report[f.level](f.name, f.detail);

	// Offline lint is the gate that actually blocks: it runs without network and
	// catches the two rejections we keep earning — over-limit and ", " padding.
	const staged = await readStaged(cfg);
	if (!staged.length) report.warn('staged listings', `none under ${cfg.paths.staged}`);
	for (const f of keywordLintFindings(staged)) report[f.level](f.name, f.detail);

	report.print({ json: flags.json });
	if (!flags.json && !existsSync(artifactPath(cfg, locale, 'scored')))
		note(c.dim(`no research yet: ship aso harvest --locale ${locale}`));
	return report.code;
}

const SUB = { harvest, volume, score, suggest, apply, competitors, audit };

export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'aso', args, subs: SUB, fallback: 'harvest' });
	return fn({ args: rest, flags });
}
