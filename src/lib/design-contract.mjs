// What the static primitives support, and what they need in order to render.
//
// This is the contract `ship design build` transcribes against. It lives here
// rather than in the app repo because templates/app/src/theme/primitives.tsx is
// shipkit's own code — shipkit declares what it supports, writes that
// declaration to design/components.json, and both `design spec` and the
// implementing agent read it from there without importing shipkit.
//
// `requires` is the only place that says what a primitive needs from
// design/system.json. The token gate is computed from it, so adding a primitive
// that needs a new token updates the gate rather than drifting from it.
/** Bumped when a change would make an older scaffold mis-transcribe. */
export const CONTRACT_VERSION = 1;

/** @typedef {{primitive: string, file: string, role: string, props?: Record<string, any>, variants: string[], states: string[], requires: {type?: string[], color?: string[], radii?: string[], spacingSteps?: number}}} Component */

const PRIMITIVES = 'src/theme/primitives.tsx';
const TEXT_ROLES = ['largeTitle', 'title', 'headline', 'body', 'footnote'];
const STATE_KINDS = ['empty', 'loading', 'error', 'offline'];

/** @type {Record<string, Component>} */
const COMPONENTS = {
	Screen: {
		primitive: 'SafeAreaView', file: PRIMITIVES, role: 'container',
		props: { scroll: { type: 'boolean', default: false } },
		variants: [], states: [],
		requires: { color: ['background'], spacingSteps: 6 },
	},
	Text: {
		primitive: 'Text', file: PRIMITIVES, role: 'content',
		props: { role: { type: 'enum', values: TEXT_ROLES } },
		variants: TEXT_ROLES, states: [],
		requires: { type: TEXT_ROLES, color: ['text', 'textMuted'] },
	},
	Button: {
		primitive: 'Pressable', file: PRIMITIVES, role: 'action',
		props: {
			variant: { type: 'enum', values: ['primary', 'secondary', 'destructive'] },
			disabled: { type: 'boolean', default: false },
		},
		variants: ['primary', 'secondary', 'destructive'],
		states: ['default', 'pressed', 'disabled', 'loading'],
		requires: {
			color: ['accent', 'accentText', 'border', 'danger', 'textInverse'],
			radii: ['md'], type: ['headline'], spacingSteps: 5,
		},
	},
	StateView: {
		primitive: 'View', file: PRIMITIVES, role: 'state',
		props: { kind: { type: 'enum', values: STATE_KINDS } },
		variants: STATE_KINDS, states: [],
		requires: { color: ['background', 'textMuted'], type: ['body'], spacingSteps: 6 },
	},
};

/** The document written to design/components.json. No timestamp: it is hashed. */
export function contractDoc() {
	return { contractVersion: CONTRACT_VERSION, components: COMPONENTS };
}

/** @type {(a: string[], b: string[]|undefined) => string[]} */
function union(a, b) {
	return [...new Set([...a, ...(b ?? [])])].sort();
}

/**
 * Every token any primitive in the contract needs. Computed, never written
 * down twice.
 * @type {(contract: any) => {type: string[], color: string[], radii: string[], spacingSteps: number}}
 */
export function requiredTokens(contract) {
	let type = /** @type {string[]} */ ([]);
	let color = /** @type {string[]} */ ([]);
	let radii = /** @type {string[]} */ ([]);
	let spacingSteps = 0;
	for (const def of Object.values(contract?.components ?? {})) {
		const req = /** @type {any} */ (def)?.requires ?? {};
		type = union(type, req.type);
		color = union(color, req.color);
		radii = union(radii, req.radii);
		spacingSteps = Math.max(spacingSteps, Number(req.spacingSteps ?? 0));
	}
	return { type, color, radii, spacingSteps };
}

/** @type {(step: any) => string} */
function rampName(step) {
	return step?.name;
}

/** @type {(event: any) => string} */
function eventOf(event) {
	return event?.name;
}

/** @type {(system: any, contract: any) => string[]} */
function checkTokens(system, contract) {
	const need = requiredTokens(contract);
	/** @type {string[]} */
	const issues = [];
	const ramp = new Set((system?.type?.ramp ?? []).map(rampName));
	for (const role of need.type)
		if (!ramp.has(role)) issues.push(`design/system.json: the type ramp has no "${role}" step, which the primitives render with`);
	const radii = new Set(Object.keys(system?.radii ?? {}));
	for (const name of need.radii)
		if (!radii.has(name)) issues.push(`design/system.json: no radius named "${name}", which the primitives round with`);
	for (const theme of ['light', 'dark']) {
		const colors = new Set(Object.keys(system?.color?.themes?.[theme] ?? {}));
		for (const name of need.color)
			if (!colors.has(name)) issues.push(`design/system.json: the ${theme} theme has no "${name}" colour, which the primitives paint with`);
	}
	const steps = (system?.spacing?.scale ?? []).length;
	if (steps < need.spacingSteps)
		issues.push(`design/system.json: spacing.scale has ${steps} steps; the primitives index ${need.spacingSteps}`);
	return issues;
}

/** @type {(screen: any, contract: any) => string[]} */
function checkElements(screen, contract) {
	/** @type {string[]} */
	const issues = [];
	const at = `screen "${screen?.id ?? '?'}"`;
	const known = Object.keys(contract?.components ?? {});
	const copyKeys = new Set(Object.keys(screen?.copy ?? {}));
	const eventNames = new Set((screen?.events ?? []).map(eventOf));
	for (const el of screen?.elements ?? []) {
		const def = /** @type {any} */ (contract?.components ?? {})[el?.component];
		if (!def) {
			issues.push(`${at}: component "${el?.component}" is not in the contract — supported: ${known.join(', ')}`);
			continue;
		}
		if (el?.variant !== undefined && !def.variants.includes(el.variant))
			issues.push(`${at}: ${el.component} has no "${el.variant}" variant — supported: ${def.variants.join(', ') || 'none'}`);
		if (el?.copy !== undefined && !copyKeys.has(el.copy))
			issues.push(`${at}: element names copy key "${el.copy}", which this screen does not define`);
		if (el?.event !== undefined && !eventNames.has(el.event))
			issues.push(`${at}: element fires "${el.event}", which this screen does not declare in events`);
	}
	return issues;
}

/** @type {(screen: any, contract: any) => string[]} */
function checkStates(screen, contract) {
	const kinds = new Set(/** @type {any} */ (contract?.components ?? {})?.StateView?.variants ?? []);
	/** @type {string[]} */
	const issues = [];
	for (const state of screen?.states ?? [])
		if (state !== 'default' && !kinds.has(state))
			issues.push(`screen "${screen?.id}": state "${state}" has no StateView variant — supported: ${[...kinds].join(', ')}`);
	return issues;
}

/**
 * Every reason this spec cannot be built, at once. Validation runs before a
 * byte is written, so a partially generated tree is not a state that exists.
 * @type {(spec: any, contract: any, system: any) => string[]}
 */
export function validateAgainstContract(spec, contract, system) {
	const version = Number(contract?.contractVersion ?? 0);
	if (version > CONTRACT_VERSION)
		return [`design/components.json: contractVersion ${version} is newer than this shipkit understands (${CONTRACT_VERSION}) — upgrade shipkit`];
	/** @type {string[]} */
	const issues = [];
	for (const screen of spec?.screens ?? []) {
		issues.push(...checkElements(screen, contract));
		issues.push(...checkStates(screen, contract));
	}
	issues.push(...checkTokens(system, contract));
	return issues;
}

