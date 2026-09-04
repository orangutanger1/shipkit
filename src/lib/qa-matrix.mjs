// The Tier 1 capture matrix: which screens, under which conditions, at which URL.
//
// There is no simulator on this host, so Tier 1 drives the app's own RN-Web
// build in headless Chromium. That only works if the build agrees to be driven,
// which is what the query parameters below are: a contract with the generated
// app. It reads them and renders that theme, that state, that text scale.
//
// A build that ignores them still captures cleanly — it just captures the same
// screen N times. The dark-mode and state checks exist to catch exactly that,
// so an unwired app fails the gate rather than passing it vacuously.

/** Query keys the app reads. Renaming one is a breaking change to templates/app. */
const QUERY = { theme: 'qaTheme', state: 'qaState', locale: 'qaLocale', scale: 'qaTextScale' };

/**
 * iOS body point size per Dynamic Type step. Large is the system default, so
 * the scale factor every step reports is its size over Large's 17pt rather than
 * a table of invented multipliers.
 */
export const TYPE_STEPS = {
	xs: 14, s: 15, m: 16, default: 17, l: 17, xl: 19, xxl: 21, xxxl: 23,
	ax1: 28, ax2: 33, ax3: 40, ax4: 47, ax5: 53,
};
const BODY_PT = TYPE_STEPS.default;

/** @typedef {{screen: string, route: string, flow: string, state: string, theme: string, locale: string, dynamicType: string}} Cell */

/**
 * Text scale for a Dynamic Type step; 1 for an unknown step, so a config typo
 * costs a capture at default size rather than an exception mid-run.
 * @type {(step: string) => number}
 */
export function textScale(step) {
	const pt = /** @type {Record<string, number>} */ (TYPE_STEPS)[String(step).toLowerCase()];
	return pt ? Math.round((pt / BODY_PT) * 100) / 100 : 1;
}

/** A cell's stable id — also its capture filename and its check id suffix.
 * @type {(cell: Cell) => string}
 */
export function cellId(cell) {
	return [cell.screen, cell.state, cell.theme, cell.locale, cell.dynamicType]
		.join('-')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * The URL that renders one cell.
 * @type {(base: string, cell: Cell) => string}
 */
export function cellUrl(base, cell) {
	const url = new URL(cell.route, base);
	url.searchParams.set(QUERY.theme, cell.theme);
	url.searchParams.set(QUERY.state, cell.state);
	url.searchParams.set(QUERY.locale, cell.locale);
	url.searchParams.set(QUERY.scale, String(textScale(cell.dynamicType)));
	return url.toString();
}

/**
 * Whether Tier 1 can drive this route. A dynamic segment needs an id the spec
 * does not carry, so the capture would 404 and every rule on that screen would
 * fail for a tooling reason rather than a quality one. A future `qaParams`
 * field on the screen supplying a fixture id is the escape hatch.
 * @type {(route: string) => boolean}
 */
export function isDrivable(route) {
	return !String(route ?? '').includes('[');
}

/**
 * Screens × conditions, without the combinatorial explosion.
 *
 * The full cross product of screens, states, themes, locales and type steps is
 * hundreds of captures for a ten-screen app, and most of them answer nothing:
 * a screen's empty state does not become a different typography problem in dark
 * mode. So the matrix is two planes that intersect at the default cell —
 * appearance is varied over the default state, and the remaining states are
 * captured once at the first theme and default type.
 *
 * @type {(spec: any, matrix?: {themes?: string[], locales?: string[], dynamicType?: string[]}) => Cell[]}
 */
export function planMatrix(spec, { themes = ['light'], locales = ['en-US'], dynamicType = ['default'] } = {}) {
	/** @type {Cell[]} */
	const cells = [];
	const [theme0] = themes;
	const [locale0] = locales;
	for (const screen of spec?.screens ?? []) {
		if (!isDrivable(screen?.route)) continue;
		const at = { screen: screen?.id, route: screen?.route, flow: screen?.flow };
		for (const theme of themes)
			for (const locale of locales)
				for (const step of dynamicType) cells.push({ ...at, state: 'default', theme, locale, dynamicType: step });
		for (const state of screen?.states ?? [])
			if (state !== 'default')
				cells.push({ ...at, state, theme: theme0, locale: locale0, dynamicType: 'default' });
	}
	return cells;
}
