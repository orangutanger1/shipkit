// Drafts for the two design artifacts, following the same contract the
// research fetcher set: Node writes everything it can derive, omits everything
// that is a judgement, and annotates what it left with `_todo`. A guessed
// accent hue that nobody notices is worse than a missing one that fails a gate.
import { FLOWS, eventName } from './flows.mjs';

/**
 * What a draft is still waiting for, or nothing. Callers check this before the
 * schema, because a draft fails the schema for the same reason it is a draft
 * and "color is required" is a worse message than "you still owe colour".
 * @type {(doc: any) => string[]}
 */
export const draftTodo = (doc) => (Array.isArray(doc?._todo) ? doc._todo : []);

/**
 * Apple's text styles, at their default Dynamic Type size. This is the ramp
 * `HIG:typography` refers to, and starting from it is what makes Dynamic Type
 * work — an invented scale has to be re-derived at every accessibility size.
 */
export const PLATFORM_RAMP = [
	{ name: 'largeTitle', size: 34, lineHeight: 41, weight: 700, role: 'screen title, once per screen' },
	{ name: 'title', size: 28, lineHeight: 34, weight: 700, role: 'section heading' },
	{ name: 'headline', size: 17, lineHeight: 22, weight: 600, role: 'emphasis within body text' },
	{ name: 'body', size: 17, lineHeight: 22, weight: 400, role: 'default reading size' },
	{ name: 'subheadline', size: 15, lineHeight: 20, weight: 400, role: 'secondary line under a title' },
	{ name: 'footnote', size: 13, lineHeight: 18, weight: 400, role: 'supporting detail' },
	{ name: 'caption', size: 12, lineHeight: 16, weight: 400, role: 'labels, timestamps, legal' },
];

/** @type {(value: number, note?: string) => {value: number, cite: string, note?: string}} */
const hig = (value, note) => (note ? { value, cite: 'HIG:layout', note } : { value, cite: 'HIG:layout' });

/**
 * The deterministic half of a design system. Colour is absent on purpose:
 * choosing a hue is the one part of this file that is not derivable, and the
 * schema's `color` requirement is what makes the omission loud.
 * @type {(input: {name?: string, now?: string}) => any}
 */
export function draftSystem({ name, now = new Date().toISOString() } = {}) {
	return {
		$schema: '../schema/design-system.schema.json',
		generatedAt: now,
		brand: { name: name ?? 'app', direction: 'TODO: one sentence every token answers to' },
		type: {
			family: { text: 'System' },
			ramp: PLATFORM_RAMP.map((step) => ({ ...step, cite: 'HIG:typography' })),
		},
		spacing: { base: 4, scale: [0, 4, 8, 12, 16, 24, 32, 48], cite: 'HIG:layout' },
		radii: { sm: hig(8, 'chips, inputs'), md: hig(12, 'cards'), lg: hig(16, 'sheets') },
		elevation: { card: { value: '0 1 3 rgba(0,0,0,0.12)', cite: 'HIG:layout' } },
		motion: {
			durations: { fast: hig(150, 'state change in place'), base: hig(250, 'push, present'), slow: hig(350, 'full-screen') },
			curves: { standard: { value: 'cubic-bezier(0.2, 0, 0, 1)', cite: 'HIG:motion' } },
			reducedMotion: 'Cross-fade at 100ms and hold final positions; no translation, scale or parallax.',
		},
		_todo: ['color', 'brand.direction'],
	};
}

/** @type {(flow: string) => string} */
export const routeFor = (flow) => (flow === 'home' ? '/' : `/${flow}`);

/**
 * One screen per researched flow, with the events the flow vocabulary already
 * names. Copy, purpose and components are the agent's, so they are absent.
 * @type {(flow: string) => any}
 */
function draftScreen(flow) {
	const screen = {
		id: flow,
		route: routeFor(flow),
		flow,
		purpose: `TODO: what this screen exists to do — ${FLOWS[flow].purpose}`,
		states: flow === 'home' ? ['default', 'empty', 'loading'] : ['default'],
		events: [{ name: eventName(flow, 'viewed'), flow, verb: 'viewed', when: 'on mount' }],
	};
	if (flow === 'paywall') screen.events.push({ name: eventName(flow, 'completed'), flow, verb: 'completed', when: 'purchase succeeds' });
	return screen;
}

/**
 * A UX spec skeleton over the flows a research run covered. It is a skeleton on
 * purpose: the screens exist so the flows are walkable, and every string that
 * a user would read is the agent's to write against the evidence.
 * @type {(input: {flows: string[], now?: string}) => any}
 */
export function draftSpec({ flows, now = new Date().toISOString() }) {
	const screens = flows.map(draftScreen);
	return {
		$schema: '../schema/ux-spec.schema.json',
		generatedAt: now,
		screens,
		flows: flows.map((flow) => ({
			id: flow,
			screens: [flow],
			entry: 'TODO: how the user arrives',
			success: `TODO: what completing ${flow} means`,
		})),
		_todo: ['screens[].copy', 'screens[].components', 'flows[].entry', 'flows[].success'],
	};
}
