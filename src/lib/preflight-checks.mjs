// Pure preflight predicates and classifiers — no network, no asc, no fs.
// A rule nobody can unit-test is a rule a refactor silently inverts, and the
// cost of that is a bounced submission.
import { SYM } from '../log.mjs';

/** @typedef {import('./util.mjs').Json} Json */
/** @typedef {import('./util.mjs').JsonObject} JsonObject */
/** @typedef {import('./util.mjs').JsonArray} JsonArray */
/** What a {@link import('../log.mjs').Report} method is named after. */
/** @typedef {'ok'|'warn'|'fail'|'skip'} Level */
/** How an asc probe turned out; `unavailable` is added by the live wrappers. */
/** @typedef {'empty'|'ok'|'unsupported'|'unauthorized'|'error'|'unavailable'} AscState */
/** @typedef {{state: AscState, payload: Json|null, detail: string}} AscResult */

/** @param {Json|undefined} v @returns {v is JsonObject} */
const isJsonObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export const ENCRYPTION_KEY = 'ITSAppUsesNonExemptEncryption';
export const COMPLIANCE_CODE_KEY = 'ITSEncryptionExportComplianceCode';

const LEVELS = new Set(['ok', 'warn', 'fail', 'skip']);

/** @param {string} s @returns {s is Level} */
const isLevel = (s) => LEVELS.has(s);

/** asc/revenuecat severity words → Report methods. Unknown severities are failures.
 * @param {string} raw
 * @param {Level} [fallback]
 * @returns {Level}
 */
export function levelOf(raw, fallback = 'fail') {
	const s = String(raw).toLowerCase();
	if (isLevel(s)) return s;
	if (s === 'error' || s === 'invalid' || s === 'blocker' || s === 'critical') return 'fail';
	if (s === 'warning' || s === 'caution') return 'warn';
	if (s === 'info' || s === 'notice' || s === 'passed' || s === 'pass' || s === 'valid') return 'ok';
	if (s === 'skipped' || s === 'not_applicable') return 'skip';
	return fallback;
}

/** @param {Json|undefined} s @returns {string} */
export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * `asc validate` answers with `{summary, remediation:{totalActionable, steps}, checks}`.
 * `remediation.steps` is `checks` already sorted into fix order (blocking first, then
 * by `order`), so it is what we fold in — the first row is the next thing to do.
 * We still fall back to `checks` in case a future asc drops the plan.
 * @param {Json|undefined} payload
 * @returns {JsonArray}
 */
export function validationItems(payload) {
	const obj = isJsonObject(payload) ? payload : null;
	const data = isJsonObject(obj?.data) ? obj.data : null;
	const root = data?.attributes ?? data ?? payload;
	if (!root) return [];
	if (Array.isArray(root)) return root;
	if (!isJsonObject(root)) return [];
	const plan = isJsonObject(root.remediation) ? root.remediation.steps : undefined;
	if (Array.isArray(plan) && plan.length) return plan;
	for (const key of ['checks', 'problems', 'issues', 'errors', 'results']) {
		const rows = root[key];
		if (Array.isArray(rows) && rows.length) return rows;
	}
	return [];
}

/** One validation step/check → {level, name, detail}.
 * @param {Json|undefined} item
 * @param {number} i
 * @returns {{level: Level, name: string, detail: string}}
 */
export function validationRow(item, i) {
	if (typeof item === 'string') return { level: 'fail', name: `#${i + 1}`, detail: clean(item) };
	if (!isJsonObject(item)) return { level: 'fail', name: `#${i + 1}`, detail: '' };
	const name = clean(item.checkId ?? item.id ?? item.check ?? item.field) || `#${i + 1}`;
	const subject = item.resourceType && item.resourceId ? `${item.resourceType} ${item.resourceId}` : null;
	const detail = clean(
		[item.message, item.remediation ? `${SYM.arrow} ${item.remediation}` : null, subject ? `(${subject})` : null]
			.filter(Boolean)
			.join(' '),
	);
	// `blocking` is asc's own verdict on whether this stops a submission; trust it
	// over severity alone. `info` steps are unverifiable-by-API notes, not work.
	const severity = String(item.severity ?? item.level ?? item.status ?? '').toLowerCase();
	const level = item.blocking === true ? 'fail' : severity === 'info' ? 'skip' : levelOf(severity);
	return { level, name, detail };
}

/** @param {Json|undefined} expo @returns {JsonObject|null} */
const infoPlist = (expo) => {
	const root = isJsonObject(expo) ? (expo.expo ?? expo) : expo;
	const plist = isJsonObject(root) ? root.ios : null;
	const entries = isJsonObject(plist) ? plist.infoPlist : null;
	return isJsonObject(entries) ? entries : null;
};

/** The export-compliance answer the Expo config carries, if any.
 * @param {Json|undefined} expo
 * @returns {Json|undefined}
 */
export const encryptionAnswer = (expo) => infoPlist(expo)?.[ENCRYPTION_KEY];

/** True when the Expo config never answers Apple's export compliance question.
 * @param {Json|undefined} expo
 * @returns {boolean}
 */
export function missingEncryptionKey(expo) {
	const value = infoPlist(expo)?.[ENCRYPTION_KEY];
	return value === undefined || value === null || value === '';
}

/** True when the app claims non-exempt encryption but files no compliance code.
 * @param {Json|undefined} expo
 * @returns {boolean}
 */
export function missingComplianceCode(expo) {
	const plist = infoPlist(expo);
	const value = plist?.[ENCRYPTION_KEY];
	return (value === true || value === 'true') && !plist?.[COMPLIANCE_CODE_KEY];
}

/**
 * App Store locales that put the app on an EU storefront. Hard-coded because the
 * DSA trader obligation follows the storefront and Apple exposes no mapping for
 * it. Bare-language codes appear only where every variant Apple offers is an EU
 * country — fr, es and pt are absent on purpose (fr-CA, es-MX, pt-BR are not).
 */
export const EU_LOCALES = new Set([
	'bg', 'ca', 'ca-es', 'cs', 'cs-cz', 'da', 'da-dk', 'de', 'de-at', 'de-de', 'el', 'el-gr', 'es-es', 'et',
	'fi', 'fi-fi', 'fr-fr', 'ga', 'hr', 'hr-hr', 'hu', 'hu-hu', 'it', 'it-it', 'lt', 'lv', 'mt', 'nl', 'nl-be',
	'nl-nl', 'pl', 'pl-pl', 'pt-pt', 'ro', 'ro-ro', 'sk', 'sk-sk', 'sl', 'sv', 'sv-se',
]);

/** The EU-storefront locales in a store.locales list, in the order given.
 * @param {string[]|undefined} locales
 * @returns {string[]}
 */
export function euLocalesIn(locales) {
	return (Array.isArray(locales) ? locales : []).filter((l) => EU_LOCALES.has(String(l).trim().toLowerCase()));
}

/** True when shipping these locales requires a declared EU trader.
 * @param {string[]|undefined} locales
 * @returns {boolean}
 */
export function euTraderRequired(locales) {
	return euLocalesIn(locales).length > 0;
}

// Answers Apple legitimately leaves null (`kidsAgeBand` outside the kids category,
// the override fields) plus JSON:API envelope keys, so neither reads as a gap.
const AGE_RATING_IGNORED = /override|kidsAgeBand|^(type|id|data|links|relationships)$/i;

/**
 * @param {Json|undefined} payload
 * @returns {null|string[]} null when the app has no declaration at all, otherwise
 * the unanswered question names — `[]` means the questionnaire is complete.
 */
export function ageRatingGaps(payload) {
	const obj = isJsonObject(payload) ? payload : null;
	const data = isJsonObject(obj?.data) ? obj.data : null;
	const attrs = data?.attributes ?? obj?.attributes ?? data ?? payload;
	if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
	const questions = Object.keys(attrs).filter((k) => !AGE_RATING_IGNORED.test(k));
	if (!questions.length) return null;
	return questions.filter((k) => attrs[k] === null || attrs[k] === undefined || attrs[k] === '');
}

/** The answered content rights value, or null when the question is unanswered.
 * @param {Json|undefined} payload
 * @returns {string|null}
 */
export function contentRightsAnswer(payload) {
	const obj = isJsonObject(payload) ? payload : null;
	const data = isJsonObject(obj?.data) ? obj.data : null;
	const root = data?.attributes ?? data ?? payload;
	const value = String(
		isJsonObject(root) ? ((root.contentRightsDeclaration ?? root.content_rights_declaration) ?? '') : '',
	)
		.trim()
		.toUpperCase();
	return value && value !== 'NOT_ANSWERED' && value !== 'NONE' ? value : null;
}

/** How many data usages the app declares. Zero is an empty privacy label.
 * @param {Json|undefined} payload
 * @returns {number}
 */
export function privacyDeclarationCount(payload) {
	const data = isJsonObject(payload) ? payload.data : undefined;
	const root = data ?? payload;
	if (Array.isArray(root)) return root.length;
	for (const key of ['declarations', 'dataUsages', 'dataTypes', 'purposes', 'categories', 'privacyDetails']) {
		const rows = isJsonObject(root) ? root[key] : undefined;
		if (Array.isArray(rows)) return rows.length;
	}
	return 0;
}

const UNSUPPORTED = /unknown (sub)?command|unrecognized (sub)?command|not a valid command|no such command/i;
const UNAUTHORIZED =
	/\b40[13]\b|unauthori[sz]ed|forbidden|not authenticated|authentication (failed|required)|no (stored |valid )?credentials|no active session|session (has )?expired|auth login/i;

/** Salvage JSON from asc stdout the way runJSON does, but never throwing.
 * @param {string} text
 * @returns {Json|null}
 */
function parseSalvagedJSON(text) {
	// Its one caller passes `stdout`, which classifyAsc defaults to ''.
	const body = String(text).trim();
	if (!body) return null;
	for (const start of [0, body.search(/[[{]/), body.indexOf('{')]) {
		if (start < 0) continue;
		try {
			return /** @type {Json} */ (JSON.parse(body.slice(start)));
		} catch {
			/* asc occasionally prefixes a banner; try the next candidate */
		}
	}
	return null;
}

/**
 * An asc result → what the row should say. `unsupported` (this asc predates the
 * subcommand) and `unauthorized` (no key for it) are answers, not failures: a
 * preflight that hard-fails because the CLI is a version behind is one nobody runs.
 * Pure, so the tests never spawn asc.
 * @param {{code?: number, stdout?: string, stderr?: string}} [ascResult]
 * @returns {AscResult}
 */
export function classifyAsc({ code = 0, stdout = '', stderr = '' } = {}) {
	const payload = parseSalvagedJSON(stdout);
	if (code === 0) return { state: payload === null ? 'empty' : 'ok', payload, detail: '' };
	const text = `${stdout}\n${stderr}`;
	const detail = clean(text.split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 200);
	if (UNSUPPORTED.test(text)) return { state: 'unsupported', payload: null, detail };
	if (UNAUTHORIZED.test(text)) return { state: 'unauthorized', payload: null, detail };
	return { state: 'error', payload, detail };
}
