// Custom product pages — the listing an ad lands on, one per keyword intent.
//
// Three operational facts shape this model:
//
//  1. A CPP overrides exactly three things: screenshots, app previews and
//     promotional text. Name, subtitle, keywords and description are the main
//     listing's and cannot vary per page. So the authored file carries `name`
//     (the internal page name, what the Apple Ads picker shows) and an optional
//     `description` for the copywriter, but only `promotionalText` is a field
//     App Store Connect will accept.
//  2. ASC nests the copy three levels deep — page → version → localization —
//     and every write needs the id of the level above it. None of those ids are
//     derivable from a slug, so `apply` re-resolves the chain by name each run
//     rather than caching ids that a deletion in the web UI would invalidate.
//  3. Apple Ads does not reference the ASC page id. It exposes its own
//     `/v5/apps/{adamId}/product-pages` list, so `ship ads sync` matches the
//     page by *name*. Keep the name stable; it is the join key across two APIs.
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// jscpd:ignore-start — import blocks are boilerplate, not copied logic.
import { LIMITS, loadConfig, optionalAppId, requireAppId, resolveVersion } from '../config.mjs';
import { asc, ascMutate, isDryRun } from '../exec.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { emit } from './output.mjs';
import { readJSONIfExists } from './jsonio.mjs';
import { rowsOf } from './asc-report.mjs';
import { strOf } from './util.mjs';
import { charCount } from './text.mjs';
import { requireApplyableState, stderrTail, stateOf } from './listing-sync.mjs';
// jscpd:ignore-end
import {
	cppDir,
	cppRoot,
	generatedDir,
	lintPage,
	readPage,
	readPages,
	screenshotDir,
	slugify,
	stagePage,
	writeMeta,
} from './cpp.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */
/** @typedef {import('./util.mjs').Flags} Flags */
/** @typedef {import('./util.mjs').SubCtx} SubCtx */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./cpp.mjs').CppEntry} CppEntry */
/** @typedef {import('./cpp.mjs').CppProblem} CppProblem */

/**
 * View any JSON value as a row: objects pass through untouched, anything else
 * reads as an empty row — exactly what property access on a scalar would have
 * yielded.
 *
 * @param {Json|undefined} v
 * @returns {JsonObject}
 */
const asRow = (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});

/** @param {Json|undefined} o @param {string} key @returns {Json|null} */
const attr = (o, key) => {
	const row = asRow(o);
	return row[key] ?? asRow(row.attributes)[key] ?? null;
};
/** @param {Json|undefined} payload @returns {Json|null} */
const first = (payload) => rowsOf(payload)[0] ?? null;
/** @param {Json|undefined} o @returns {string|null} */
const idOf = (o) => {
	const id = asRow(o).id ?? attr(o, 'id');
	return id == null ? null : String(id);
};

/** Directory names under a screenshotDir are display types, exactly as `ship shots` lays them out. */
/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function deviceDirs(dir) {
	if (!existsSync(dir)) return [];
	return (await readdir(dir, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * @param {CppEntry} entry
 * @param {CppProblem[]} problems
 * @returns {void}
 */
function printCppProblems(entry, problems) {
	if (!problems.length) return;
	process.stdout.write(`\n  ${c.bold(entry.slug)}\n`);
	for (const p of problems) {
		const tag = p.level === 'fail' ? c.red('fail') : c.yellow('warn');
		process.stdout.write(`    ${tag} ${c.cyan(`${p.locale}/${p.field}`)}  ${p.message}\n`);
	}
}

/**
 * @param {Config} cfg
 * @param {string|undefined} slug
 * @returns {Promise<CppEntry[]>}
 */
async function pagesFor(cfg, slug) {
	if (slug) {
		const entry = await readPage(cfg, slugify(slug));
		if (!entry)
			throw new ShipError(`no custom product page "${slug}"`, {
				hint: `expected ${cppDir(cfg, slugify(slug))}/ — it holds cpp.json plus one <locale>.json per language`,
			});
		return [entry];
	}
	const all = await readPages(cfg);
	if (!all.length)
		throw new ShipError(`no custom product pages under ${cppRoot(cfg)}`, {
			hint: 'a page is store/cpp/<slug>/cpp.json + <locale>.json — one per ad group, headline matching that keyword',
		});
	return all;
}

/**
 * @param {Config} cfg
 * @param {Flags} flags
 * @returns {Promise<number>}
 */
async function cppList(cfg, flags) {
	const pages = await readPages(cfg);
	const local = pages.map((p) => ({
		slug: p.slug,
		name: p.page.name ?? p.slug,
		adGroup: p.page.adGroup ?? null,
		locales: p.locales.map((l) => l.locale),
		pageId: p.page.pageId ?? null,
		problems: lintPage(p),
	}));

	const appId = optionalAppId(cfg);
	let live = null;
	if (!flags.local && appId) {
		const payload = await asc(['product-pages', 'custom-pages', 'list', '--app', appId, '--paginate'], {
			fallback: null,
			allowFail: true,
		});
		if (payload)
			live = rowsOf(payload).map((r) => ({
				id: idOf(r),
				name: attr(r, 'name'),
				visible: attr(r, 'visible'),
			}));
	}

	if (flags.json) {
		emit({ dir: cppRoot(cfg), pages: local, live });
		return local.some((p) => p.problems.some((x) => x.level === 'fail')) ? 1 : 0;
	}

	heading(`Custom product pages (${local.length})`);
	if (!local.length) {
		note(`none in ${cppRoot(cfg)}`);
		note('create store/cpp/<slug>/cpp.json + <locale>.json, then `ship meta cpp link <slug> --ad-group "…"`');
	} else {
		table(local, [
			{ header: 'slug', get: (p) => p.slug },
			{ header: 'name', get: (p) => p.name },
			{ header: 'ad group', get: (p) => p.adGroup ?? c.dim('—') },
			{ header: 'locales', get: (p) => p.locales.join(',') || '—' },
			{ header: 'pageId', get: (p) => p.pageId ?? '—' },
		]);
		for (const p of pages) printCppProblems(p, lintPage(p));
	}

	if (live) {
		heading(`Live in App Store Connect (${live.length})`);
		table(live, [
			{ header: 'id', get: (p) => p.id ?? '' },
			{ header: 'name', get: (p) => p.name ?? '' },
			{ header: 'visible', get: (p) => String(p.visible ?? '') },
		]);
		const names = new Set(local.map((p) => p.name));
		const orphans = live.filter((p) => p.name && !names.has(p.name));
		if (orphans.length)
			warn(`${orphans.length} live page(s) with no local source: ${orphans.map((p) => p.name).join(', ')}`);
	} else if (!flags.local) {
		note('no asc.appId — skipped the live lookup');
	}
	return local.some((p) => p.problems.some((x) => x.level === 'fail')) ? 1 : 0;
}

/**
 * @param {Config} cfg
 * @param {CppEntry[]} entries
 * @param {Flags} flags
 * @returns {Promise<number>}
 */
async function cppStage(cfg, entries, flags) {
	const dry = isDryRun();
	/** @type {{slug: string, locales: string[], written: string[], screenshots: Record<string, string>}[]} */
	const staged = [];
	for (const entry of entries) {
		const problems = lintPage(entry);
		printCppProblems(entry, problems);
		const failures = problems.filter((p) => p.level === 'fail');
		if (failures.length) {
			if (!flags.force)
				throw new ShipError(`${entry.slug}: ${failures.length} failure${failures.length === 1 ? '' : 's'}`, {
					hint: 'fix them, or re-run with --force',
				});
			warn(`--force: staging ${entry.slug} past ${failures.length} failure(s)`);
		}
		const res = await stagePage(cfg, entry, { write: !dry });
		staged.push({ slug: entry.slug, locales: res.locales, written: res.written, screenshots: res.screenshots });
	}

	if (flags.json) {
		emit({ dryRun: dry, staged });
		return 0;
	}
	for (const s of staged) {
		const label = `${s.slug} → ${s.written.length} file(s) for ${s.locales.length} locale(s)`;
		if (dry) info(`${c.yellow('dry-run')} would write ${label}`);
		else good(label);
	}
	note('generated/ is generated — never hand-edit it, `cpp stage` overwrites it');
	return 0;
}

/** Shared context for one `cpp apply` run. */
/** @typedef {{cfg: Config, appId: string, version: string, dry: boolean, flags: Flags, entries: CppEntry[], livePages: JsonArray, screenshotFailures: string[]}} CppRun */
/** One localization pushed for a page. */
/** @typedef {{locale: string, action: string, localizationId: string|null}} CppAppliedLocale */
/** One page's `cpp apply` outcome. */
/** @typedef {{slug: string, name: Json, pageId: string, versionId: string, locales: CppAppliedLocale[]}} CppApplyResult */

/**
 * Find the page by name in the live list, creating it when ASC has none.
 * Matching by name is what makes a re-run idempotent: ASC will happily create
 * a second page called "Oil change" and then serve whichever one the ad
 * happens to point at.
 *
 * @param {CppRun} run
 * @param {string} name
 * @returns {Promise<Json|null>}
 */
async function findOrCreatePage(run, name) {
	const page = run.livePages.find((p) => attr(p, 'name') === name) ?? null;
	if (page) {
		note(`page exists → ${idOf(page)}`);
		return page;
	}
	const created = await ascMutate(['product-pages', 'custom-pages', 'create', '--app', run.appId, '--name', name]);
	if (!created.ok && !run.dry)
		throw new ShipError(`custom product page create for "${name}" exited ${created.code}`, {
			hint: stderrTail(created.stderr),
		});
	return first(created.data);
}

/**
 * Versions are append-only and a submitted one is frozen. Prefer the editable
 * draft; fall back to the newest and let ASC reject rather than silently
 * writing into a page nobody is serving.
 *
 * @param {CppRun} run
 * @param {string} name
 * @param {string} pageId
 * @returns {Promise<Json|null>}
 */
async function findOrCreatePageVersion(run, name, pageId) {
	const versions = rowsOf(
		await asc(['product-pages', 'custom-pages', 'versions', 'list', '--custom-page-id', pageId, '--paginate'], {
			fallback: [],
		}),
	);
	const pageVersion = versions.find((v) => stateOf(v) === 'PREPARE_FOR_SUBMISSION') ?? versions[0] ?? null;
	if (pageVersion) return pageVersion;
	const created = await ascMutate(['product-pages', 'custom-pages', 'versions', 'create', '--custom-page-id', pageId]);
	if (!created.ok && !run.dry)
		throw new ShipError(`custom page version create for "${name}" exited ${created.code}`, {
			hint: stderrTail(created.stderr),
		});
	return first(created.data);
}

/** Push one locale's staged promotional text: update the live localization, or create it. */
/**
 * @param {CppRun} run
 * @param {CppEntry} entry
 * @param {{locale: string, versionId: string, existing: JsonArray, payload: Json}} p
 * @returns {Promise<CppAppliedLocale>}
 */
async function applyCppLocalization(run, entry, { locale, versionId, existing, payload }) {
	const promo = String(asRow(payload).promotionalText ?? '');
	const live = existing.find((l) => attr(l, 'locale') === locale) ?? null;
	const localizationId = idOf(live);
	const written = await ascMutate(
		localizationId
			? ['product-pages', 'custom-pages', 'localizations', 'update', '--localization-id', localizationId, '--promotional-text', promo]
			: ['product-pages', 'custom-pages', 'localizations', 'create', '--custom-page-version-id', versionId, '--locale', locale, '--promotional-text', promo],
	);
	if (!written.ok && !run.dry)
		throw new ShipError(`${entry.slug}/${locale}: localization ${localizationId ? 'update' : 'create'} exited ${written.code}`, {
			hint: stderrTail(written.stderr),
		});
	if (!run.flags.json) note(`${locale} ${localizationId ? 'updated' : 'created'} ${c.dim(`${charCount(promo)}/${LIMITS.promotionalText}`)}`);
	return { locale, action: localizationId ? 'update' : 'create', localizationId };
}

/**
 * Upload one locale's screenshotDir to its custom-page localization. Directory
 * names under a screenshotDir are display types, exactly as `ship shots` lays
 * them out, and the upload semantics are shared too: this endpoint has no
 * --skip-existing, so a second run would append the same captures again and a
 * set over 10 is rejected at submission — `ship shots` owns the main listing's
 * sets for the same reason. Failures collect into `failures` (a dry run warns
 * and moves on) so one bad device type does not abort the remaining locales.
 * Extracted verbatim from `cpp apply` so a later pass can share it with
 * `ship shots`.
 *
 * @param {Config} cfg
 * @param {Flags} flags
 * @param {boolean} dry
 * @param {{entry: CppEntry, locale: string, versionId: string, localizationId: string|null}} p
 * @param {string[]} failures
 * @returns {Promise<void>}
 */
async function uploadCppScreenshots(cfg, flags, dry, { entry, locale, versionId, localizationId }, failures) {
	const shots = entry.locales.find((l) => l.locale === locale)?.data?.screenshotDir;
	if (!shots) return;
	if (!flags.screenshots) {
		note(`${locale}: screenshotDir set — pass --screenshots to upload it`);
		return;
	}
	const dir = screenshotDir(cfg, shots);
	const types = await deviceDirs(dir);
	const explicit = strOf(flags['device-type']);
	if (!types.length && !explicit) {
		warn(`${locale}: ${dir} has no <DISPLAY_TYPE>/ subdirectories — pass --device-type`);
		return;
	}
	for (const deviceType of types.length ? types : [explicit ?? '']) {
		const path = types.length ? join(dir, deviceType) : dir;
		const localizationTarget = localizationId ?? idOf(first(
			await asc(
				['product-pages', 'custom-pages', 'localizations', 'list', '--custom-page-version-id', versionId, '--paginate'],
				{ fallback: [] },
			),
		));
		if (!localizationTarget) break;
		step(`upload ${locale}/${deviceType}`);
		const upload = await ascMutate(
			['product-pages', 'custom-pages', 'localizations', 'screenshot-sets', 'upload', '--localization-id', localizationTarget, '--path', path, '--device-type', deviceType],
		);
		if (!upload.ok) {
			const msg = `${entry.slug}/${locale}/${deviceType}: screenshot upload exited ${upload.code}`;
			if (dry) warn(msg);
			else failures.push(`${msg}\n${stderrTail(upload.stderr, { lines: 4, fallback: 'no stderr' })}`);
		}
	}
}

/**
 * One page, end to end: resolve (or create) the page and a writable version,
 * push every locale's promotional text, optionally upload screenshots, and
 * record the outcome in cpp.json. Returns the result row, or null when a dry
 * run stopped before anything existed to write against.
 *
 * @param {CppRun} run
 * @param {CppEntry} entry
 * @returns {Promise<CppApplyResult|null>}
 */
async function applyCppPage(run, entry) {
	const { cfg, dry, flags } = run;
	const name = entry.page.name ?? entry.slug;
	step(`${entry.slug} · "${name}"`);
	if (!flags['no-stage']) await stagePage(cfg, entry, { write: !dry });

	const page = await findOrCreatePage(run, name);
	const pageId = idOf(page);
	if (!pageId) {
		if (dry) {
			note(`dry-run: ${entry.locales.length} localization(s) would follow page creation`);
			return null;
		}
		throw new ShipError(`custom product page create returned no id for "${name}"`);
	}

	const pageVersion = await findOrCreatePageVersion(run, name, pageId);
	const versionId = idOf(pageVersion);
	if (!versionId) {
		if (dry) return null;
		throw new ShipError(`custom product page "${name}" has no writable version`);
	}
	const state = stateOf(pageVersion);
	if (state && state !== 'PREPARE_FOR_SUBMISSION')
		warn(`${entry.slug}: version ${versionId} is ${state} — ASC may reject the write`);

	const existing = rowsOf(
		await asc(
			['product-pages', 'custom-pages', 'localizations', 'list', '--custom-page-version-id', versionId, '--paginate'],
			{ fallback: [] },
		),
	);

	/** @type {CppAppliedLocale[]} */
	const applied = [];
	for (const { locale } of entry.locales) {
		const payload = await readJSONIfExists(join(generatedDir(entry.dir), `${locale}.json`));
		if (!payload) {
			warn(`${entry.slug}/${locale}: nothing staged — run \`ship meta cpp stage ${entry.slug}\``);
			continue;
		}
		const localization = await applyCppLocalization(run, entry, { locale, versionId, existing, payload });
		applied.push(localization);
		await uploadCppScreenshots(cfg, flags, dry, { entry, locale, versionId, localizationId: localization.localizationId }, run.screenshotFailures);
	}

	if (!dry) await writeMeta(entry, { ...entry.page, name, pageId, versionId, appliedAt: new Date().toISOString() });
	return { slug: entry.slug, name, pageId, versionId, locales: applied };
}

/** The human-facing end of `cpp apply`: screenshot failures, then next steps. */
/**
 * @param {CppRun} run
 * @param {CppApplyResult[]} results
 * @returns {number}
 */
function finishCppApply(run, results) {
	const { appId, version, dry, flags, entries, screenshotFailures } = run;
	if (flags.json) {
		emit({ app: appId, version, dryRun: dry, pages: results });
		return 0;
	}
	process.stdout.write('\n');
	if (screenshotFailures.length) {
		for (const f of screenshotFailures) process.stdout.write(`  ${c.red('fail')} ${f}\n`);
		throw new ShipError(`${screenshotFailures.length} screenshot upload${screenshotFailures.length === 1 ? '' : 's'} failed`, {
			hint: 're-run `ship meta cpp apply --screenshots` — uploads are append-only, so check the sets in ASC first',
		});
	}
	good(`${dry ? 'dry-run: ' : ''}${results.length} page(s) applied`);
	const unlinked = entries.filter((e) => !e.page.adGroup);
	if (unlinked.length)
		warn(`${unlinked.map((e) => e.slug).join(', ')} serve no ad group — \`ship meta cpp link <slug> --ad-group "…"\``);
	else note('next: ship ads sync — it binds each page to its ad group');
	return 0;
}

/**
 * @param {Config} cfg
 * @param {CppEntry[]} entries
 * @param {Flags} flags
 * @returns {Promise<number>}
 */
async function cppApply(cfg, entries, flags) {
	const appId = requireAppId(cfg);
	const version = await resolveVersion(cfg, strOf(flags.version));
	const dry = isDryRun();
	heading(`${cfg.name} ${version} — custom product pages`);
	await requireApplyableState(cfg, appId, version, flags);

	// Shared context for the per-page steps below.
	/** @type {CppRun} */
	const run = {
		cfg,
		appId,
		version,
		dry,
		flags,
		entries,
		livePages: rowsOf(
			await asc(['product-pages', 'custom-pages', 'list', '--app', appId, '--paginate'], { fallback: [] }),
		),
		screenshotFailures: [],
	};

	/** @type {CppApplyResult[]} */
	const results = [];
	for (const entry of entries) {
		const result = await applyCppPage(run, entry);
		if (result) results.push(result);
	}
	return finishCppApply(run, results);
}

/**
 * @param {Config} cfg
 * @param {CppEntry} entry
 * @param {Flags} flags
 * @returns {Promise<number>}
 */
async function cppLink(cfg, entry, flags) {
	const adGroup = strOf(flags['ad-group'] ?? flags.adGroup);
	if (!adGroup)
		throw new ShipError('meta cpp link: --ad-group is required', {
			hint: 'use the ad group name from aso/asa/campaign-plan.json, e.g. --ad-group "EX · oil change reminder"',
		});

	const clash = (await readPages(cfg)).find((p) => p.slug !== entry.slug && p.page.adGroup === adGroup);
	if (clash && !flags.force)
		throw new ShipError(`ad group "${adGroup}" is already served by ${clash.slug}`, {
			hint: 'one ad group, one page — that split is the only thing making the pages measurable. --force moves it.',
		});

	const page = {
		...entry.page,
		name: entry.page.name ?? entry.slug,
		adGroup,
		campaign: strOf(flags.campaign) ?? entry.page.campaign ?? null,
	};
	if (flags.json) {
		if (!isDryRun()) await writeMeta(entry, page);
		emit(page);
		return 0;
	}
	if (isDryRun()) {
		info(`${c.yellow('dry-run')} ${entry.metaFile.replace(`${cfg.root}/`, '')}`);
		note(`adGroup: ${adGroup}`);
		return 0;
	}
	await writeMeta(entry, page);
	good(`${entry.slug} serves ad group "${adGroup}"`);
	note('next: ship ads sync — it binds the page to that ad group through an Apple Ads creative');
	return 0;
}

const CPP_SUB = new Set(['list', 'stage', 'apply', 'link']);

/**
 * @param {SubCtx} ctx
 * @returns {Promise<number>}
 */
export async function cpp({ args, flags }) {
	const [sub = 'list', ...rest] = args;
	if (!CPP_SUB.has(sub))
		throw new ShipError(`meta cpp: unknown subcommand "${sub}"`, {
			hint: `try: ${[...CPP_SUB].join(', ')}`,
		});
	const cfg = await loadConfig();
	if (!cfg) throw new ShipError('no ship.config.json found', { hint: 'run `ship init` inside the app repo to create one' });
	if (sub === 'list') return cppList(cfg, flags);

	const slug = rest[0] ? String(rest[0]) : (strOf(flags.slug) ?? null);
	if (sub === 'link') {
		if (!slug) throw new ShipError('meta cpp link: name the page', { hint: 'ship meta cpp link <slug> --ad-group "…"' });
		const [entry] = await pagesFor(cfg, slug);
		if (!entry) throw new ShipError(`no custom product page "${slug}"`, { hint: `expected ${cppDir(cfg, slugify(slug))}/` });
		return cppLink(cfg, entry, flags);
	}
	const entries = await pagesFor(cfg, slug);
	return sub === 'stage' ? cppStage(cfg, entries, flags) : cppApply(cfg, entries, flags);
}
