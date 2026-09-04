// The audit that separates a localized listing from a translated one: pure,
// offline rules shared by `ship loc review` (prints the rows) and `ship loc
// status` (counts them). Each rule is a named entry in RULES; `auditListing`
// runs them in order and stamps every row with the locale it came from.
// Also home to the contract the rules enforce: the TODO( marker `ship loc
// draft` leaves behind, the glossary shape, and the harvest-evidence test.
import { LIMITS } from '../config.mjs';
import { readJSONIfExists } from './jsonio.mjs';
import { keywordList } from './locales.mjs';
import { charCount, langOf, overlap, words } from './text.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./locales.mjs').ListingData} ListingData */

/** The per-locale harvest evidence `ship aso harvest` produced for a storefront. */
/** @typedef {import('./loc-index.mjs').HarvestIndex} HarvestIndex */

/**
 * The glossary is the contract with the translator: which locale the copy is
 * authored in, the terms a translator must leave alone, and the translation
 * agreed per source term per locale.
 * @typedef {{
 *   sourceLocale?: string|null, neverTranslate?: string[],
 *   terms?: {[srcTerm: string]: {[locale: string]: string}}
 * }} Glossary
 */
/** One raw audit finding, before the locale-facing stamp. */
/** @typedef {{level: 'fail'|'warn', rule: string, detail: string}} RawFinding */
/** What every audit rule receives. */
/** @typedef {{
 *   locale: string, data: ListingData, source: string, sourceData: ListingData,
 *   glossary: Glossary, harvest: HarvestIndex|null, euTrader: string|null,
 *   isSource: boolean, neverTranslate: string[]
 * }} AuditCtx */
/** One audit finding as review/status consume it. */
/** @typedef {{level: 'fail'|'warn', name: string, detail: string, locale: string, rule: string}} Finding */

/** Fields a listing must fill before it is submittable — and everything a marker can hide in. */
export const COPY_FIELDS = ['name', 'subtitle', 'keywords', 'description', 'promotionalText', 'whatsNew'];

/** The marker `ship loc draft` leaves where it could not translate, and its test. */
/**
 * @param {string} locale
 * @returns {string}
 */
export const todoMarker = (locale) => `TODO(${locale})`;
/**
 * @param {Json|undefined} v
 * @returns {boolean}
 */
export const hasTodo = (v) => String(v ?? '').includes('TODO(');

/**
 * @param {string} source
 * @returns {Glossary}
 */
const emptyGlossary = (source) => ({ sourceLocale: source, neverTranslate: [], terms: {} });

/** The glossary is the contract with the translator; a missing file reads as empty. */
/**
 * @param {Config} cfg
 * @param {string} source
 * @returns {Promise<Glossary>}
 */
export async function readGlossary(cfg, source) {
	return /** @type {Glossary} */ ((await readJSONIfExists(cfg.paths.glossary)) ?? emptyGlossary(source));
}

/**
 * Sorted keys everywhere. This file is read in a pull-request diff, and a map
 * that reorders itself on every write hides the one line that changed.
 * @param {Glossary} g
 * @returns {Glossary & {neverTranslate: string[], terms: {[srcTerm: string]: {[locale: string]: string}}}} both maps always present, so callers need no fallback
 */
export function stableGlossary(g) {
	/** @type {{[srcTerm: string]: {[locale: string]: string}}} */
	const terms = {};
	for (const key of Object.keys(g.terms ?? {}).sort()) {
		const row = g.terms?.[key] ?? {};
		/** @type {Record<string, string>} */
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
/**
 * @param {Json} locale
 * @returns {boolean}
 */
export function isEuLocale(locale) {
	const [lang, region] = String(locale ?? '').split(/[-_]/);
	if (region) return EU_REGIONS.has(region.toUpperCase());
	return EU_LANGS.has(String(lang).toLowerCase());
}

/**
 * Privacy law acronyms that differ from the English one. A German listing saying
 * "GDPR" reads as machine-translated boilerplate to a German reviewer and to a
 * German buyer; the local acronym is the one they searched for.
 * @type {Record<string, string>}
 */
const REGULATORY = { de: 'DSGVO', fr: 'RGPD', es: 'RGPD', pt: 'RGPD', nl: 'AVG', pl: 'RODO' };

/**
 * @param {ListingData} data
 * @returns {string}
 */
const corpusOf = (data) =>
	COPY_FIELDS.map((f) => String(data[f] ?? ''))
		.join('\n')
		.toLocaleLowerCase();

/** Does a term — or any of its tokens — have evidence in a `tokenIndex` set? */
/**
 * @param {string} term
 * @param {Set<string>} index
 * @param {string} locale
 * @returns {boolean}
 */
export const supported = (term, index, locale) =>
	index.has(String(term).toLocaleLowerCase()) || words(term, locale).some((w) => index.has(w));

// (a) a draft nobody finished. `ship loc draft` marks what it could not translate.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const todoRule = ({ data }) => {
	const todo = COPY_FIELDS.filter((f) => hasTodo(data[f]));
	return todo.length
		? [{ level: 'fail', rule: 'todo', detail: `unfinished: ${todo.join(', ')} still carry a TODO( marker` }]
		: [];
};

// (b) the English listing wearing a German hat.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const untranslatedRule = ({ isSource, source, data, sourceData, neverTranslate }) => {
	if (isSource) return [];
	const brand = new Set(neverTranslate.map((t) => t.toLocaleLowerCase()));
	const same = ['name', 'subtitle', 'keywords'].filter(
		(f) => String(data[f] ?? '').trim() && String(data[f]) === String(sourceData[f] ?? ''),
	);
	// A name identical to the source is correct when the name is the brand.
	const flagged = same.filter((f) => !(f === 'name' && brand.has(String(data[f]).toLocaleLowerCase())));
	return flagged.length
		? [{ level: 'fail', rule: 'untranslated', detail: `byte-identical to ${source}: ${flagged.join(', ')}` }]
		: [];
};

// (c) keywords with no evidence in this locale's own harvest.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const harvestRule = ({ isSource, source, locale, data, sourceData, harvest }) => {
	if (isSource) return [];
	const kws = keywordList(data.keywords).filter((k) => !hasTodo(k));
	if (!kws.length) return [];
	if (!harvest)
		return [
			{
				level: 'warn',
				rule: 'harvest',
				detail: `no aso/${locale}/candidates.json — these keywords have no local evidence`,
			},
		];
	const unsupported = kws.filter((k) => !supported(k, harvest.index, locale));
	if (!unsupported.length) return [];
	if (unsupported.length === kws.length) {
		const ov = overlap(kws.join(' '), keywordList(sourceData.keywords).join(' '), locale);
		return [
			ov >= 0.4
				? {
						level: 'fail',
						rule: 'translated-not-harvested',
						detail: `${Math.round(ov * 100)}% of these tokens are the ${source} ones and none appear in the ${locale} harvest`,
					}
				: {
						level: 'fail',
						rule: 'unharvested',
						detail: `no keyword appears in the ${locale} harvest of ${harvest.terms} terms — ship loc seed, then ship aso harvest --locale ${locale}`,
					},
		];
	}
	return [
		{
			level: 'warn',
			rule: 'unharvested',
			detail: `${unsupported.length}/${kws.length} absent from the ${locale} harvest: ${unsupported.slice(0, 6).join(', ')}`,
		},
	];
};

// (d) the glossary is the contract with the translator; both directions matter.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const glossaryRule = ({ isSource, locale, data, sourceData, glossary, neverTranslate }) => {
	if (isSource) return [];
	/** @type {RawFinding[]} */
	const rows = [];
	const target = corpusOf(data);
	const src = corpusOf(sourceData);
	for (const term of neverTranslate) {
		const t = String(term).toLocaleLowerCase();
		if (!t || !src.includes(t) || target.includes(t)) continue;
		rows.push({ level: 'fail', rule: 'glossary', detail: `"${term}" is neverTranslate but is gone from the ${locale} copy` });
	}
	for (const [srcTerm, row] of Object.entries(glossary.terms ?? {})) {
		const agreed = row?.[locale];
		const t = String(srcTerm).toLocaleLowerCase();
		if (!agreed || !target.includes(t)) continue;
		if (neverTranslate.some((n) => String(n).toLocaleLowerCase() === t)) continue;
		rows.push({ level: 'warn', rule: 'glossary', detail: `"${srcTerm}" left untranslated; the glossary agreed on "${agreed}"` });
	}
	return rows;
};

// (e) code points, not UTF-16 units. German compounds routinely blow the subtitle.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const lengthRule = ({ data }) =>
	Object.entries(LIMITS).flatMap(([field, max]) => {
		if (data[field] == null) return [];
		const len = charCount(data[field]);
		return len > max ? [{ level: 'fail', rule: 'length', detail: `${field} is ${len}/${max} code points — over the ASC limit` }] : [];
	});

// (f) local legal copy.
/**
 * @param {AuditCtx} ctx
 * @returns {RawFinding[]}
 */
const legalRule = ({ locale, data, euTrader }) => {
	/** @type {RawFinding[]} */
	const rows = [];
	const acronym = REGULATORY[langOf(locale)];
	if (acronym) {
		const text = corpusOf(data);
		if (/\bgdpr\b/.test(text) && !text.includes(acronym.toLocaleLowerCase()))
			rows.push({ level: 'fail', rule: 'legal', detail: `says GDPR; a ${locale} listing must say ${acronym}` });
	}
	if (isEuLocale(locale) && !euTrader)
		rows.push({
			level: 'fail',
			rule: 'trader',
			detail: `${locale} is an EU storefront and legal.euTrader is null — undeclared traders are removed from EU storefronts`,
		});
	return rows;
};

/**
 * The rules that separate a localized listing from a translated one, in the
 * order review prints them. Each `run` gets the audit context and returns raw
 * rows; `auditListing` stamps on the locale-facing shape.
 * @type {{name: string, run: (ctx: AuditCtx) => RawFinding[]}[]}
 */
const RULES = [
	{ name: 'todo', run: todoRule },
	{ name: 'untranslated', run: untranslatedRule },
	{ name: 'harvest', run: harvestRule },
	{ name: 'glossary', run: glossaryRule },
	{ name: 'length', run: lengthRule },
	{ name: 'legal', run: legalRule },
];

/**
 * The rules that separate a localized listing from a translated one.
 * Pure, offline and shared: `review` prints these rows, `status` counts them.
 * @param {{locale: string, data: ListingData, source: string, sourceData?: ListingData, glossary?: Glossary, harvest?: HarvestIndex|null, euTrader?: string|null}} opts
 * @returns {Finding[]}
 */
export function auditListing({ locale, data, source, sourceData = /** @type {ListingData} */ ({}), glossary = {}, harvest = null, euTrader = null }) {
	/** @type {AuditCtx} */
	const ctx = {
		locale,
		data,
		source,
		sourceData,
		glossary,
		harvest,
		euTrader,
		isSource: locale === source,
		neverTranslate: glossary.neverTranslate ?? [],
	};
	return RULES.flatMap(({ run }) =>
		run(ctx).map(({ level, rule, detail }) => ({ level, name: `${locale} ${rule}`, detail, locale, rule })),
	);
}
