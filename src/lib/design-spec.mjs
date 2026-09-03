// The screen gate. `design/ux.json` is the sole contract handed to whatever
// implements the app, so every check here asks the same question: is there a
// decision left in this file for the implementation to make? Anything it can
// improvise, it will.
import { eventName, isFlow } from './flows.mjs';

/**
 * Screens must be reachable and distinct, and their routes are what `ship qa`
 * drives — two screens on one route means one of them is never captured.
 * @type {(spec: any) => string[]}
 */
export function checkScreens(spec) {
	/** @type {string[]} */
	const issues = [];
	const ids = new Set();
	const routes = new Map();
	for (const screen of spec?.screens ?? []) {
		const at = `screen "${screen?.id ?? '?'}"`;
		if (ids.has(screen?.id)) issues.push(`${at}: duplicate screen id`);
		ids.add(screen?.id);
		const seen = routes.get(screen?.route);
		if (seen) issues.push(`${at}: route ${screen.route} is already screen "${seen}"`);
		routes.set(screen?.route, screen?.id);
		if (!Object.keys(screen?.copy ?? {}).length)
			issues.push(`${at}: no copy — every user-visible string is specified here or invented at implementation time`);
		if (screen?.flow === 'paywall' && !screen?.monetization)
			issues.push(`${at}: a paywall screen with no monetization block — \`ship rc audit\` has nothing to validate the ladder against`);
	}
	return issues;
}

/**
 * Events carry the analytics contract. The name is derivable from the flow and
 * the verb, so a hand-typed one that disagrees is a funnel that cannot be
 * joined to the screen that emitted it.
 * @type {(spec: any) => string[]}
 */
export function checkEvents(spec) {
	/** @type {string[]} */
	const issues = [];
	for (const screen of spec?.screens ?? []) {
		for (const event of screen?.events ?? []) {
			if (!isFlow(event?.flow)) continue;
			const expected = eventName(event.flow, event.verb);
			if (event?.name !== expected)
				issues.push(`screen "${screen?.id}": event "${event?.name}" should be "${expected}" — the name is derived from flow and verb, not written`);
		}
	}
	return issues;
}

/**
 * Flows are journeys, so they own an ordering and a terminal condition. A
 * screen in no flow is a screen nobody walks to, which QA will never capture.
 * @type {(spec: any) => string[]}
 */
export function checkFlows(spec) {
	/** @type {string[]} */
	const issues = [];
	const screens = new Set((spec?.screens ?? []).map((/** @type {any} */ s) => s?.id));
	const walked = new Set();
	const seen = new Set();
	for (const flow of spec?.flows ?? []) {
		const at = `flow "${flow?.id ?? '?'}"`;
		if (seen.has(flow?.id)) issues.push(`${at}: duplicate flow id`);
		seen.add(flow?.id);
		for (const id of flow?.screens ?? []) {
			if (!screens.has(id)) issues.push(`${at}: names screen "${id}", which this spec does not define`);
			walked.add(id);
		}
		if (!String(flow?.success ?? '').trim())
			issues.push(`${at}: no success condition — it is the flow's terminal funnel event`);
	}
	for (const id of screens) if (!walked.has(id)) issues.push(`screen "${id}": in no flow, so nothing reaches it`);
	return issues;
}

/**
 * The implementation may only name components the spec declares, which is what
 * `components.json` is for. Skipped when that file is absent — an unbuilt
 * component map is a gap, not a contradiction.
 * @type {(spec: any, components: Set<string>) => string[]}
 */
export function checkComponents(spec, components) {
	if (!components.size) return [];
	/** @type {string[]} */
	const issues = [];
	for (const screen of spec?.screens ?? [])
		for (const id of screen?.components ?? [])
			if (!components.has(id)) issues.push(`screen "${screen?.id}": component "${id}" is not in components.json`);
	return issues;
}

/**
 * Every spec check.
 * @type {(spec: any, opts?: {components?: Set<string>}) => string[]}
 */
export function checkSpec(spec, { components = new Set() } = {}) {
	if (Array.isArray(spec?._todo) && spec._todo.length)
		return [`ux.json is still a draft — fill ${spec._todo.join(', ')} and drop _todo`];
	return [...checkScreens(spec), ...checkEvents(spec), ...checkFlows(spec), ...checkComponents(spec, components)];
}
