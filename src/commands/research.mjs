// ship research — the evidence engine's front door.
// Shipkit fetches what is fetchable and gates what the agent writes; the
// reading of screens and reviews in between is the only agent work.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, note, step, table, warn } from '../log.mjs';
import { marketFor } from '../lib/appstore.mjs';
import { throttledFetch, useCache } from '../lib/appstore-client.mjs';
import { readJSONIfExists, readJSONOrNull, writeJSON } from '../lib/jsonio.mjs';
import { buildPlan, resolveFlows, slugFor } from '../lib/research-plan.mjs';
import { draftReference, fetchApp, imageFacts } from '../lib/research-fetch.mjs';
import { buildIndex } from '../lib/research-index.mjs';
import { loadRun, resolveSlug, reviewPagesUsed } from '../lib/research-run.mjs';
import { checkBudget, checkClaims, checkReferences, checkThemes, indexReviews } from '../lib/research-verify.mjs';
import { assertArtifact, checkArtifact } from '../lib/schemas.mjs';
import { resolveSubcommand, strOf } from '../lib/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../lib/util.mjs').SubCtx} SubCtx */

export const help = `
${c.bold('ship research')} ${c.dim('— competitor evidence from the public App Store storefront')}

  ${c.cyan('plan')}      pick the apps and flows, and fix the fetch budget
  ${c.cyan('fetch')}     download metadata, full-res screenshots and reviews
  ${c.cyan('capture')}   ingest your own device screenshots as references
  ${c.cyan('verify')}    gate the agent's half: schema, citations, hashes, budget
  ${c.cyan('index')}     rank the references and join review velocity

${c.bold('Flags')}
  ${c.cyan('--flows a,b')}  flows to research (default: research.flows, else the standard six)
  ${c.cyan('--apps n')}     research fewer apps than the budget allows
  ${c.cyan('--locale')}     which storefront's competitor set to read (default: asc.primaryLocale)
  ${c.cyan('--name')}       name this run, when one date holds more than one
  ${c.cyan('--slug')}       act on a run other than the newest
  ${c.cyan('--refresh')}    re-fetch apps this run already holds
  ${c.cyan('--app')}        capture: the app the screenshots came from
  ${c.cyan('--json')}       print the artifact instead of a table

${c.dim('Artifacts: research/<slug>/{plan,index}.json · references/ · reviews/ · assets/')}
${c.dim('Credential-free: the storefront is public, like `ship scout`.')}
`;

/**
 * The competitor set `ship aso competitors` wrote for this storefront.
 * @type {(cfg: Config, locale: string) => Promise<{file: string, apps: any[]}>}
 */
async function competitorSet(cfg, locale) {
	const file = join(cfg.paths.aso, locale, 'competitors.json');
	const artifact = await readJSONIfExists(file);
	if (!artifact) {
		throw new ShipError(`research plan: no competitor set for ${locale}`, {
			hint: `run \`ship aso competitors --locale ${locale}\` first (expected ${file})`,
		});
	}
	const apps = /** @type {any} */ (artifact).apps;
	return { file, apps: Array.isArray(apps) ? apps : [] };
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function plan({ flags }) {
	const cfg = await loadConfig();
	const locale = strOf(flags.locale) ?? cfg.asc.primaryLocale;
	const market = marketFor(locale);
	if (!market) throw new ShipError(`research plan: no storefront for locale "${locale}"`);

	const { file, apps } = await competitorSet(cfg, locale);
	const flows = resolveFlows(cfg.research.flows, strOf(flags.flows));
	// Optional on purpose: research is how a brief gets its themes, so demanding
	// a finished brief first would close the loop before it opens.
	const brief = await readJSONIfExists(join(cfg.paths.product, 'brief.json'));
	const now = new Date().toISOString();
	const slug = slugFor(now, strOf(flags.name));
	const doc = buildPlan({
		cfg,
		competitors: apps,
		flows,
		slug,
		country: market.country,
		apps: flags.apps === undefined ? undefined : Number(flags.apps),
		brief,
		now,
	});

	// The gate runs on the way out, not only in `verify`: a plan that cannot
	// satisfy its own schema would fail every later step with a worse message.
	await assertArtifact('research-plan', doc, `${slug}/plan.json`);
	const out = await writeJSON(join(cfg.paths.research, slug, 'plan.json'), /** @type {any} */ (doc));
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(doc, null, '\t')}\n`);
		return 0;
	}

	heading(`research plan · ${slug}`);
	note(`competitor set: ${file}`);
	step(`flows: ${doc.flows.join(', ')}`);
	table(doc.apps, [
		{ header: '#', get: (a) => a.rank },
		{ header: 'app', get: (a) => a.name },
		{ header: 'id', get: (a) => a.trackId },
		{ header: 'evidence', get: (a) => a.why },
	]);
	const { requests } = doc.budget;
	step(`budget: ${requests.total} requests — ${requests.lookup} lookup, ${requests.screenshots} screenshots, ${requests.reviews} review pages`);
	good(`wrote ${out}`);
	note('next: ship research fetch');
	return 0;
}

/**
 * The real network side of `fetch`, kept behind the same two-function interface
 * the tests hand `fetchApp` a fixture through.
 * @type {(country: string) => import('../lib/research-fetch.mjs').FetchIO}
 */
const storefrontIO = (country) => ({
	async json(url) {
		const body = await throttledFetch(url, { country, endpoint: 'research', term: url });
		if (typeof body !== 'string') return null;
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	},
	bytes: (url) => throttledFetch(url, { country, bytes: true }),
});

/**
 * Write one app's haul. Assets first: a reference is only true once its image exists.
 * @type {(dir: string, haul: Awaited<ReturnType<typeof fetchApp>>) => Promise<void>}
 */
async function writeApp(dir, haul) {
	await mkdir(join(dir, 'assets'), { recursive: true });
	for (const asset of haul.assets) await writeFile(join(dir, asset.path), asset.buffer);
	for (const ref of haul.references) await writeJSON(join(dir, 'references', `${ref.id}.json`), ref);
	if (haul.corpus.count) await writeJSON(join(dir, 'reviews', `${haul.corpus.trackId}.json`), haul.corpus);
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function fetchRun({ flags }) {
	const cfg = await loadConfig();
	const slug = await resolveSlug(cfg.paths.research, strOf(flags.slug));
	const run = await loadRun(cfg.paths.research, slug);
	const { plan: doc } = run;
	// Same disk cache `ship aso` uses: a run interrupted halfway does not pay
	// Apple twice for the pages it already has.
	useCache({ dir: join(cfg.paths.root, '.cache', 'storefront'), mode: flags.refresh ? 'refresh' : 'on' });
	const io = storefrontIO(doc.country);
	const capturedAt = new Date().toISOString();
	const held = new Set(run.references.map((r) => r?.app?.trackId));

	heading(`research fetch · ${slug}`);
	const rows = [];
	let requests = 0;
	for (const app of doc.apps) {
		if (held.has(app.trackId) && !flags.refresh) {
			rows.push({ app: app.name, screens: '—', reviews: '—', note: 'held' });
			continue;
		}
		const haul = await fetchApp(app, {
			country: doc.country,
			screensPerApp: doc.budget.screensPerApp,
			reviewPages: doc.budget.reviewPages,
			sorts: doc.sorts,
			capturedAt,
		}, io);
		await writeApp(run.dir, haul);
		requests += haul.requests;
		for (const url of haul.skipped) warn(`no image: ${url}`);
		rows.push({ app: haul.app.name, screens: haul.references.length, reviews: haul.corpus.count, note: '' });
	}

	table(rows, [
		{ header: 'app', get: (r) => r.app },
		{ header: 'screens', get: (r) => r.screens },
		{ header: 'reviews', get: (r) => r.reviews },
		{ header: '', get: (r) => c.dim(r.note) },
	]);
	step(`${requests} requests of the planned ${doc.budget.requests.total}`);
	good(`wrote ${run.dir}`);
	note('next: read the screens, fill each reference, then ship research verify');
	return 0;
}

const IMAGES = new Set(['.png', '.jpg', '.jpeg']);

/** @type {(ctx: SubCtx) => Promise<number>} */
async function capture({ args, flags }) {
	const from = args[0];
	if (!from) throw new ShipError('research capture: no directory', { hint: 'ship research capture ./device-shots' });
	const src = resolve(from);
	if (!existsSync(src)) throw new ShipError(`research capture: ${src} does not exist`);
	const cfg = await loadConfig();
	const slug = await resolveSlug(cfg.paths.research, strOf(flags.slug));
	const run = await loadRun(cfg.paths.research, slug);
	const name = strOf(flags.app) ?? basename(src);
	const capturedAt = new Date().toISOString();

	const files = (await readdir(src)).filter((f) => IMAGES.has(extname(f).toLowerCase())).sort();
	if (!files.length) throw new ShipError(`research capture: no png or jpg files in ${src}`);
	await mkdir(join(run.dir, 'assets'), { recursive: true });

	heading(`research capture · ${slug}`);
	const written = [];
	for (const file of files) {
		const buffer = await readFile(join(src, file));
		// providerId is the source filename, so re-running the same capture
		// directory overwrites its own references instead of doubling them.
		const providerId = `${name}#${file}`;
		const ref = draftReference({
			provider: 'manual',
			providerId,
			app: { name },
			// A capture directory is a journey you recorded, so file order is
			// the ordering — but it is yours, not a developer's ranking of what
			// matters, so it is not a marketing-shot position.
			position: null,
			sourceUrl: `file://${join(src, file)}`,
			capturedAt,
			image: /** @type {any} */ (null),
		});
		const facts = imageFacts(buffer, `assets/${ref.id}.png`);
		if (!facts) {
			warn(`unreadable image: ${file}`);
			continue;
		}
		ref.image = facts;
		await writeFile(join(run.dir, facts.path), buffer);
		await writeJSON(join(run.dir, 'references', `${ref.id}.json`), ref);
		written.push({ file, id: ref.id });
	}
	table(written, [
		{ header: 'file', get: (r) => r.file },
		{ header: 'reference', get: (r) => r.id },
	]);
	good(`${written.length} reference(s) into ${run.dir}`);
	note('next: flow-tag each one, then ship research verify');
	return 0;
}

/**
 * Schema issues for every artifact a run holds, named by the file they came from.
 * @type {(run: import('../lib/research-run.mjs').Run) => Promise<string[]>}
 */
async function schemaIssues(run) {
	const issues = [];
	for (const ref of run.references)
		issues.push(...(await checkArtifact('research-reference', ref, `references/${ref?.id ?? '?'}.json`)));
	for (const corpus of run.corpora)
		issues.push(...(await checkArtifact('research-reviews', corpus, `reviews/${corpus?.trackId ?? '?'}.json`)));
	if (run.themes) issues.push(...(await checkArtifact('research-themes', run.themes, 'themes.json')));
	if (run.patterns) issues.push(...(await checkArtifact('research-patterns', run.patterns, 'patterns.json')));
	return issues;
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function verify({ flags }) {
	const cfg = await loadConfig();
	const slug = await resolveSlug(cfg.paths.research, strOf(flags.slug));
	const run = await loadRun(cfg.paths.research, slug);
	const { byId, appMeans } = indexReviews(run.corpora);

	const issues = [
		...(await checkArtifact('research-plan', run.plan, 'plan.json')),
		...(await schemaIssues(run)),
		...checkReferences(run.references, run.hashes, run.plan),
		...checkThemes(run.themes, byId, appMeans),
		...checkClaims(run.patterns, run.references),
		...checkBudget(run.plan, {
			apps: new Set(run.references.map((r) => r?.app?.trackId)).size,
			references: run.references.length,
			reviewPages: reviewPagesUsed(run.corpora),
		}),
	];

	heading(`research verify · ${slug}`);
	if (!run.references.length) issues.push('references/ is empty — run `ship research fetch` first');
	if (issues.length) {
		for (const issue of issues) note(c.red(issue));
		throw new ShipError(`research verify: ${issues.length} issue(s) in ${slug}`, {
			hint: 'every reference needs a flow, observations and a non-empty doNotCopy',
		});
	}
	step(`${run.references.length} references · ${run.corpora.length} review corpora · ${(run.themes?.themes ?? []).length} themes · ${(run.patterns?.claims ?? []).length} claims`);
	good('every claim cited, every hash matched, budget respected');
	note('next: ship research index');
	return 0;
}

/**
 * The run before this one, which is the only thing that can date a velocity.
 * @type {(researchDir: string, slug: string) => Promise<any>}
 */
async function previousIndex(researchDir, slug) {
	if (!existsSync(researchDir)) return null;
	const prior = (await readdir(researchDir, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && e.name < slug)
		.map((e) => e.name)
		.sort()
		.at(-1);
	return prior ? await readJSONOrNull(join(researchDir, prior, 'index.json')) : null;
}

/** @type {(ctx: SubCtx) => Promise<number>} */
async function index({ flags }) {
	const cfg = await loadConfig();
	const slug = await resolveSlug(cfg.paths.research, strOf(flags.slug));
	const run = await loadRun(cfg.paths.research, slug);
	const doc = buildIndex({
		plan: run.plan,
		references: run.references,
		corpora: run.corpora,
		themes: run.themes,
		patterns: run.patterns,
		previous: await previousIndex(cfg.paths.research, slug),
	});
	const out = await writeJSON(join(run.dir, 'index.json'), doc);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(doc, null, '\t')}\n`);
		return 0;
	}

	heading(`research index · ${slug}`);
	table(doc.apps, [
		{ header: 'app', get: (a) => a.name },
		{ header: 'weight', get: (a) => a.weight },
		{ header: 'refs', get: (a) => a.references },
		{ header: 'reviews', get: (a) => a.reviews },
		{ header: 'ratings/day', get: (a) => a.ratingVelocity ?? c.dim('first run') },
	]);
	const thin = Object.entries(doc.coverage).filter(([, v]) => !v.references);
	if (thin.length) warn(`no references yet for: ${thin.map(([f]) => f).join(', ')}`);
	step(`${doc.claims.evidence} evidence claim(s), ${doc.claims.hypothesis} hypothesis`);
	good(`wrote ${out}`);
	return 0;
}

const SUB = { plan, fetch: fetchRun, capture, verify, index };

/** @type {(ctx: SubCtx) => Promise<number>} */
export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'research', args, subs: SUB, fallback: 'plan' });
	return fn({ args: rest, flags });
}
