// design/system.json → src/theme/tokens.ts, the one file in a generated app
// allowed to contain literals.
//
// DEFAULT_SYSTEM is what `ship new` emits from before design/system.json
// exists. It is a shipkit constant and is never written to the app's
// design/ directory: `ship design system` still drafts, still omits colour, and
// still refuses until an author chooses a hue. The scaffold needs something to
// render; it does not need shipkit to have picked its brand.
import { withHeader } from './design-emit.mjs';
import { PLATFORM_RAMP } from './design-draft.mjs';

/** @type {(value: any, cite?: string) => {value: any, cite: string}} */
const t = (value, cite = 'HIG:color') => ({ value, cite });

/** The scaffold's palette — the greys and blue templates/app has always rendered. */
const LIGHT = {
	background: t('#ffffff'), surface: t('#f6f7f8'), surfaceAlt: t('#eceef0'),
	text: t('#0f1113'), textMuted: t('#5b6472'), textInverse: t('#ffffff'),
	accent: t('#2a5fd6'), accentText: t('#ffffff'), border: t('#d8dce0'),
	success: t('#1f8a4c'), warning: t('#9a6700'), danger: t('#c8102e'),
};
const DARK = {
	background: t('#0f1113'), surface: t('#17191c'), surfaceAlt: t('#212429'),
	text: t('#f6f7f8'), textMuted: t('#9aa3ab'), textInverse: t('#0f1113'),
	accent: t('#6f9dff'), accentText: t('#0f1113'), border: t('#2c3036'),
	success: t('#4ad07f'), warning: t('#e5b74a'), danger: t('#ff6b7f'),
};

/** A complete system, so `ship new` produces an app that boots and is legible. */
export const DEFAULT_SYSTEM = {
	brand: { name: 'app', direction: 'Neutral and legible: the scaffold has no opinion yet.' },
	color: { accentHue: 219, themes: { light: LIGHT, dark: DARK } },
	type: { family: { text: 'System' }, ramp: PLATFORM_RAMP.map(citeStep) },
	spacing: { base: 4, scale: [0, 4, 8, 12, 16, 24, 32, 48], cite: 'HIG:layout' },
	radii: { sm: t(8, 'HIG:layout'), md: t(12, 'HIG:layout'), lg: t(16, 'HIG:layout') },
	motion: {
		durations: { fast: t(150, 'HIG:motion'), base: t(250, 'HIG:motion'), slow: t(350, 'HIG:motion') },
		curves: { standard: t('cubic-bezier(0.2, 0, 0, 1)', 'HIG:motion') },
		reducedMotion: 'Cross-fade at 100ms and hold final positions; no translation, scale or parallax.',
	},
};

/** Named rather than inline so c8's fnMap registers it — an anonymous callback reads as never-hit.
 * @type {(step: any) => any}
 */
function citeStep(step) {
	return { ...step, cite: 'HIG:typography' };
}

/** @type {(value: string) => string} */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** @type {(theme: any) => string} */
function themeBlock(theme) {
	const rows = Object.entries(theme ?? {}).map(colorRow);
	return `{\n${rows.join('\n')}\n\t\t}`;
}

/** @type {(entry: [string, any]) => string} */
function colorRow([name, token]) {
	return `\t\t\t${name}: ${q(token?.value)},`;
}

/** @type {(step: any) => string} */
function rampRow(step) {
	const tracking = step?.tracking === undefined ? '' : `, letterSpacing: ${step.tracking}`;
	return `\t\t${step.name}: { size: ${step.size}, lineHeight: ${step.lineHeight}, weight: ${q(String(step.weight))}${tracking} },`;
}

/** @type {(entry: [string, any]) => string} */
function numberRow([name, token]) {
	return `\t\t${name}: ${typeof token?.value === 'number' ? token.value : q(token?.value)},`;
}

/**
 * The token module. Ordering follows the declared ramp and sorted keys rather
 * than parse order, so the same system.json always produces the same bytes.
 * @type {(system: any, opts: {source: string}) => string}
 */
export function emitTokens(system, { source }) {
	const themes = Object.entries(system?.color?.themes ?? {}).sort(byKey);
	const colors = themes.map(themeRow).join('\n');
	const ramp = (system?.type?.ramp ?? []).map(rampRow).join('\n');
	const radii = Object.entries(system?.radii ?? {}).sort(byKey).map(numberRow).join('\n');
	const durations = Object.entries(system?.motion?.durations ?? {}).sort(byKey).map(numberRow).join('\n');
	const curves = Object.entries(system?.motion?.curves ?? {}).sort(byKey).map(numberRow).join('\n');
	const body = `export const tokens = {
	color: {
${colors}
	},
	type: {
${ramp}
	},
	fontFamily: ${q(system?.type?.family?.text ?? 'System')},
	spacing: [${(system?.spacing?.scale ?? []).join(', ')}],
	radii: {
${radii}
	},
	duration: {
${durations}
	},
	curve: {
${curves}
	},
} as const;

export type ThemeName = keyof typeof tokens.color;
export type ColorToken = keyof typeof tokens.color.light;
export type TypeRole = keyof typeof tokens.type;
`;
	return withHeader(body, { source });
}

/** @type {(a: [string, any], b: [string, any]) => number} */
function byKey(a, b) {
	return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** @type {(entry: [string, any]) => string} */
function themeRow([name, theme]) {
	return `\t\t${name}: ${themeBlock(theme)},`;
}
