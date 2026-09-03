// Pure analytics report parsing — no fs, no network. Apple ships term and
// funnel numbers in at least four shapes: the API's wide TSV reports, the web
// UI's CSV export, some locales' semicolon CSV, and every third-party funnel
// export's own column names. Everything here takes bytes (or records) in and
// returns the `{terms, funnel}` / step-list shapes the analytics command and
// `ship aso` read; both are pure and unit-tested.
import { ShipError } from '../log.mjs';
import { isCovered, stopwordsFor, words } from './text.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */

/** One normalised analytics term row — what every reader below consumes. */
/** @typedef {{term: string, impressions: number, pageViews: number, installs: number, conversionRate: number}} TermRow */
/** Impressions / page views / installs, the three numbers every funnel counts. */
/** @typedef {{impressions: number, pageViews: number, installs: number}} Counts */

/**
 * Numbers arrive as "1,234", "12.3%" or "" depending on who exported them.
 * @param {Json|undefined} v
 * @returns {number}
 */
export function parseSpreadsheetNumber(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	const n = Number(String(v ?? '').replace(/[,\s%]/g, ''));
	return Number.isFinite(n) ? n : 0;
}

/**
 * @param {number} top
 * @param {number} bottom
 * @returns {number}
 */
const rate = (top, bottom) => (bottom > 0 ? top / bottom : 0);

/** @returns {Counts} */
export const zero = () => ({ impressions: 0, pageViews: 0, installs: 0 });

/**
 * Search terms that already convert and that the keyword field does not carry.
 *
 * This is the highest-value listing edit available at any moment: Apple has
 * proven the demand and proven the term converts, and the field it should be
 * indexed from does not contain it. Tokenisation is locale-aware because
 * whitespace splitting reports every Japanese term as missing — `予定管理` is
 * covered by a field holding `カレンダー,予定,管理` and no `/\s+/` split sees it.
 *
 * @param {TermRow[]} rows analytics term rows
 * @param {string|string[]} keywords the staged keyword field
 * @param {string} [locale]
 * @returns {TermRow[]}
 */
export function missingFromListing(rows, keywords, locale = 'en') {
	const field = Array.isArray(keywords) ? keywords.join(' ') : String(keywords ?? '');
	const index = new Set(words(field, locale));
	// `isCovered` tests every token of the term. Apple indexes none of the
	// connectives, so their absence from the field is not a gap.
	for (const w of stopwordsFor(locale)) index.add(w);
	return (rows ?? [])
		.map(normaliseRow)
		.filter((r) => r.term && r.installs > 0 && !isCovered(r.term, index, locale))
		.sort((a, b) => b.installs - a.installs || b.impressions - a.impressions);
}

/** Where a healthy listing sits. Below these, the stage is the problem. */
export const BENCHMARK = { viewRate: 0.08, installRate: 0.3 };

export const STAGE = {
	impressions: {
		stage: 'impressions',
		means: 'nobody is seeing the listing at all',
		fix: 'not a conversion problem — you rank for terms with no volume. `ship aso score` then re-pick the keyword field.',
	},
	view: {
		stage: 'impression→pageview',
		means: 'people see the search result and scroll past it',
		fix: 'ASO problem: icon, title and subtitle are all a search result shows. Rewrite them around terms that convert.',
	},
	install: {
		stage: 'pageview→install',
		means: 'people open the product page and leave',
		fix: 'product-page problem: screenshots 1-2, the first-run promise and paywall timing.',
	},
};

/**
 * Which stage of impressions → page views → installs is losing the users, and
 * what that stage actually maps to. Zero impressions is the common case for a
 * new app and must not divide by zero.
 *
 * @param {{impressions?:number, pageViews?:number, installs?:number}} totals
 */
export function bottleneck({ impressions = 0, pageViews = 0, installs = 0 } = {}) {
	const imp = parseSpreadsheetNumber(impressions);
	const views = parseSpreadsheetNumber(pageViews);
	const inst = parseSpreadsheetNumber(installs);
	const out = {
		impressions: imp,
		pageViews: views,
		installs: inst,
		viewRate: rate(views, imp),
		installRate: rate(inst, views),
		conversionRate: rate(inst, imp),
	};
	if (imp <= 0) return { ...out, ...STAGE.impressions, healthy: false };
	const viewScore = out.viewRate / BENCHMARK.viewRate;
	const installScore = out.installRate / BENCHMARK.installRate;
	const worst = installScore < viewScore ? STAGE.install : STAGE.view;
	return { ...out, ...worst, healthy: viewScore >= 1 && installScore >= 1 };
}

/**
 * Analytics rows are written by us but read from files humans edit; take every
 * shape.
 * @param {Json|undefined} [r]
 * @returns {TermRow}
 */
export function normaliseRow(r) {
	const row = typeof r === 'object' && r !== null && !Array.isArray(r) ? r : {};
	const term = String(row.term ?? row.keyword ?? '').trim();
	const impressions = parseSpreadsheetNumber(row.impressions);
	const pageViews = parseSpreadsheetNumber(row.pageViews ?? row.pageviews ?? row.views);
	const installs = parseSpreadsheetNumber(row.installs ?? row.downloads ?? row.units);
	return {
		term,
		impressions,
		pageViews,
		installs,
		conversionRate: impressions > 0 ? rate(installs, impressions) : parseSpreadsheetNumber(row.conversionRate),
	};
}

/**
 * Parse a delimited report into records. Apple's API reports are TSV, the web
 * export is CSV, and some locales export CSV with semicolons; sniff the header.
 * @param {string|undefined} [text]
 * @returns {Array<Record<string,string>>}
 */
export function parseDelimited(text) {
	const src = String(text ?? '')
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n');
	const head = src.split('\n').find((l) => l.trim()) ?? '';
	const delim = head.includes('\t') ? '\t' : head.split(';').length > head.split(',').length ? ';' : ',';
	const rows = [];
	let row = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quoted) {
			if (ch !== '"') cell += ch;
			else if (src[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
			continue;
		}
		if (ch === '"' && cell === '') quoted = true;
		else if (ch === delim) {
			row.push(cell);
			cell = '';
		} else if (ch === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += ch;
	}
	if (cell !== '' || row.length) rows.push([...row, cell]);
	const used = rows.filter((r) => r.some((v) => v.trim() !== ''));
	if (used.length < 2) return [];
	const header = used[0].map((h) => h.trim());
	return used.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Header name → the role it plays. Apple has renamed every one of these at least once. */
/** @type {[string, RegExp][]} */
const COLUMN = [
	['term', /^(search\s*)?(term|keyword|query)s?$/i],
	['impressions', /impression/i],
	['pageViews', /(product\s*)?page\s*views?$/i],
	['installs', /^(installs?|downloads?|units|total downloads?|first[-\s]?time downloads?)$/i],
	['conversionRate', /conversion/i],
	['territory', /^(territory|country|region|storefront)$/i],
	['event', /^(event|metric|engagement\s*type)$/i],
	['counts', /^(unique\s*)?counts?$/i],
];

/**
 * @param {string[]} headers
 * @returns {Record<string, string>}
 */
function roles(headers) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const h of headers) {
		const hit = COLUMN.find(([, re]) => re.test(h));
		if (hit && !out[hit[0]]) out[hit[0]] = h;
	}
	return out;
}

/** @type {[string, RegExp][]} */
const EVENT = [
	['impressions', /impression/i],
	['pageViews', /page\s*view/i],
	['installs', /install|download|unit/i],
];

/** @type {Array<'impressions'|'pageViews'|'installs'>} */
const METRIC_KEYS = ['impressions', 'pageViews', 'installs'];

/** An export's own total row would double-count every term it sits under. */
/**
 * @param {string} term
 * @returns {boolean}
 */
const isTotalRow = (term) => /^(total|totals|all|—|-)$/i.test(term);

/** A row outside the requested territory contributes nothing (no territory column → keep all). */
/**
 * @param {Record<string,string>} rec
 * @param {Record<string,string>} col
 * @param {string|null} want
 * @returns {boolean}
 */
const inTerritory = (rec, col, want) =>
	!want || !col.territory || String(rec[col.territory] ?? '').toLowerCase().includes(want);

/** The wide layout reads all three metric columns straight off the row. */
/**
 * @param {Record<string,string>} rec
 * @param {Record<string,string>} col
 * @returns {Counts}
 */
function wideCounts(rec, col) {
	const add = zero();
	add.impressions = parseSpreadsheetNumber(rec[col.impressions]);
	add.pageViews = parseSpreadsheetNumber(rec[col.pageViews]);
	add.installs = parseSpreadsheetNumber(rec[col.installs]);
	return add;
}

/** The long Event/Counts layout names one metric per row; unknown events contribute nothing. */
/**
 * @param {Record<string,string>} rec
 * @param {Record<string,string>} col
 * @returns {Counts|null}
 */
function longCounts(rec, col) {
	const kind = EVENT.find(([, re]) => re.test(String(rec[col.event] ?? '')));
	if (!kind) return null;
	return { ...zero(), [kind[0]]: parseSpreadsheetNumber(rec[col.counts]) };
}

/**
 * Fold report records into per-term counts and a total funnel. Handles both
 * layouts Apple ships: a wide report (one column per metric) and a long one
 * (an `Event` column plus `Counts`).
 *
 * @param {Record<string,string>[]} records
 * @param {{territory?: string}} [opts]
 * @returns {{terms: TermRow[], funnel: Counts, matched: boolean}}
 */
export function foldRecords(records, { territory } = {}) {
	if (!records.length) return { terms: [], funnel: zero(), matched: false };
	const col = roles(Object.keys(records[0]));
	const wide = col.impressions || col.pageViews || col.installs;
	const long = col.event && col.counts;
	if (!wide && !long) return { terms: [], funnel: zero(), matched: false };

	const funnel = zero();
	/** @type {Map<string, Counts>} */
	const byTerm = new Map();
	const want = territory ? String(territory).toLowerCase() : null;
	for (const rec of records) {
		if (!inTerritory(rec, col, want)) continue;
		const term = col.term ? String(rec[col.term] ?? '').trim() : '';
		if (isTotalRow(term)) continue;
		const add = wide ? wideCounts(rec, col) : longCounts(rec, col);
		if (!add) continue;
		for (const k of METRIC_KEYS) funnel[k] += add[k];
		if (!term) continue;
		const seen = byTerm.get(term) ?? zero();
		for (const k of METRIC_KEYS) seen[k] += add[k];
		byTerm.set(term, seen);
	}

	const terms = [...byTerm]
		.map(([term, v]) => ({ term, ...v, conversionRate: rate(v.installs, v.impressions) }))
		.sort((a, b) => b.installs - a.installs || b.impressions - a.impressions);
	return { terms, funnel, matched: true };
}

/** Column roles in a funnel export. PostHog, Amplitude and Mixpanel each name these differently. */
const STEP_NAME = /^(step|name|event|label|screen|funnel[ _-]?step)$/i;
const STEP_COUNT = /^(users?|count|completed|people|value|unique[ _-]?users|conversions?)$/i;

/**
 * One funnel step as parsed: `order` is consumed by the sort and dropped.
 * @typedef {{name: string, users: number, kind: Json|undefined}} FunnelStep
 */

/**
 * An export → ordered `{name, users}` steps. Accepts the three shapes a funnel
 * arrives in: delimited text with a header, a bare JSON array, and PostHog's
 * `{result:[{name, count, order}]}`. Row order is the funnel order except when
 * an explicit `order`/`step_index` is present, which wins.
 *
 * @param {string} text
 * @returns {FunnelStep[]}
 */
export function parseFunnelExport(text) {
	const raw = String(text ?? '').trim();
	if (!raw) return [];

	let records;
	if (raw.startsWith('{') || raw.startsWith('[')) {
		const doc = JSON.parse(raw);
		records = Array.isArray(doc) ? doc : (doc.result ?? doc.steps ?? doc.funnel ?? doc.data);
		if (!Array.isArray(records)) throw new ShipError('that JSON has no funnel array', { hint: 'expected an array, or {steps:[…]} / {result:[…]}' });
	} else {
		records = parseDelimited(raw);
	}

	const steps = records.map((r, i) => {
		const keys = Object.keys(r ?? {});
		const nameKey = keys.find((k) => STEP_NAME.test(k.trim()));
		const countKey = keys.find((k) => STEP_COUNT.test(k.trim()));
		const order = parseSpreadsheetNumber(r?.order ?? r?.step_index ?? r?.index);
		return {
			name: String((nameKey ? r[nameKey] : r?.name) ?? `step ${i + 1}`).trim(),
			users: parseSpreadsheetNumber(countKey ? r[countKey] : (r?.users ?? r?.count)),
			kind: r?.kind ?? r?.type,
			// Absent order must not collapse every row onto 0 and reverse nothing.
			order: Number.isFinite(order) && order > 0 ? order : i + 1,
		};
	});
	return steps.sort((a, b) => a.order - b.order).map(({ order: _order, ...s }) => s);
}
