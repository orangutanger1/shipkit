// Rules that need more than one capture, plus the report they all land in.
//
// The per-screen rules in lib/qa-checks.mjs each look at one observation. The
// interesting Tier 1 failures do not live there: a screen that ignores the
// theme parameter looks perfect in isolation and is broken; a declared state
// that renders the default screen passes every measurement it is given.
//
// The tier discipline is enforced here and nowhere else. `tier2Rows` emits
// motion, native and accessibility as SKIPPED for every screen, and `mergeTier2`
// is the only thing that can turn one of those into a PASS — which requires an
// actual Tier 2 artifact. There is no code path from a Tier 1 run to a Tier 2
// PASS, which is the whole point of the two tiers being written down.
import { cellId } from './qa-matrix.mjs';

/** @typedef {import('./qa-matrix.mjs').Cell} Cell */
/** @typedef {import('./qa-checks.mjs').Check} Check */
/** @typedef {{cell: Cell, obs: any, file?: string, sha256?: string}} Capture */

/** A capture path as the schema wants it: a list, empty rather than [undefined].
 * @type {(file?: string) => string[]}
 */
const evidenceOf = (file) => (file ? [file] : []);

/** Categories only the macOS lane can answer, and the screen-level id each gets. */
export const TIER2 = /** @type {const} */ (['motion', 'native', 'accessibility']);

/** What a screen renders, as a string — the join key for "did this actually change". */
const contentPrint = (/** @type {any} */ obs) => (obs?.texts ?? []).map((/** @type {any} */ t) => t.label).join('|');
/** What a screen is painted in, as a string. */
const colorPrint = (/** @type {any} */ obs) => (obs?.texts ?? []).map((/** @type {any} */ t) => `${t.fg}/${t.bg}`).join('|');

/** @type {(caps: Capture[], key: (c: Capture) => string) => Map<string, Capture[]>} */
function groupBy(caps, key) {
	/** @type {Map<string, Capture[]>} */
	const out = new Map();
	for (const cap of caps) {
		const k = key(cap);
		out.set(k, [...(out.get(k) ?? []), cap]);
	}
	return out;
}

/**
 * Every state the spec declares was captured, and rendered something other than
 * the default screen. An empty state that is byte-identical to the populated one
 * is an unbuilt state, and it is the single most common thing missing from a
 * generated app.
 * @type {(caps: Capture[], spec: any) => Check[]}
 */
export function checkStates(caps, spec) {
	/** @type {Check[]} */
	const out = [];
	const byScreen = groupBy(caps, (c) => c.cell.screen);
	for (const screen of spec?.screens ?? []) {
		const shots = byScreen.get(screen?.id) ?? [];
		const base = shots.find((c) => c.cell.state === 'default');
		for (const state of screen?.states ?? []) {
			if (state === 'default') continue;
			const id = `state-${screen.id}-${state}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
			const shot = shots.find((c) => c.cell.state === state);
			const common = { id, category: 'state', requiresTier: 1, screen: screen.id, flow: screen.flow };
			if (!shot) out.push({ ...common, status: 'FAIL', message: `the "${state}" state was never captured` });
			else if (base && contentPrint(shot.obs) === contentPrint(base.obs))
				out.push({ ...common, status: 'FAIL', evidence: evidenceOf(shot.file), message: `the "${state}" state renders the same content as the default state` });
			else out.push({ ...common, status: 'PASS', evidence: evidenceOf(shot.file) });
		}
	}
	return out;
}

/**
 * Both themes were captured and they are actually different colours. A build
 * that ignores `qaTheme` fails here rather than passing every other rule twice.
 * @type {(caps: Capture[]) => Check[]}
 */
export function checkDarkMode(caps) {
	/** @type {Check[]} */
	const out = [];
	const defaults = caps.filter((c) => c.cell.state === 'default' && c.cell.dynamicType === 'default');
	for (const [key, shots] of groupBy(defaults, (c) => `${c.cell.screen}-${c.cell.locale}`)) {
		const light = shots.find((c) => c.cell.theme === 'light');
		const dark = shots.find((c) => c.cell.theme === 'dark');
		if (!light || !dark) continue;
		const id = `dark-mode-${key}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
		const common = { id, category: 'dark-mode', requiresTier: 1, screen: light.cell.screen, flow: light.cell.flow };
		const same = colorPrint(light.obs) === colorPrint(dark.obs);
		out.push(same
			? { ...common, status: 'FAIL', evidence: evidenceOf(dark.file), message: 'dark mode paints the same colours as light — the theme parameter is not wired' }
			: { ...common, status: 'PASS', evidence: evidenceOf(dark.file) });
	}
	return out;
}

/** One capture against its baseline hash.
 * @type {(cap: Capture, baseline: Record<string, string>|null) => Check}
 */
function regressionRow(cap, baseline) {
	const key = cellId(cap.cell);
	const common = { id: `regression-${key}`, category: 'regression', requiresTier: 1, screen: cap.cell.screen, flow: cap.cell.flow };
	if (!baseline) return { ...common, status: 'SKIPPED', message: 'no baseline recorded — run `ship qa baseline` once this version looks right' };
	const was = baseline[key];
	if (!was) return { ...common, status: 'WARN', message: 'new capture, absent from the baseline' };
	return was === cap.sha256
		? { ...common, status: 'PASS', measured: cap.sha256 ?? null }
		: { ...common, status: 'WARN', measured: cap.sha256 ?? null, threshold: was, evidence: evidenceOf(cap.file), message: 'differs from the baseline capture' };
}

/**
 * Captures against the recorded baseline. No baseline is SKIPPED, never PASS:
 * a regression check that has nothing to compare against has proven nothing.
 * @type {(caps: Capture[], baseline: Record<string, string>|null) => Check[]}
 */
export function checkRegression(caps, baseline) {
	return caps.map((cap) => regressionRow(cap, baseline));
}

/**
 * The Tier 2 placeholders. Every screen gets one row per category the macOS
 * lane owns, so the report states what was not proven instead of omitting it.
 * @type {(spec: any) => Check[]}
 */
export function tier2Rows(spec) {
	/** @type {Check[]} */
	const out = [];
	for (const screen of spec?.screens ?? [])
		for (const category of TIER2)
			out.push({
				id: `${category}-${screen.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
				category,
				requiresTier: 2,
				status: 'SKIPPED',
				screen: screen.id,
				flow: screen.flow,
				message: 'Tier 2 did not run — no macOS simulator artifact for this version.',
			});
	return out;
}

/**
 * Fold a Tier 2 artifact in. Only a row that artifact actually carries replaces
 * its placeholder; everything else stays SKIPPED.
 * @type {(checks: Check[], tier2: any) => Check[]}
 */
export function mergeTier2(checks, tier2) {
	const supplied = new Map((tier2?.checks ?? []).filter((/** @type {any} */ c) => c?.requiresTier === 2).map((/** @type {any} */ c) => [c.id, c]));
	return checks.map((check) => (check.requiresTier === 2 && supplied.has(check.id) ? supplied.get(check.id) : check));
}

/** @type {(checks: Check[]) => {pass: number, warn: number, fail: number, skipped: number}} */
export function summarize(checks) {
	/** @type {(status: string) => number} */
	const count = (status) => checks.filter((c) => c.status === status).length;
	return { pass: count('PASS'), warn: count('WARN'), fail: count('FAIL'), skipped: count('SKIPPED') };
}

/**
 * The qa-report artifact. Checks are ordered failures first, because the top of
 * the file is what a reader acts on.
 * @type {(args: {version: string, checks: Check[], matrix?: any, tier?: number, now?: Date}) => any}
 */
export function buildReport({ version, checks, matrix, tier = 1, now = new Date() }) {
	const rank = /** @type {Record<string, number>} */ ({ FAIL: 0, WARN: 1, SKIPPED: 2, PASS: 3 });
	const ordered = [...checks].sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
	return {
		version,
		generatedAt: now.toISOString(),
		tier,
		...(matrix ? { matrix } : {}),
		checks: ordered,
		summary: summarize(ordered),
	};
}
