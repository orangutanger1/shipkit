// The three modules a generated app needs that are not tokens and not screens.
//
// events.ts is why `track()` can be typed: an event the spec does not declare
// becomes a typecheck error in the app repo rather than a string nobody joins.
// catalog.ts is why monetization is data rather than a comment somebody has to
// parse. qa-params.ts is the shipkit sanitizer itself, emitted rather than
// re-implemented, so the logic shipkit's tests exercise is the logic that ships.
import { fileURLToPath } from 'node:url';
import { eventName } from './flows.mjs';
import { withHeader } from './design-emit.mjs';

/** The module emitted into the app as src/theme/qa-params.ts. */
export const QA_PARAMS_SOURCE = fileURLToPath(new URL('./qa-params.mjs', import.meta.url));

/** @type {(value: string) => string} */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** @type {(spec: any) => string[]} */
function eventNames(spec) {
	/** @type {Set<string>} */
	const names = new Set();
	for (const screen of spec?.screens ?? [])
		for (const event of screen?.events ?? []) if (event?.name) names.add(event.name);
	return [...names].sort();
}

/** @type {(name: string) => string} */
function eventRow(name) {
	return `\t${name}: ${q(name)},`;
}

/**
 * The event union. Names are still derived by `eventName(flow, verb)` and
 * `checkEvents` already refuses a hand-typed one that disagrees, so the closed
 * flow vocabulary reaches the implementation as a type.
 * @type {(spec: any, opts: {source: string}) => string}
 */
export function emitEvents(spec, { source }) {
	const names = eventNames(spec);
	const body = names.length
		? `export const EVENTS = {\n${names.map(eventRow).join('\n')}\n} as const;\n\nexport type AppEvent = (typeof EVENTS)[keyof typeof EVENTS];\n`
		: 'export const EVENTS = {} as const;\n\nexport type AppEvent = string;\n';
	return withHeader(body, { source });
}

/** @type {(screen: any) => string} */
function catalogRow(screen) {
	const m = screen.monetization;
	const packages = m.packages?.length ? `, packages: [${m.packages.map(q).join(', ')}]` : '';
	return `\t${screen.id}: { offering: ${q(m.offering)}, entitlement: ${q(m.entitlement)}${packages} },`;
}

/** @type {(screen: any) => boolean} */
function sells(screen) {
	return Boolean(screen?.monetization?.offering && screen?.id);
}

/**
 * RevenueCat ids as data. Wiring the SDK is domain logic and stays the agent's;
 * making the ids reachable from the screen, from `ship rc audit` and from a
 * reader is not.
 * @type {(spec: any, opts: {source: string}) => string}
 */
export function emitCatalog(spec, { source }) {
	const rows = (spec?.screens ?? []).filter(sells).sort(byId).map(catalogRow);
	const body = rows.length
		? `export const MONETIZATION = {\n${rows.join('\n')}\n} as const;\n`
		: 'export const MONETIZATION = {} as const;\n';
	return withHeader(body, { source });
}

/** @type {(a: any, b: any) => number} */
function byId(a, b) {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** JSDoc type annotations are shipkit's typing strategy; the app repo has real TypeScript.
 * @type {(line: string) => boolean}
 */
function isTypeComment(line) {
	return /^\s*\/\*\*? ?@(type|typedef|param|returns)/.test(line) || /^\s*\*\s*@(type|typedef|param|returns)/.test(line);
}

/**
 * The sanitizer, emitted. Strips shipkit's JSDoc type lines and its one import,
 * because the app repo types the same values in TypeScript and does not have
 * lib/ on its path.
 * @type {(src: string, opts: {source: string}) => string}
 */
export function emitQaParams(src, { source }) {
	const body = src
		.split('\n')
		.filter(keepLine)
		.join('\n')
		.replace(/\/\*\* @type \{[^}]*\} \*\/ \(([^)]*)\)/g, '$1');
	return withHeader(body, { source });
}

/** @type {(line: string) => boolean} */
function keepLine(line) {
	return !isTypeComment(line) && !/^import .* from '\.\/[a-z-]+\.mjs';$/.test(line);
}

/**
 * The one screen `ship new` scaffolds before design/ux.json exists. It is a
 * real spec run through the real emitter, not a second template — that is what
 * keeps one authority for every generated file.
 */
export const DEFAULT_SPEC = {
	screens: [{
		id: 'home',
		route: '/',
		flow: 'home',
		purpose: 'The scaffold renders and proves the toolchain works end to end.',
		copy: { title: 'app', subtitle: 'Scaffolded by shipkit. Run `ship design spec` to describe the real screens.' },
		states: ['default'],
		events: [{ name: eventName('home', 'viewed'), flow: 'home', verb: 'viewed', when: 'on mount' }],
		elements: [
			{ component: 'Text', variant: 'largeTitle', copy: 'title' },
			{ component: 'Text', variant: 'body', copy: 'subtitle' },
		],
	}],
	flows: [{ id: 'home', screens: ['home'], success: 'The app renders its first screen.' }],
};
