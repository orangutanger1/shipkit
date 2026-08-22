// Custom Product Pages — the listing an ad lands on, one per keyword intent.
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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { LIMITS } from '../config.mjs';
import { ShipError } from '../log.mjs';
import { charCount } from './text.mjs';

/** Fields ASC accepts on an appCustomProductPageLocalization. Nothing else reaches the API. */
export const CPP_LOCALIZATION_FIELDS = ['promotionalText'];

export const cppRoot = (cfg) => join(cfg.paths.store, 'cpp');
export const cppDir = (cfg, slug) => join(cppRoot(cfg), slug);
export const generatedDir = (dir) => join(dir, 'generated');

/** Directory-safe slug: the page's stable identity on disk and in `link`. */
export function slugify(value) {
	return String(value ?? '')
		.toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

async function readJSON(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
	}
}

const writeJSON = (file, data) => writeFile(file, `${JSON.stringify(data, null, '\t')}\n`);

/**
 * One page on disk: `cpp.json` plus every authored `<locale>.json` beside it.
 * `generated/` is skipped — it is output, and re-reading it would let a stale
 * expansion masquerade as authored copy.
 */
export async function readPage(cfg, slug) {
	const dir = cppDir(cfg, slug);
	if (!existsSync(dir)) return null;
	const metaFile = join(dir, 'cpp.json');
	const page = existsSync(metaFile) ? await readJSON(metaFile) : { slug };
	const locales = [];
	for (const f of (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'cpp.json').sort()) {
		const file = join(dir, f);
		const data = await readJSON(file);
		locales.push({ locale: data.locale ?? basename(f, '.json'), file, data });
	}
	return { slug, dir, metaFile, page: { ...page, slug }, locales };
}

/** Every authored page, sorted by slug. Missing store/cpp is an empty list, not an error. */
export async function readPages(cfg) {
	const root = cppRoot(cfg);
	if (!existsSync(root)) return [];
	const out = [];
	for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const page = await readPage(cfg, entry.name);
		if (page) out.push(page);
	}
	return out;
}

export async function writeMeta(entry, page) {
	await mkdir(entry.dir, { recursive: true });
	await writeJSON(entry.metaFile ?? join(entry.dir, 'cpp.json'), page);
	return entry.metaFile ?? join(entry.dir, 'cpp.json');
}

/** Resolve an authored `screenshotDir` against the repo root. */
export const screenshotDir = (cfg, dir) => (isAbsolute(dir) ? dir : join(cfg.root, dir));

/**
 * Offline validation. The load-bearing one is the last: a page with neither
 * promotional text nor screenshots renders byte-identical to the default
 * listing, so it costs an ad group's worth of setup and converts no better.
 * @returns {{level:'fail'|'warn', locale:string, field:string, message:string}[]}
 */
export function lintPage(entry) {
	const problems = [];
	const fail = (locale, field, message) => problems.push({ level: 'fail', locale, field, message });
	const warn = (locale, field, message) => problems.push({ level: 'warn', locale, field, message });

	if (!entry.locales.length) fail('—', 'locales', `no <locale>.json in ${entry.dir}`);
	if (!entry.page.name) fail('—', 'name', 'cpp.json has no page name — Apple Ads picks pages by name');

	for (const { locale, file, data } of entry.locales) {
		if (data.locale && data.locale !== locale)
			fail(locale, 'locale', `file says "${data.locale}" but is named ${basename(file)}`);
		const promo = String(data.promotionalText ?? '').trim();
		const len = charCount(promo);
		if (len > LIMITS.promotionalText)
			fail(locale, 'promotionalText', `${len}/${LIMITS.promotionalText} chars — over limit`);
		if (!promo && !data.screenshotDir)
			fail(
				locale,
				'promotionalText',
				'neither promotional text nor screenshots — this page is identical to the default listing',
			);
		if (data.description)
			warn(locale, 'description', 'ASC ignores it on a custom product page; kept as a copywriting note');
	}
	return problems;
}

/**
 * Expand authored files into the canonical tree, exactly as `locales.mjs stage`
 * does for the main listing: `generated/` holds only what asc will accept, and
 * is safe to delete because this rewrites it.
 * @returns {Promise<{written:string[], locales:string[], screenshots:Record<string,string>}>}
 */
export async function stagePage(cfg, entry, { write = true } = {}) {
	const out = generatedDir(entry.dir);
	if (write) await mkdir(out, { recursive: true });

	const written = [];
	const screenshots = {};
	for (const { locale, data } of entry.locales) {
		const payload = { locale };
		for (const field of CPP_LOCALIZATION_FIELDS) {
			const v = data[field];
			if (v !== undefined && v !== null && String(v).trim() !== '') payload[field] = String(v).trim();
		}
		if (data.screenshotDir) screenshots[locale] = screenshotDir(cfg, data.screenshotDir);
		const file = join(out, `${locale}.json`);
		if (write) await writeJSON(file, payload);
		written.push(file);
	}

	const pageFile = join(out, 'page.json');
	const page = {
		slug: entry.slug,
		name: entry.page.name ?? entry.slug,
		adGroup: entry.page.adGroup ?? null,
		campaign: entry.page.campaign ?? null,
		locales: entry.locales.map((l) => l.locale),
		screenshots,
	};
	if (write) await writeJSON(pageFile, page);
	written.push(pageFile);

	return { written, locales: page.locales, screenshots };
}

/** The page serving an ad group, or null. One ad group is served by one page. */
export const pageForAdGroup = (pages, adGroup) =>
	pages.find((p) => p.page.adGroup && p.page.adGroup === adGroup) ?? null;
