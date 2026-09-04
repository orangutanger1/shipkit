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

/** A line that is nothing but an `@type` annotation, and the type it carries.
 * @type {(line: string) => string|null}
 */
function typeAnnotation(line) {
	const m = /^\s*(?:\/\*\*)?\s*\*?\s*@type \{(.*)\}\s*(?:\*\/)?\s*$/.exec(line);
	return m ? m[1] : null;
}

/** Splits at `sep` only where no bracket is open, so a comma inside an object
 * type does not end a parameter.
 * @type {(text: string, sep: string) => string[]}
 */
function splitTop(text, sep) {
	/** @type {string[]} */
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if ('([{'.includes(text[i])) depth++;
		else if (')]}'.includes(text[i])) depth--;
		else if (depth === 0 && text.startsWith(sep, i)) {
			parts.push(text.slice(start, i));
			i += sep.length - 1;
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts.map(trimmed);
}

/** @type {(text: string) => string} */
function trimmed(text) {
	return text.trim();
}

/** @type {(param: string) => string} */
function typeOfParam(param) {
	const parts = splitTop(param, ':');
	return parts.length > 1 ? parts.slice(1).join(':') : param;
}

/**
 * A JSDoc arrow type carries exactly what a TypeScript signature needs: the
 * parameter types in order, and the return type.
 * @type {(type: string) => {params: string[], ret: string}|null}
 */
function arrowParts(type) {
	const parts = splitTop(type, '=>');
	const head = parts[0] ?? '';
	if (parts.length !== 2 || !head.startsWith('(') || !head.endsWith(')')) return null;
	const inner = head.slice(1, -1).trim();
	return { params: inner ? splitTop(inner, ',').map(typeOfParam) : [], ret: parts[1] };
}

/** A parameter may carry a default, and TypeScript wants the type before it.
 * @type {(name: string, type: string) => string}
 */
function typedParam(name, type) {
	const [binding, ...rest] = splitTop(name, '=');
	return rest.length ? `${binding}: ${type} = ${rest.join('=')}` : `${binding}: ${type}`;
}

/** @type {(line: string) => boolean} */
function isFunctionDecl(line) {
	return /^(export )?function [A-Za-z0-9_$]+\(.*\) \{$/.test(line);
}

/**
 * Rewrites `function f(a, b) {` into `function f(a: A, b: B): R {`. An arity
 * the annotation does not match is left alone rather than mistyped — the
 * generated modules are compiled by test/design-typecheck.test.mjs, so a
 * declaration this does not recognise fails there instead of shipping.
 * @type {(decl: string, arrow: {params: string[], ret: string}) => string}
 */
function annotate(decl, arrow) {
	const open = decl.indexOf('(');
	const close = decl.lastIndexOf(')');
	const inner = decl.slice(open + 1, close).trim();
	const names = inner ? splitTop(inner, ',') : [];
	if (names.length !== arrow.params.length) return decl;
	/** @type {string[]} */
	const typed = [];
	for (let i = 0; i < names.length; i++) typed.push(typedParam(names[i], arrow.params[i]));
	return `${decl.slice(0, open)}(${typed.join(', ')}): ${arrow.ret}${decl.slice(close + 1)}`;
}

/** @type {(line: string) => boolean} */
function isStrippedImport(line) {
	return /^import .* from '\.\/[a-z-]+\.mjs';$/.test(line);
}

/** An annotation that was the whole JSDoc block leaves an empty one behind.
 * @type {(lines: string[]) => string[]}
 */
function withoutEmptyDoc(lines) {
	/** @type {string[]} */
	const out = [];
	for (const line of lines) {
		if (/^\s*\*\/\s*$/.test(line) && /^\s*\/\*\*\s*$/.test(out.at(-1) ?? '')) out.pop();
		else out.push(line);
	}
	return out;
}

/**
 * The sanitizer, emitted. Shipkit types it in JSDoc, which TypeScript ignores
 * once the file is `.ts`, so every annotation is translated onto the
 * declaration itself, and an inline const cast becomes an `as const`. The one
 * relative .mjs import goes: the app repo does not have lib/ on its path.
 * @type {(src: string, opts: {source: string}) => string}
 */
export function emitQaParams(src, { source }) {
	/** @type {string[]} */
	const out = [];
	/** @type {{params: string[], ret: string}|null} */
	let pending = null;
	for (const line of src.split('\n')) {
		const type = typeAnnotation(line);
		if (type !== null) pending = arrowParts(type);
		else if (!isTypeComment(line) && !isStrippedImport(line)) {
			out.push(pending && isFunctionDecl(line) ? annotate(line, pending) : line);
			if (isFunctionDecl(line)) pending = null;
		}
	}
	return withHeader(asTypeScript(withoutEmptyDoc(out).join('\n')), { source });
}

/** @type {(body: string) => string} */
function asTypeScript(body) {
	return body
		.replace(/\/\*\* @type \{const\} \*\/ \(([^)]*)\)/g, '$1 as const')
		.replace(/\/\*\* @type \{[^}]*\} \*\/ \(([^)]*)\)/g, '$1');
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
