// Store-listing model: authored `staged/<locale>.json` → canonical asc metadata tree.
//
// Authored form (one file per locale, human-edited, review notes allowed):
//   { locale, name, subtitle, keywords, description, promotionalText, whatsNew,
//     privacyPolicyUrl?, supportUrl?, marketingUrl?, notes? }
//
// Canonical form consumed by `asc metadata apply --dir`:
//   app-info/<locale>.json      { name, subtitle, privacyPolicyUrl, privacyChoicesUrl, privacyPolicyText }
//   version/<v>/<locale>.json   { description, keywords, marketingUrl, promotionalText, supportUrl, whatsNew }
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LIMITS } from '../config.mjs';
import { ShipError } from '../log.mjs';

export const APP_INFO_FIELDS = [
	'name',
	'subtitle',
	'privacyPolicyUrl',
	'privacyChoicesUrl',
	'privacyPolicyText',
];
export const VERSION_FIELDS = [
	'description',
	'keywords',
	'marketingUrl',
	'promotionalText',
	'supportUrl',
	'whatsNew',
];

/** Fields that must never be empty for a listing to be submittable. */
const REQUIRED = ['name', 'subtitle', 'keywords', 'description'];

/** ASC counts keywords as a 100-char comma-separated string; spaces after commas waste index slots. */
export function keywordList(keywords) {
	return String(keywords ?? '')
		.split(',')
		.map((k) => k.trim())
		.filter(Boolean);
}

export function normaliseKeywords(keywords) {
	const seen = new Set();
	const out = [];
	for (const k of keywordList(keywords)) {
		const key = k.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(k);
	}
	return out.join(',');
}

/** Read every staged listing. Returns [{locale, file, data}] sorted by locale. */
export async function readStaged(cfg) {
	const dir = cfg.paths.staged;
	if (!existsSync(dir)) return [];
	const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
	const out = [];
	for (const f of files) {
		const file = join(dir, f);
		let data;
		try {
			data = JSON.parse(await readFile(file, 'utf8'));
		} catch (err) {
			throw new ShipError(`${file} is not valid JSON`, { hint: err.message });
		}
		out.push({ locale: data.locale ?? basename(f, '.json'), file, data });
	}
	return out;
}

/**
 * Offline validation of one listing.
 * @returns {{level:'fail'|'warn', field:string, message:string}[]}
 */
export function lintListing({ locale, file, data }) {
	const problems = [];
	const fail = (field, message) => problems.push({ level: 'fail', field, message, locale, file });
	const warn = (field, message) => problems.push({ level: 'warn', field, message, locale, file });

	if (data.locale && data.locale !== locale)
		fail('locale', `file says "${data.locale}" but is named ${basename(file)}`);

	for (const field of REQUIRED) {
		if (!String(data[field] ?? '').trim()) fail(field, 'required but empty');
	}
	for (const [field, max] of Object.entries(LIMITS)) {
		const value = data[field];
		if (value == null) continue;
		const len = [...String(value)].length;
		if (len > max) fail(field, `${len}/${max} chars — over limit`);
		else if (field === 'keywords' && len < max * 0.8)
			warn(field, `${len}/${max} chars — ${max - len} keyword characters unused`);
	}
	if (data.keywords) {
		if (/,\s/.test(data.keywords))
			fail('keywords', 'contains ", " — spaces after commas waste index characters');
		const list = keywordList(data.keywords);
		const dupes = list.filter((k, i) => list.findIndex((o) => o.toLocaleLowerCase() === k.toLocaleLowerCase()) !== i);
		if (dupes.length) fail('keywords', `duplicate terms: ${[...new Set(dupes)].join(', ')}`);
		const nameWords = new Set(
			`${data.name ?? ''} ${data.subtitle ?? ''}`
				.toLocaleLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter((w) => w.length > 2),
		);
		const wasted = list.filter((k) => nameWords.has(k.toLocaleLowerCase()));
		if (wasted.length)
			warn('keywords', `already indexed via name/subtitle: ${wasted.join(', ')} — free up the slots`);
	}
	for (const field of ['privacyPolicyUrl', 'supportUrl', 'marketingUrl']) {
		const v = data[field];
		if (v && !v.startsWith('https://')) fail(field, 'must be an https URL');
	}
	return problems;
}

/**
 * Expand staged listings into the canonical tree asc consumes.
 * Shared URLs fall back to the primary locale, then to ship.config legal.*.
 * @returns {Promise<{written:string[], locales:string[]}>}
 */
export async function stage(cfg, version, { write = true } = {}) {
	const listings = await readStaged(cfg);
	if (!listings.length)
		throw new ShipError(`no staged listings in ${cfg.paths.staged}`, {
			hint: 'run `ship meta pull` to seed from App Store Connect, or `ship init` to create templates',
		});

	const primary = listings.find((l) => l.locale === cfg.asc.primaryLocale) ?? listings[0];
	const shared = {
		privacyPolicyUrl: primary.data.privacyPolicyUrl ?? cfg.legal.privacyUrl,
		supportUrl: primary.data.supportUrl ?? cfg.legal.supportUrl,
		marketingUrl: primary.data.marketingUrl ?? cfg.legal.marketingUrl,
	};

	const versionDir = cfg.versionDir(version);
	if (write) {
		await mkdir(cfg.paths.appInfo, { recursive: true });
		await mkdir(versionDir, { recursive: true });
	}

	const written = [];
	for (const { locale, data } of listings) {
		const appInfo = pick({ ...data, privacyPolicyUrl: data.privacyPolicyUrl ?? shared.privacyPolicyUrl }, APP_INFO_FIELDS);
		const versionData = pick(
			{
				...data,
				keywords: normaliseKeywords(data.keywords),
				supportUrl: data.supportUrl ?? shared.supportUrl,
				marketingUrl: data.marketingUrl ?? shared.marketingUrl,
			},
			VERSION_FIELDS,
		);
		const a = join(cfg.paths.appInfo, `${locale}.json`);
		const v = join(versionDir, `${locale}.json`);
		if (write) {
			await writeFile(a, `${JSON.stringify(appInfo, null, '\t')}\n`);
			await writeFile(v, `${JSON.stringify(versionData, null, '\t')}\n`);
		}
		written.push(a, v);
	}
	return { written, locales: listings.map((l) => l.locale) };
}

function pick(obj, fields) {
	const out = {};
	for (const f of fields) {
		const v = obj[f];
		if (v !== undefined && v !== null && v !== '') out[f] = v;
	}
	return out;
}

/** Parse a legacy `asc localizations` .strings file into a plain object. */
export function parseStrings(text) {
	const out = {};
	// "key" = "value"; with escaped quotes and newlines inside the value.
	const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
	let m;
	while ((m = re.exec(text))) {
		out[unescapeStrings(m[1])] = unescapeStrings(m[2]);
	}
	return out;
}

function unescapeStrings(s) {
	return s.replace(/\\(.)/g, (_, ch) =>
		ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
	);
}
