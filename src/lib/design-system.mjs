// The token gate. Handed a parsed `design/system.json`, it returns issues —
// no disk, no network, so `ship design system --check`, `ship design review`
// and the tests all run the same arithmetic over the same shapes.
//
// Nothing here has taste. It cannot tell you the accent suits the category;
// it can only prove that whatever was chosen is legible, consistent, cited,
// and singular. That floor is most of what "designed" means from outside.
import { contrast, hueDistance, hueOf, parseHex } from './color.mjs';

/** WCAG AA: body text, and the relaxed bar for large text and non-text UI. */
export const MIN_CONTRAST = 4.5;
export const MIN_CONTRAST_LARGE = 3;

/** Over this, a transition reads as slow rather than as motion. */
export const MAX_DURATION_MS = 400;

/** How far a chrome colour may sit from the accent hue before it is a second accent. */
const HUE_TOLERANCE = 20;

/** Roles that carry the app's neutrals. They may be tinted toward the accent, not away from it. */
const CHROME = ['background', 'surface', 'surfaceAlt', 'text', 'textMuted', 'textInverse', 'border'];

/** Roles whose hue is their meaning, so they are exempt from the single-accent rule. */
const SEMANTIC = ['success', 'warning', 'danger'];

/**
 * Foreground/background pairs every theme owes, and the bar each must clear.
 * Text takes the AA body bar; accent and status colours are non-text UI at 3:1.
 * `border` is deliberately absent — a separator is decorative, and a gate that
 * fails every real iOS palette is a gate somebody switches off.
 * @type {{fg: string, bg: string, min: number}[]}
 */
export const CONTRAST_PAIRS = [
	{ fg: 'text', bg: 'background', min: MIN_CONTRAST },
	{ fg: 'text', bg: 'surface', min: MIN_CONTRAST },
	{ fg: 'text', bg: 'surfaceAlt', min: MIN_CONTRAST },
	{ fg: 'textMuted', bg: 'background', min: MIN_CONTRAST },
	{ fg: 'textMuted', bg: 'surface', min: MIN_CONTRAST },
	{ fg: 'accentText', bg: 'accent', min: MIN_CONTRAST },
	{ fg: 'textInverse', bg: 'text', min: MIN_CONTRAST },
	{ fg: 'accent', bg: 'background', min: MIN_CONTRAST_LARGE },
	{ fg: 'success', bg: 'background', min: MIN_CONTRAST_LARGE },
	{ fg: 'warning', bg: 'background', min: MIN_CONTRAST_LARGE },
	{ fg: 'danger', bg: 'background', min: MIN_CONTRAST_LARGE },
];

/** @type {(theme: any, role: string) => string|undefined} */
const valueOf = (theme, role) => theme?.[role]?.value;

/**
 * Every `cite` in the document, with the path it was found at, so an issue can
 * say which token is uncited rather than that one of them is.
 * @type {(node: any, at?: string) => {at: string, cite: unknown}[]}
 */
export function citations(node, at = '') {
	if (!node || typeof node !== 'object') return [];
	if (Array.isArray(node)) return node.flatMap((v, i) => citations(v, `${at}[${i}]`));
	/** @type {{at: string, cite: unknown}[]} */
	const out = [];
	if ('cite' in node) out.push({ at: at || '(root)', cite: node.cite });
	for (const [key, value] of Object.entries(node)) {
		if (key === 'cite' || key.startsWith('_')) continue;
		out.push(...citations(value, at ? `${at}.${key}` : key));
	}
	return out;
}

/**
 * A citation is honoured when it names a HIG rule, or a reference or claim the
 * research run actually holds. `known` empty means no run was loaded, and an
 * unresolvable id is then unprovable rather than wrong — the check downgrades
 * to shape alone rather than failing every token.
 * @type {(system: any, known: Set<string>) => string[]}
 */
export function checkCitations(system, known) {
	/** @type {string[]} */
	const issues = [];
	for (const { at, cite } of citations(system)) {
		const id = String(cite ?? '');
		if (id.startsWith('HIG:')) continue;
		if (!known.size) continue;
		if (!known.has(id)) issues.push(`${at}: cites ${id || '(nothing)'}, which is not a reference or claim in the research run`);
	}
	return issues;
}

/**
 * Exactly one accent hue, enforced against the pixels rather than the label:
 * the declared `accentHue` has to be the hue the accent swatch actually is, and
 * no chrome role may wander off it. Multiple accents is the most reliable tell
 * of a generated interface, which is why it is arithmetic here.
 * @type {(color: any) => string[]}
 */
export function checkAccent(color) {
	/** @type {string[]} */
	const issues = [];
	const declared = color?.accentHue;
	for (const [name, theme] of Object.entries(color?.themes ?? {})) {
		const accent = hueOf(valueOf(theme, 'accent'));
		if (accent === null) issues.push(`color.themes.${name}.accent: has no hue — an achromatic accent is not an accent`);
		else if (typeof declared === 'number' && hueDistance(accent, declared) > HUE_TOLERANCE)
			issues.push(`color.themes.${name}.accent: hue ${accent}° is ${hueDistance(accent, declared)}° from the declared accentHue ${declared}°`);
		for (const role of CHROME) {
			const hue = hueOf(valueOf(theme, role));
			if (hue === null || typeof declared !== 'number') continue;
			if (hueDistance(hue, declared) > HUE_TOLERANCE)
				issues.push(`color.themes.${name}.${role}: hue ${hue}° is a second accent — tint neutrals toward accentHue ${declared}° or make them grey`);
		}
	}
	return issues;
}

/**
 * Contrast for every pair in {@link CONTRAST_PAIRS}, in both themes. Dark mode
 * is checked identically and independently: it is not the light theme
 * inverted, and it is where an untested palette fails.
 * @type {(color: any) => string[]}
 */
export function checkContrast(color) {
	/** @type {string[]} */
	const issues = [];
	for (const [name, theme] of Object.entries(color?.themes ?? {})) {
		for (const { fg, bg, min } of CONTRAST_PAIRS) {
			const ratio = contrast(valueOf(theme, fg), valueOf(theme, bg));
			if (ratio === null) continue;
			if (ratio < min) issues.push(`color.themes.${name}: ${fg} on ${bg} is ${ratio}:1, under the ${min}:1 bar`);
		}
		for (const role of [...CHROME, ...SEMANTIC, 'accent', 'accentText'])
			if (role in (theme ?? {}) && !parseHex(valueOf(theme, role)))
				issues.push(`color.themes.${name}.${role}: "${valueOf(theme, role)}" is not a #rrggbb colour`);
	}
	return issues;
}

/**
 * One spacing series, ascending, every step a multiple of the base. A layout
 * that mixes a 4pt series with a 6pt one reads as noisy and nobody can say why.
 * @type {(spacing: any) => string[]}
 */
export function checkSpacing(spacing) {
	/** @type {string[]} */
	const issues = [];
	const base = spacing?.base;
	const scale = Array.isArray(spacing?.scale) ? spacing.scale : [];
	for (const [i, step] of scale.entries()) {
		if (typeof base === 'number' && step % base !== 0)
			issues.push(`spacing.scale[${i}]: ${step} is not a multiple of the ${base}pt base`);
		if (i && step <= scale[i - 1]) issues.push(`spacing.scale[${i}]: ${step} does not increase on ${scale[i - 1]}`);
	}
	return issues;
}

/**
 * A ramp is a ramp: ordered one way, every step doing a job no other step does.
 *
 * Sizes are checked non-strictly, because Apple's own ramp puts headline and
 * body both at 17pt and separates them by weight. What is refused is two steps
 * that agree on *both* — those are one step with two names, and 16/17/18 with
 * one weight is three steps doing one job.
 * @type {(type: any) => string[]}
 */
export function checkType(type) {
	/** @type {string[]} */
	const issues = [];
	const ramp = Array.isArray(type?.ramp) ? type.ramp : [];
	const names = new Set();
	const steps = new Set();
	for (const [i, step] of ramp.entries()) {
		const at = `type.ramp[${i}] "${step?.name ?? '?'}"`;
		if (names.has(step?.name)) issues.push(`${at}: duplicate step name`);
		names.add(step?.name);
		const shape = `${step?.size}/${step?.weight}`;
		if (steps.has(shape)) issues.push(`${at}: ${step?.size}pt at weight ${step?.weight} is already a step — two names for one step`);
		steps.add(shape);
		if (step?.lineHeight < step?.size) issues.push(`${at}: lineHeight ${step.lineHeight} is under its size ${step.size}`);
	}
	/** @type {number[]} */
	const sizes = ramp.map((/** @type {any} */ s) => s?.size);
	const rising = sizes.every((v, i) => !i || v >= sizes[i - 1]);
	const falling = sizes.every((v, i) => !i || v <= sizes[i - 1]);
	if (ramp.length > 1 && !rising && !falling) issues.push('type.ramp: sizes are not monotonic — a ramp that goes back on itself has no order');
	return issues;
}

/**
 * Motion that stays out of the way, plus the one question an implementing
 * agent will otherwise answer by animating anyway.
 * @type {(motion: any) => string[]}
 */
export function checkMotion(motion) {
	/** @type {string[]} */
	const issues = [];
	for (const [name, step] of Object.entries(motion?.durations ?? {}))
		if (/** @type {any} */ (step)?.value > MAX_DURATION_MS)
			issues.push(`motion.durations.${name}: ${/** @type {any} */ (step).value}ms is over the ${MAX_DURATION_MS}ms bar — it will read as slow, not as motion`);
	if (!String(motion?.reducedMotion ?? '').trim())
		issues.push('motion.reducedMotion: missing — with no answer here the implementation will animate regardless of the OS setting');
	return issues;
}

/**
 * Every token check, in the order a reader wants them.
 * @type {(system: any, opts?: {known?: Set<string>}) => string[]}
 */
export function checkSystem(system, { known = new Set() } = {}) {
	if (Array.isArray(system?._todo) && system._todo.length)
		return [`system.json is still a draft — fill ${system._todo.join(', ')} and drop _todo`];
	return [
		...checkCitations(system, known),
		...checkAccent(system?.color),
		...checkContrast(system?.color),
		...checkSpacing(system?.spacing),
		...checkType(system?.type),
		...checkMotion(system?.motion),
	];
}
