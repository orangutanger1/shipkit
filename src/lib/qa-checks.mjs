// The Tier 1 rules, as arithmetic over one screen's measurements.
//
// Every rule here answers a question a reviewer would otherwise answer by
// squinting, and every one of them declares `requiresTier: 1` — because a web
// capture genuinely proves it. Motion, native navigation semantics and
// VoiceOver do not appear in this file at all; they are Tier 2's, and a Tier 1
// run reports them SKIPPED rather than inventing a verdict. See lib/qa-run.mjs.
//
// Spacing rhythm is deliberately absent too: `ship design review` already gates
// spacing literals against the declared series, lexically and at source. Two
// gates answering the same question is two verdicts to reconcile.
import { contrast } from './color.mjs';
import { cellId } from './qa-matrix.mjs';

/** HIG: the minimum comfortable hit target, in points. */
export const TAP_MIN = 44;
/** WCAG 2.1 AA: 4.5:1 for body text, 3:1 once it is large. */
export const CONTRAST_BODY = 4.5;
export const CONTRAST_LARGE = 3;
/** iPhone Pro portrait insets, in points — the capture viewport's device. */
const SAFE_AREA = { top: 47, bottom: 34 };

/** @typedef {import('./qa-matrix.mjs').Cell} Cell */
/** @typedef {{id: string, category: string, requiresTier: number, status: string, screen?: string, flow?: string, message?: string, evidence?: string[], measured?: number|string|null, threshold?: number|string|null}} Check */

/**
 * One check row, pre-filled from the cell it came from. `evidence` is the
 * capture path: a FAIL nobody can look at is an assertion, not a finding.
 * @type {(cell: Cell, id: string, category: string, fields: Partial<Check>, evidence?: string) => Check}
 */
function row(cell, id, category, fields, evidence) {
	return {
		id: `${category}-${id}`,
		category,
		requiresTier: 1,
		screen: cell.screen,
		...(cell.flow ? { flow: cell.flow } : {}),
		...(evidence ? { evidence: [evidence] } : {}),
		status: 'PASS',
		...fields,
	};
}

/** WCAG's own large-text threshold: 24px, or 18.66px once bold.
 * @type {(text: {size: number, weight: number}) => number}
 */
export function requiredContrast({ size, weight }) {
	return size >= 24 || (size >= 18.66 && weight >= 700) ? CONTRAST_LARGE : CONTRAST_BODY;
}

/** Nothing may extend past the viewport horizontally. A phone does not pan.
 * @type {(obs: any, cell: Cell, evidence?: string) => Check}
 */
export function checkLayout(obs, cell, evidence) {
	const over = Number(obs?.overflowX ?? 0);
	return row(cell, cellId(cell), 'layout', over > 1
		? { status: 'FAIL', measured: over, threshold: 0, message: `${over}pt wider than the viewport — the screen scrolls sideways` }
		: { measured: over, threshold: 0 }, evidence);
}

/** The smallest tappable box on the screen, against the HIG minimum.
 * @type {(obs: any, cell: Cell, evidence?: string) => Check}
 */
export function checkTapTargets(obs, cell, evidence) {
	const boxes = obs?.tappables ?? [];
	if (!boxes.length)
		return row(cell, cellId(cell), 'tap-target', { status: 'WARN', message: 'no tappable element found — either the screen is inert or the build does not mark its controls' }, evidence);
	const worst = boxes.reduce((/** @type {any} */ a, /** @type {any} */ b) => (Math.min(b.w, b.h) < Math.min(a.w, a.h) ? b : a));
	const size = Math.min(worst.w, worst.h);
	return row(cell, cellId(cell), 'tap-target', size < TAP_MIN
		? { status: 'FAIL', measured: size, threshold: TAP_MIN, message: `"${worst.label}" is ${worst.w}×${worst.h}pt` }
		: { measured: size, threshold: TAP_MIN }, evidence);
}

/** The least legible text run on the screen, against WCAG AA.
 * @type {(obs: any, cell: Cell, evidence?: string) => Check}
 */
export function checkContrast(obs, cell, evidence) {
	let worst = null;
	for (const text of obs?.texts ?? []) {
		const ratio = contrast(text.fg, text.bg);
		if (ratio === null) continue;
		const deficit = ratio - requiredContrast(text);
		if (!worst || deficit < worst.deficit) worst = { text, ratio, deficit };
	}
	if (!worst)
		return row(cell, cellId(cell), 'contrast', { status: 'WARN', message: 'no text with a resolvable foreground and background' }, evidence);
	const need = requiredContrast(worst.text);
	return row(cell, cellId(cell), 'contrast', worst.deficit < 0
		? { status: 'FAIL', measured: worst.ratio, threshold: need, message: `"${worst.text.label}" reads ${worst.ratio}:1 at ${worst.text.size}pt` }
		: { measured: worst.ratio, threshold: need }, evidence);
}

/** No control may sit under the notch or the home indicator.
 * @type {(obs: any, cell: Cell, evidence?: string, insets?: {top: number, bottom: number}) => Check}
 */
export function checkSafeArea(obs, cell, evidence, insets = SAFE_AREA) {
	const height = Number(obs?.view?.h ?? 0);
	const intruding = (obs?.tappables ?? []).filter((/** @type {any} */ b) => b.y < insets.top || b.y + b.h > height - insets.bottom);
	return row(cell, cellId(cell), 'safe-area', intruding.length
		? {
			status: 'FAIL',
			measured: intruding.length,
			threshold: 0,
			message: `${intruding.length} control(s) under the notch or home indicator, starting with "${intruding[0].label}"`,
		}
		: { measured: 0, threshold: 0 }, evidence);
}

/**
 * Text the layout could not hold. At the default step that is a plain layout
 * bug; at a larger step it is the Dynamic Type failure this tier exists to
 * find, so it is reported under the category that names the cause.
 * @type {(obs: any, cell: Cell, evidence?: string) => Check}
 */
export function checkClipping(obs, cell, evidence) {
	const category = cell.dynamicType === 'default' ? 'layout' : 'dynamic-type';
	const clipped = obs?.clipped ?? [];
	return row(cell, `${cellId(cell)}-clipped`, category, clipped.length
		? {
			status: 'FAIL',
			measured: clipped.length,
			threshold: 0,
			message: `"${clipped[0].label}" is clipped by ${clipped[0].over}pt at Dynamic Type ${cell.dynamicType}`,
		}
		: { measured: 0, threshold: 0 }, evidence);
}

/**
 * Rendered font sizes against the declared ramp. Only at the default step —
 * every other step scales the ramp, so a mismatch there proves nothing.
 * @type {(obs: any, cell: Cell, system: any, evidence?: string) => Check|null}
 */
export function checkTypeRamp(obs, cell, system, evidence) {
	const ramp = new Set((system?.type?.ramp ?? []).map((/** @type {any} */ s) => s?.size));
	if (cell.dynamicType !== 'default' || !ramp.size) return null;
	const off = [...new Set((obs?.texts ?? []).map((/** @type {any} */ t) => t.size).filter((/** @type {number} */ s) => s && !ramp.has(s)))];
	return row(cell, cellId(cell), 'typography', off.length
		? { status: 'WARN', measured: off.length, threshold: 0, message: `${off.join(', ')}pt rendered but not in the type ramp` }
		: { measured: 0, threshold: 0 }, evidence);
}

/**
 * Every per-screen rule, over one observation.
 * @type {(obs: any, cell: Cell, opts?: {system?: any, evidence?: string}) => Check[]}
 */
export function checkObservation(obs, cell, { system = null, evidence } = {}) {
	if (obs?.blank)
		return [row(cell, cellId(cell), 'state', { status: 'FAIL', message: `${cell.route} rendered no text at all — the route is missing or the build never mounted` }, evidence)];
	return [
		checkLayout(obs, cell, evidence),
		checkTapTargets(obs, cell, evidence),
		checkContrast(obs, cell, evidence),
		checkSafeArea(obs, cell, evidence),
		checkClipping(obs, cell, evidence),
		checkTypeRamp(obs, cell, system, evidence),
	].filter((/** @type {Check|null} */ check) => check !== null);
}
