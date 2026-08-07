// ASO — keyword research against the live App Store, then into the listing.
//
// Everything here is a pipeline over files, because the research half is slow
// (Apple throttles autocomplete to roughly one request per second and answers
// a burst with 403s) and the authoring half must stay reviewable in git.
// Each stage writes its artifact under aso/<locale>/ and the next stage reads
// it, so a rate-limit wall costs you one stage, never the whole session.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, loadConfig, requireAppId, resolveVersion } from '../config.mjs';
import { asc, isDryRun } from '../exec.mjs';
import { Report, ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import {
	harvest as harvestTerms,
	lookup,
	marketFor,
	packKeywords,
	pickCandidates,
	progressLine,
	scoreAll,
} from '../lib/appstore.mjs';
import { keywordList, lintListing, readStaged } from '../lib/locales.mjs';

export const help = `
${c.bold('ship aso')} ${c.dim('— App Store keyword research and packing')}

${c.dim('usage:')} ship aso [subcommand] [flags]

  ${c.cyan('harvest')}      ${c.dim('default')} sweep App Store autocomplete for candidate queries
  ${c.cyan('score')}        score candidates against their live top-10 competition
  ${c.cyan('suggest')}      pack the best terms into a 100-char field ${c.dim('(prints only)')}
  ${c.cyan('apply')}        write that field into store/staged/<locale>.json
  ${c.cyan('competitors')}  profile competing apps and the vocabulary they buy
  ${c.cyan('audit')}        Apple's discoverability tags + keyword audit + offline lint

${c.bold('Flags')}
  ${c.cyan('--locale <l>')}    locale to work on ${c.dim('(default: asc.primaryLocale)')}
  ${c.cyan('--seeds "a,b"')}   harvest seeds ${c.dim('(default: aso.seeds, else the staged name + subtitle)')}
  ${c.cyan('--limit <n>')}     score at most n candidates, shortest first ${c.dim('(default 120)')}
  ${c.cyan('--words <n>')}     max words per candidate ${c.dim('(default 4)')}
  ${c.cyan('--ids 123,456')}   competitor App Store ids ${c.dim('(default: top 3 from scored.json)')}
  ${c.cyan('--version <v>')}   ASC version for ${c.cyan('audit')} ${c.dim('(default: app.json)')}
  ${c.cyan('--json')}          emit the underlying artifact

${c.dim('Artifacts: aso/<locale>/{candidates,scored,competitors}.json')}
${c.dim('Order: harvest → score → suggest → apply')}
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

/** Config + the locale/market pair every subcommand operates on. */
async function context(flags) {
	const cfg = await loadConfig();
	const locale = String(flags.locale ?? cfg.asc.primaryLocale);
	const market = marketFor(locale);
	if (!market)
		throw new ShipError(`no App Store market known for locale "${locale}"`, {
			hint: 'add it to LOCALE_MARKETS in src/lib/appstore.mjs, or pass a supported --locale',
		});
	return { cfg, locale, market };
}

/** Progress belongs on stdout, which --json owns exclusively. */
const reporter = (flags) => (flags.json ? undefined : progressLine);

const listingFor = async (cfg, locale) => (await readStaged(cfg)).find((s) => s.locale === locale) ?? null;

/** Words Apple already indexes from name + subtitle; spending keyword slots on them is waste. */
function indexedWords(text) {
	return new Set(
		String(text)
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 2),
	);
}

/** Scored terms whose every word is already covered by name/subtitle. */
function coveredTerms(scored, alreadyIndexed) {
	const indexed = indexedWords(alreadyIndexed);
	if (!indexed.size) return [];
	return scored
		.map((e) => (typeof e === 'string' ? e : e.keyword))
		.filter((t) => t.split(/\s+/).every((w) => indexed.has(w.toLocaleLowerCase())));
}

async function harvest({ flags }) {
	const { cfg, locale, market } = await context(flags);

	let seeds = String(flags.seeds ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	let origin = '--seeds';
	if (!seeds.length && cfg.aso.seeds?.length) {
		seeds = [...cfg.aso.seeds];
		origin = `aso.seeds in ${cfg.file}`;
	}
	if (!seeds.length) {
		// Last resort: the listing itself. Words of 3 chars or fewer are stop
		// words in every market we support and return junk from autocomplete.
		const listing = await listingFor(cfg, locale);
		const words = `${listing?.data.name ?? ''} ${listing?.data.subtitle ?? ''}`
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 3);
		seeds = [...new Set(words)];
		origin = listing ? `staged ${locale} name + subtitle` : 'nothing';
	}
	if (!seeds.length)
		throw new ShipError('no harvest seeds', {
			hint: `pass --seeds "car maintenance,service log", or set aso.seeds in ${cfg.file}`,
		});

	if (!flags.json) {
		heading(`Harvest ${locale} ${c.dim(`(${market.country})`)}`);
		info(`${seeds.length} seed${seeds.length === 1 ? '' : 's'} from ${origin}: ${c.cyan(seeds.join(', '))}`);
	}

	const terms = await harvestTerms(seeds, market.country, { onProgress: reporter(flags) });
	const artifact = {
		generatedAt: new Date().toISOString(),
		locale,
		market,
		seeds,
		terms,
	};
	const file = await writeArtifact(cfg, locale, 'candidates', artifact);
	if (flags.json) return emit(artifact);

	const names = Object.keys(terms);
	good(`${names.length} candidate terms → ${c.dim(file)}`);
	for (const term of names.slice(0, 15)) note(`${term} ${c.dim(`← ${terms[term].join(', ')}`)}`);
	if (names.length > 15) note(c.dim(`… ${names.length - 15} more`));
	if (!names.length) warn('autocomplete returned nothing — Apple may be throttling; retry in a minute');
	note(c.dim(`next: ship aso score --locale ${locale}`));
	return names.length ? 0 : 1;
}

async function score({ flags }) {
	const { cfg, locale, market } = await context(flags);
	const candidates = await readArtifact(cfg, locale, 'candidates');

	const maxWords = Number(flags.words ?? 4);
	const limit = Number(flags.limit ?? 120);
	const picked = pickCandidates(Object.keys(candidates.terms ?? {}), { maxWords });
	const terms = [...picked].sort(byLength).slice(0, limit);
	if (!terms.length)
		throw new ShipError(`no scorable candidates for ${locale}`, {
			hint: `harvest returned ${Object.keys(candidates.terms ?? {}).length} terms; widen with --words`,
		});

	if (!flags.json) {
		heading(`Score ${locale} ${c.dim(`(${market.country})`)}`);
		info(`${terms.length} of ${picked.length} candidates, ~1s each → ${c.dim(`${Math.ceil(terms.length / 60)} min`)}`);
	}

	const scored = await scoreAll(terms, candidates.market ?? market, { onProgress: reporter(flags) });
	const artifact = { generatedAt: new Date().toISOString(), locale, scored };
	const file = await writeArtifact(cfg, locale, 'scored', artifact);
	if (flags.json) return emit(artifact);

	heading(`Top ${Math.min(20, scored.length)} of ${scored.length}`);
	table(scored.slice(0, 20), [
		{ header: 'keyword', get: (s) => s.keyword },
		{ header: 'opp', get: (s) => String(s.opportunity) },
		{ header: 'medRatings', get: (s) => String(s.medianRatings) },
		{ header: 'weak/10', get: (s) => String(s.weakAppsTop10) },
		{ header: 'exact', get: (s) => String(s.exactTitleMatches) },
		{ header: 'top competitor', get: (s) => s.top3[0]?.name ?? '' },
	]);
	good(`scored ${scored.length} terms → ${c.dim(file)}`);
	note(c.dim(`next: ship aso suggest --locale ${locale}`));
	return 0;
}

/**
 * The shared suggest/apply computation.
 * `strict` is for apply: suggesting against a missing listing is still useful
 * research, but writing one requires a file to write into.
 */
async function proposal(cfg, locale, { strict = false } = {}) {
	const { scored = [] } = await readArtifact(cfg, locale, 'scored');
	const listing = await listingFor(cfg, locale);
	if (!listing && strict)
		throw new ShipError(`no staged listing for ${locale}`, {
			hint: `create ${join(cfg.paths.staged, `${locale}.json`)} — \`ship meta\` scaffolds it`,
		});
	const data = listing?.data ?? {};
	const alreadyIndexed = `${data.name ?? ''} ${data.subtitle ?? ''}`.trim();

	const packed = packKeywords(scored, { limit: LIMITS.keywords, alreadyIndexed });
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
		covered: coveredTerms(scored, alreadyIndexed),
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

async function suggest({ flags }) {
	const { cfg, locale } = await context(flags);
	const p = await proposal(cfg, locale);
	if (flags.json) return emit({ ...p, listing: p.listing?.file ?? null });
	if (!p.listing) warn(`no staged listing for ${locale} — suggesting against an empty name/subtitle`);
	printProposal(p);
	note(c.dim(`write it: ship aso apply --locale ${locale}`));
	return 0;
}

async function apply({ flags }) {
	const { cfg, locale } = await context(flags);
	const p = await proposal(cfg, locale, { strict: true });

	const length = [...p.keywords].length;
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

/** Words in the phrase, minus the connective tissue that every listing contains. */
const VOCAB_STOP = new Set(['and', 'the', 'for', 'with', 'your', 'app', 'you', 'all', 'from', 'that', 'into']);

async function competitors({ flags }) {
	const { cfg, locale, market } = await context(flags);

	let ids = String(flags.ids ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!ids.length) {
		const { scored = [] } = await readArtifact(cfg, locale, 'scored');
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
	for (const a of apps) {
		const words = `${a.trackName ?? ''} ${a.subtitle ?? ''}`
			.toLocaleLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((w) => w.length > 2 && !VOCAB_STOP.has(w));
		for (const w of new Set(words)) freq.set(w, (freq.get(w) ?? 0) + 1);
	}
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
			const len = [...String(listing.data.keywords ?? '')].length;
			report.ok(`keywords ${listing.locale}`, `${len}/${LIMITS.keywords} chars`);
			continue;
		}
		for (const p of problems) report[p.level](`keywords ${p.locale}`, p.message);
	}

	report.print({ json: flags.json });
	if (!flags.json && !existsSync(artifactPath(cfg, locale, 'scored')))
		note(c.dim(`no research yet: ship aso harvest --locale ${locale}`));
	return report.code;
}

const SUB = { harvest, score, suggest, apply, competitors, audit };

export async function run({ args, flags }) {
	const [sub = 'harvest', ...rest] = args;
	const fn = SUB[sub];
	if (!fn)
		throw new ShipError(`aso: unknown subcommand "${sub}"`, { hint: `try: ${Object.keys(SUB).join(', ')}` });
	return fn({ args: rest, flags });
}
