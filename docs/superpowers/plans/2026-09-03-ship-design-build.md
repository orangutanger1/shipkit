# `ship design build` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `design/system.json` + `design/ux.json` into a structurally complete, validated implementation scaffold — themed tokens, one route per screen, typed events, structured monetization — so `ship qa` has real routes to drive and the QA query-parameter contract is honoured by construction.

**Architecture:** A component contract (`design/components.json`) declares what the static primitives support and which tokens each needs. `ship design build` validates `ux.json` against that contract, then transcribes it. Every emitter is a pure `JSON → string` function in `src/lib/`; the command does all disk I/O. Nothing is inferred: where the spec is silent the generator emits a null layout and says so.

**Tech Stack:** Node 20+ ESM, `node:test`, JSDoc-typed `.mjs` (no TypeScript in shipkit itself), ajv via `src/lib/schema.mjs`, c8 coverage, oxlint, `scripts/metrics.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-03-design-build-design.md` (revision 2)

## Global Constraints

- **Node only, offline.** `npm test` never touches the network. Emitters take data, never fetch it.
- **Libs take I/O as an argument.** No emitter reads or writes the filesystem. `src/commands/design.mjs` reads, hashes, writes, prints.
- **≤500 real code lines per file.** Comments are free against the limit; that is not licence to write more. Comment the non-obvious decision in a line or two, never restate the code.
- **Named functions, not anonymous callbacks.** `scripts/metrics.mjs` charges CRAP against any function c8's `fnMap` does not register — an unnamed `.map`/`.reduce` callback reads as never-hit even at 100% coverage.
- **Report every issue at once.** The gate's error message is the agent's contract. Never fail on the first problem.
- **Absent ≠ zero.** Missing data is `unknown`/omitted and names the command that would answer it.
- **Byte-stability.** Emitters are pure functions of their argument: no `Date.now()`, no `new Date()`, no `process.env`, no randomness, no iteration over an unordered `Set`. Generated files carry **no timestamp**.
- **Emitted source style:** tabs, single quotes, semicolons, trailing commas — the repo's Prettier settings, so the app repo's formatter is a no-op on generated files.
- **Contract version:** `CONTRACT_VERSION = 1` for this whole plan.
- **Before any commit:** `npm run lint && npm test && npm run metrics`, and check `npx tsc --noEmit 2>&1 | grep -c 'error TS'` has not risen above **351**.
- **Metrics gotcha:** `scripts/metrics.mjs` joins `coverage/coverage-final.json` on line numbers. Re-run `npm run test:c8` before trusting a metrics count. `test:c8` exits non-zero by design (`--100` is aspirational, actual ~72%) — that is not a regression.

---

## File Structure

**Create — shipkit libs (pure):**
- `src/lib/design-contract.mjs` — `CONTRACT_VERSION`, `COMPONENTS`, `contractDoc()`, `requiredTokens()`, `validateAgainstContract()`
- `src/lib/design-emit.mjs` — `header()`, `bodyHash()`, `parseHeader()`, `classify()`, `routeToFile()`
- `src/lib/design-tokens.mjs` — `DEFAULT_SYSTEM`, `emitTokens()`
- `src/lib/design-screen.mjs` — `emitScreen()`
- `src/lib/design-support.mjs` — `emitEvents()`, `emitCatalog()`, `emitQaParams()`, `DEFAULT_SPEC`
- `src/lib/qa-params.mjs` — `sanitizeQa()`, `QA_DEFAULTS` (the real logic; also emitted into the app)

**Create — schema:**
- `schema/components.schema.json`

**Create — static template files:**
- `templates/app/src/theme/provider.tsx`
- `templates/app/src/theme/primitives.tsx`
- `templates/app/src/analytics/index.ts`

**Modify:**
- `src/lib/schemas.mjs` — add `'components'` to `SCHEMAS`
- `schema/ux-spec.schema.json` — add optional `elements` to a screen
- `src/lib/design-draft.mjs` — `draftSpec` adds `screens[].elements` to `_todo`
- `src/lib/design-spec.mjs` — `checkSpec` takes the contract, not a bare id set
- `src/lib/design-review.mjs` — new rules + exception constant
- `src/commands/design.mjs` — `build` added to `SUB`
- `src/commands/new.mjs` — calls the emitters for the scaffold's generated files
- `templates/app/app/index.tsx` — **delete** (now generated)
- `.github/workflows/*` scaffold smoke — extend

**Test:**
- `test/design-contract.test.mjs`, `test/design-emit.test.mjs`, `test/design-tokens.test.mjs`, `test/design-screen.test.mjs`, `test/design-support.test.mjs`, `test/qa-params.test.mjs`, `test/design-determinism.test.mjs`, `test/design-review.test.mjs`
- `test/design-command.test.mjs` — extended
- `test/fixtures/design/expected/*.txt` — golden files

---

## Task 1: The QA parameter sanitizer

The security boundary, built first because everything else can be tested against a scaffold that already has it.

**Files:**
- Create: `src/lib/qa-params.mjs`
- Test: `test/qa-params.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `QA_DEFAULTS` (`{theme: null, state: 'default', locale: null, scale: 1}`), `sanitizeQa(raw, {enabled, themes, states}) => {theme, state, locale, scale}`, `QA_STATES` (the seven `ux-spec` states)

- [ ] **Step 1: Write the failing test**

```js
// test/qa-params.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { QA_DEFAULTS, sanitizeQa } from '../src/lib/qa-params.mjs';

const OPTS = { enabled: true, themes: ['light', 'dark'], states: ['default', 'loading', 'error'] };

test('disabled returns the defaults for every hostile input', () => {
	const hostile = [
		{ qaTheme: 'dark', qaState: 'error', qaLocale: 'de-DE', qaTextScale: '2' },
		{ qaTheme: ['dark'], qaState: '../../etc/passwd', qaLocale: '../', qaTextScale: 'Infinity' },
		{ qaTheme: '__proto__', qaState: 'constructor', qaLocale: 999, qaTextScale: -5 },
	];
	for (const raw of hostile)
		assert.deepEqual(sanitizeQa(raw, { ...OPTS, enabled: false }), QA_DEFAULTS);
});

test('enabled accepts the valid set', () => {
	assert.deepEqual(sanitizeQa({ qaTheme: 'dark', qaState: 'error', qaLocale: 'de-DE', qaTextScale: '1.5' }, OPTS), {
		theme: 'dark', state: 'error', locale: 'de-DE', scale: 1.5,
	});
});

test('enabled falls back per field, never throws', () => {
	const cases = [
		[{ qaTheme: 'chartreuse' }, 'theme', null],
		[{ qaState: 'nope' }, 'state', 'default'],
		[{ qaLocale: 'not a locale' }, 'locale', null],
		[{ qaLocale: 'de_DE' }, 'locale', null],
		[{ qaTextScale: 'NaN' }, 'scale', 1],
		[{ qaTextScale: '0.01' }, 'scale', 0.5],
		[{ qaTextScale: '99' }, 'scale', 4],
		[{ qaTheme: ['dark', 'light'] }, 'theme', null],
		[{ qaState: null }, 'state', 'default'],
	];
	for (const [raw, field, want] of cases)
		assert.equal(sanitizeQa(raw, OPTS)[field], want, `${field} from ${JSON.stringify(raw)}`);
});

test('an absent parameter object is the defaults', () => {
	assert.deepEqual(sanitizeQa(undefined, OPTS), QA_DEFAULTS);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/qa-params.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/qa-params.mjs'`

- [ ] **Step 3: Implement**

```js
// src/lib/qa-params.mjs
// The QA query-parameter contract, and the only place it is interpreted.
//
// lib/qa-matrix.mjs sets qaTheme/qaState/qaLocale/qaTextScale on every capture
// URL. expo-router honours the same parameters over a deep link on NATIVE, so
// an ungated release build would accept a URL that puts any screen into any
// state — a paywall in its success state included. `enabled` is that gate, and
// it returns before reading a single field.
//
// This module is also emitted verbatim into the generated app as
// src/theme/qa-params.ts, so the logic shipkit tests is the logic that ships.

/** Every state `ux-spec` allows a screen to declare. */
export const QA_STATES = /** @type {const} */ ([
	'default', 'empty', 'loading', 'error', 'offline', 'success', 'disabled',
]);

/** What a capture renders when nothing valid was asked for. */
export const QA_DEFAULTS = /** @type {const} */ ({ theme: null, state: 'default', locale: null, scale: 1 });

/** Dynamic Type never shrinks below half or grows past 4× body on iOS. */
const SCALE_MIN = 0.5;
const SCALE_MAX = 4;

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** expo-router gives a repeated parameter as an array; a single value is the only one we honour.
 * @type {(value: unknown) => string|null}
 */
function oneString(value) {
	return typeof value === 'string' ? value : null;
}

/** @type {(value: unknown, allowed: readonly string[], fallback: string|null) => string|null} */
function oneOf(value, allowed, fallback) {
	const str = oneString(value);
	return str !== null && allowed.includes(str) ? str : fallback;
}

/** @type {(value: unknown) => string|null} */
function localeOf(value) {
	const str = oneString(value);
	return str !== null && LOCALE_RE.test(str) ? str : null;
}

/** Clamped rather than rejected: an out-of-range scale is a typo, and the nearest legal size still measures something.
 * @type {(value: unknown) => number}
 */
function scaleOf(value) {
	const n = Number(oneString(value));
	if (!Number.isFinite(n) || n <= 0) return QA_DEFAULTS.scale;
	return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/**
 * @type {(raw: any, opts: {enabled: boolean, themes: readonly string[], states?: readonly string[]}) => {theme: string|null, state: string, locale: string|null, scale: number}}
 */
export function sanitizeQa(raw, { enabled, themes, states = QA_STATES }) {
	if (!enabled || !raw || typeof raw !== 'object') return { ...QA_DEFAULTS };
	return {
		theme: oneOf(raw.qaTheme, themes, QA_DEFAULTS.theme),
		state: oneOf(raw.qaState, states, QA_DEFAULTS.state) ?? QA_DEFAULTS.state,
		locale: localeOf(raw.qaLocale),
		scale: scaleOf(raw.qaTextScale),
	};
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/qa-params.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/qa-params.mjs test/qa-params.test.mjs
git commit -m "feat(design): the QA parameter sanitizer, and its security boundary"
```

---

## Task 2: The component contract

**Files:**
- Create: `src/lib/design-contract.mjs`, `schema/components.schema.json`
- Modify: `src/lib/schemas.mjs` (add `'components'` to `SCHEMAS`)
- Test: `test/design-contract.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `CONTRACT_VERSION = 1`; `COMPONENTS` (the four component definitions); `contractDoc() => {contractVersion, components}`; `requiredTokens(contract) => {type: string[], radii: string[], color: string[], spacingSteps: number}`; `validateAgainstContract(spec, contract, system) => string[]`

- [ ] **Step 1: Write the failing test**

```js
// test/design-contract.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_VERSION, contractDoc, requiredTokens, validateAgainstContract } from '../src/lib/design-contract.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { clone, designSystem, uxSpec } from './fixtures/artifacts.mjs';

const contract = contractDoc();

const screen = (over = {}) => ({
	id: 'paywall', route: '/paywall', flow: 'paywall', purpose: 'Sell.',
	copy: { title: 'Go Pro', cta: 'Start' }, states: ['default'],
	events: [{ name: 'paywall_viewed', flow: 'paywall', verb: 'viewed' }],
	...over,
});
const specOf = (s) => ({ screens: [s], flows: [{ id: 'paywall', screens: [s.id], success: 'Bought.' }] });

test('the contract validates against its own schema', async () => {
	assert.deepEqual(await checkArtifact('components', contract, 'components.json'), []);
	assert.equal(contract.contractVersion, CONTRACT_VERSION);
});

test('requiredTokens is computed from the contract, not hardcoded', () => {
	const req = requiredTokens(contract);
	assert.ok(req.type.includes('body'));
	assert.ok(req.radii.includes('md'));
	assert.ok(req.color.includes('accent'));
	assert.ok(req.spacingSteps >= 1);
});

test('the drafted default system satisfies every requirement', async () => {
	const { draftSystem } = await import('../src/lib/design-draft.mjs');
	const drafted = { ...draftSystem({ name: 'Demo' }), color: designSystem.color };
	assert.deepEqual(validateAgainstContract(specOf(screen()), contract, drafted), []);
});

test('an unsupported component is named, with the supported set', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Carousel', copy: 'title' }] })), contract, designSystem);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /Carousel/);
	assert.match(issues[0], /Button/);
});

test('an unsupported variant names both the component and the variant', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Button', variant: 'ghost', copy: 'cta' }] })), contract, designSystem);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /Button/);
	assert.match(issues[0], /ghost/);
});

test('a dangling copy key and an undeclared event are both reported', () => {
	const issues = validateAgainstContract(
		specOf(screen({ elements: [{ component: 'Button', variant: 'primary', copy: 'missing', event: 'paywall_completed' }] })),
		contract, designSystem);
	assert.equal(issues.length, 2);
	assert.ok(issues.some((i) => /missing/.test(i)));
	assert.ok(issues.some((i) => /paywall_completed/.test(i)));
});

test('an unsupported state is named', () => {
	const issues = validateAgainstContract(specOf(screen({ states: ['default', 'success'] })), contract, designSystem);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /success/);
});

test('every missing token is reported at once, not one per run', () => {
	const thin = clone(designSystem);
	thin.type.ramp = thin.type.ramp.filter((s) => s.name === 'body');
	thin.radii = {};
	const issues = validateAgainstContract(specOf(screen()), contract, thin);
	assert.ok(issues.length >= 3, `expected several, got ${issues.length}`);
	assert.ok(issues.some((i) => /largeTitle/.test(i)));
	assert.ok(issues.some((i) => /md/.test(i)));
});

test('a newer contractVersion is refused rather than mis-transcribed', () => {
	const issues = validateAgainstContract(specOf(screen()), { ...contract, contractVersion: 99 }, designSystem);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /99/);
});

test('a spec with no elements is valid — the null layout is a choice, not an error', () => {
	assert.deepEqual(validateAgainstContract(clone(uxSpec), contract, designSystem), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-contract.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-contract.mjs'`

- [ ] **Step 3: Write the schema**

```json
{
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"$id": "https://github.com/mayfield/shipkit/schema/components.schema.json",
	"title": "component contract",
	"description": "design/components.json — what the static primitives support, and which design tokens each needs to render. Written by `ship design build`; read by `ship design spec` to refuse a spec that cannot be built.",
	"type": "object",
	"required": ["contractVersion", "components"],
	"additionalProperties": false,
	"patternProperties": { "^_": { "description": "Annotation kept beside the data it explains. Ignored by every loader." } },
	"properties": {
		"$schema": { "type": "string" },
		"contractVersion": { "type": "integer", "minimum": 1 },
		"components": {
			"type": "object",
			"minProperties": 1,
			"additionalProperties": {
				"type": "object",
				"required": ["primitive", "file", "role", "variants", "states", "requires"],
				"additionalProperties": false,
				"properties": {
					"primitive": { "type": "string", "minLength": 1 },
					"file": { "type": "string", "minLength": 1 },
					"role": { "enum": ["container", "content", "action", "state"] },
					"props": {
						"type": "object",
						"additionalProperties": {
							"type": "object",
							"required": ["type"],
							"additionalProperties": false,
							"properties": {
								"type": { "enum": ["string", "boolean", "number", "enum"] },
								"values": { "type": "array", "items": { "type": "string" } },
								"default": {}
							}
						}
					},
					"variants": { "type": "array", "uniqueItems": true, "items": { "type": "string" } },
					"states": { "type": "array", "uniqueItems": true, "items": { "type": "string" } },
					"requires": {
						"type": "object",
						"additionalProperties": false,
						"description": "Tokens the primitive cannot render without. The single source of the token gate — nothing hardcodes this list.",
						"properties": {
							"type": { "type": "array", "items": { "type": "string" } },
							"color": { "type": "array", "items": { "type": "string" } },
							"radii": { "type": "array", "items": { "type": "string" } },
							"spacingSteps": {
								"type": "integer",
								"minimum": 0,
								"description": "How many steps of spacing.scale the primitive indexes. Spacing is an unnamed numeric series in design-system.schema.json, so it is required by length rather than by name."
							}
						}
					}
				}
			}
		}
	}
}
```

- [ ] **Step 4: Register the schema**

In `src/lib/schemas.mjs`, add `'components'` to the `SCHEMAS` array, after `'ux-spec'`:

```js
	'design-system',
	'ux-spec',
	'components',
	'qa-report',
```

- [ ] **Step 5: Implement the contract**

```js
// src/lib/design-contract.mjs
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
import { QA_STATES } from './qa-params.mjs';

/** Bumped when a change would make an older scaffold mis-transcribe. */
export const CONTRACT_VERSION = 1;

/** @typedef {{primitive: string, file: string, role: string, props?: Record<string, any>, variants: string[], states: string[], requires: {type?: string[], color?: string[], radii?: string[], spacingSteps?: number}}} Component */

const PRIMITIVES = 'src/theme/primitives.tsx';
const TEXT_ROLES = ['largeTitle', 'title', 'headline', 'body', 'footnote'];
const STATE_KINDS = ['empty', 'loading', 'error', 'offline'];

/** @type {Record<string, Component>} */
export const COMPONENTS = {
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
const union = (a, b) => [...new Set([...a, ...(b ?? [])])].sort();

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

/** @type {(system: any, contract: any) => string[]} */
function checkTokens(system, contract) {
	const need = requiredTokens(contract);
	/** @type {string[]} */
	const issues = [];
	const ramp = new Set((system?.type?.ramp ?? []).map((/** @type {any} */ s) => s?.name));
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
	const eventNames = new Set((screen?.events ?? []).map((/** @type {any} */ e) => e?.name));
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

export { QA_STATES };
```

- [ ] **Step 6: Run it and watch it pass**

Run: `node --test test/design-contract.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 7: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-contract.mjs schema/components.schema.json src/lib/schemas.mjs test/design-contract.test.mjs
git commit -m "feat(design): the component contract, and the token gate computed from it"
```

---

## Task 3: Ownership headers, hashing and route mapping

**Files:**
- Create: `src/lib/design-emit.mjs`
- Test: `test/design-emit.test.mjs`

**Interfaces:**
- Consumes: `CONTRACT_VERSION` from `src/lib/design-contract.mjs`
- Produces: `bodyHash(body) => string` (8 hex); `header({source, comment?}) => string`; `withHeader(body, {source}) => string`; `parseHeader(text) => {hash, source, body}|null`; `classify(text|null, body) => 'create'|'rewrite'|'edited'|'foreign'`; `routeToFile(route) => string`

- [ ] **Step 1: Write the failing test**

```js
// test/design-emit.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyHash, classify, parseHeader, routeToFile, withHeader } from '../src/lib/design-emit.mjs';

const SRC = 'design/ux.json';
const body = 'export const x = 1;\n';

test('a header round-trips, and the hash covers the body only', () => {
	const text = withHeader(body, { source: SRC });
	const parsed = parseHeader(text);
	assert.equal(parsed.body, body);
	assert.equal(parsed.source, SRC);
	assert.equal(parsed.hash, bodyHash(body));
	assert.ok(text.startsWith('// @generated'));
});

test('our own untouched file is a rewrite', () => {
	assert.equal(classify(withHeader(body, { source: SRC }), body), 'rewrite');
});

test('a hand-edited body is detected, however small the edit', () => {
	const text = withHeader(body, { source: SRC }).replace('const x = 1', 'const x = 2');
	assert.equal(classify(text, body), 'edited');
});

test('reformatting the header does not falsify the hash', () => {
	const text = withHeader(body, { source: SRC }).replace('Edit freely.', 'Edit  freely.');
	assert.equal(classify(text, body), 'rewrite');
});

test('a file we never wrote is foreign, not overwritten', () => {
	assert.equal(classify('export const x = 1;\n', body), 'foreign');
});

test('an absent file is a create', () => {
	assert.equal(classify(null, body), 'create');
});

test('routes map onto expo-router paths, dynamic segments included', () => {
	assert.equal(routeToFile('/'), 'app/index.tsx');
	assert.equal(routeToFile('/paywall'), 'app/paywall.tsx');
	assert.equal(routeToFile('/settings/notifications'), 'app/settings/notifications.tsx');
	assert.equal(routeToFile('/item/[id]'), 'app/item/[id].tsx');
});

test('a route that escapes the app directory is refused', () => {
	assert.throws(() => routeToFile('/../etc/passwd'), /route/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-emit.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-emit.mjs'`

- [ ] **Step 3: Implement**

```js
// src/lib/design-emit.mjs
// The ownership header every generated file carries, and the arithmetic behind
// it.
//
// The hash covers the body BELOW the header, for two reasons: a hash of the
// whole file would have to include itself, and reformatting the comment would
// otherwise read as a hand edit. Byte-stability is what makes any of this work
// — an emitter that varied its output would report every file as edited on the
// second run — so nothing here reads a clock, an environment or a disk.
import { createHash } from 'node:crypto';
import { ShipError } from '../log.mjs';
import { CONTRACT_VERSION } from './design-contract.mjs';

/** @type {(body: string) => string} */
export function bodyHash(body) {
	return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
}

/** @type {(input: {source: string, hash: string}) => string} */
function headerFor({ source, hash }) {
	return [
		`// @generated by \`ship design build\` from ${source}`,
		`// @contract ${CONTRACT_VERSION}`,
		`// @hash ${hash}`,
		'// Edit freely. `ship design build` refuses to overwrite a changed file and',
		'// names it, rather than destroying your work. --force takes it back.',
		'',
		'',
	].join('\n');
}

/** @type {(body: string, opts: {source: string}) => string} */
export function withHeader(body, { source }) {
	return headerFor({ source, hash: bodyHash(body) }) + body;
}

const HASH_RE = /^\/\/ @hash ([0-9a-f]{8})$/m;
const SOURCE_RE = /^\/\/ @generated by `ship design build` from (.+)$/m;

/**
 * Split a generated file back into its header facts and its body. Null when the
 * file was not written by us.
 * @type {(text: string) => {hash: string, source: string, body: string}|null}
 */
export function parseHeader(text) {
	if (!text.startsWith('// @generated')) return null;
	const hash = HASH_RE.exec(text);
	const source = SOURCE_RE.exec(text);
	if (!hash || !source) return null;
	// The header ends at the first blank line; everything after it is the body.
	const end = text.indexOf('\n\n');
	if (end === -1) return null;
	return { hash: hash[1], source: source[1], body: text.slice(end + 2) };
}

/**
 * What writing this file would do.
 *
 * `foreign` and `edited` are separate because they need different advice: one
 * is a file somebody wrote by hand where we want to write, the other is our own
 * file somebody improved. Both refuse without --force.
 * @type {(text: string|null, body: string) => 'create'|'rewrite'|'edited'|'foreign'}
 */
export function classify(text, body) {
	if (text === null || text === undefined) return 'create';
	const parsed = parseHeader(text);
	if (!parsed) return 'foreign';
	return parsed.hash === bodyHash(parsed.body) ? 'rewrite' : 'edited';
}

/**
 * A `ux.json` route to the expo-router file that serves it. Dynamic segments
 * pass through: `ship qa` cannot drive one, but that is a QA limitation, and
 * refusing to generate a legitimate screen is the wrong place to express it.
 * @type {(route: string) => string}
 */
export function routeToFile(route) {
	const trimmed = String(route ?? '').replace(/\/+$/, '');
	const segments = trimmed.split('/').filter(Boolean);
	if (segments.some((s) => s === '.' || s === '..'))
		throw new ShipError(`design build: route "${route}" escapes the app directory`, {
			hint: 'routes are literal expo-router paths, e.g. /paywall or /item/[id]',
		});
	return `app/${segments.length ? segments.join('/') : 'index'}.tsx`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/design-emit.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-emit.mjs test/design-emit.test.mjs
git commit -m "feat(design): ownership headers, body hashing and route mapping"
```

---

## Task 4: The token emitter and the default system

**Files:**
- Create: `src/lib/design-tokens.mjs`
- Test: `test/design-tokens.test.mjs`

**Interfaces:**
- Consumes: `withHeader` from `design-emit.mjs`; `PLATFORM_RAMP` from `design-draft.mjs`
- Produces: `DEFAULT_SYSTEM` (a complete, contract-satisfying design system); `emitTokens(system, {source}) => string`

- [ ] **Step 1: Write the failing test**

```js
// test/design-tokens.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SYSTEM, emitTokens } from '../src/lib/design-tokens.mjs';
import { contractDoc, validateAgainstContract } from '../src/lib/design-contract.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { designSystem } from './fixtures/artifacts.mjs';

const SRC = 'design/system.json';

test('DEFAULT_SYSTEM is a valid design system that satisfies the contract', async () => {
	assert.deepEqual(await checkArtifact('design-system', DEFAULT_SYSTEM, 'system.json'), []);
	const spec = { screens: [], flows: [] };
	assert.deepEqual(validateAgainstContract(spec, contractDoc(), DEFAULT_SYSTEM), []);
});

test('both themes and every ramp step reach the module', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /export const tokens = \{/);
	assert.match(out, /light:/);
	assert.match(out, /dark:/);
	for (const step of DEFAULT_SYSTEM.type.ramp) assert.ok(out.includes(`${step.name}:`), `missing ${step.name}`);
	assert.match(out, /as const;/);
});

test('the exported types are what the primitives index by', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /export type ThemeName/);
	assert.match(out, /export type ColorToken/);
	assert.match(out, /export type TypeRole/);
});

test('font weights are strings — React Native rejects a numeric fontWeight', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	assert.match(out, /weight: '700'/);
	assert.doesNotMatch(out, /weight: 700\b/);
});

test('it carries an ownership header naming its source, and no timestamp', () => {
	const out = emitTokens(designSystem, { source: SRC });
	assert.ok(out.startsWith('// @generated'));
	assert.ok(out.includes(SRC));
	assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T/);
});

test('key order follows the ramp, not the parsed object', () => {
	const out = emitTokens(DEFAULT_SYSTEM, { source: SRC });
	const order = DEFAULT_SYSTEM.type.ramp.map((s) => out.indexOf(`\t\t${s.name}:`));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-tokens.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-tokens.mjs'`

- [ ] **Step 3: Implement**

```js
// src/lib/design-tokens.mjs
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
	text: t('#0f1113'), textMuted: t('#6b7480'), textInverse: t('#ffffff'),
	accent: t('#3d7bff'), accentText: t('#ffffff'), border: t('#d8dce0'),
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/design-tokens.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-tokens.mjs test/design-tokens.test.mjs
git commit -m "feat(design): the token emitter, and the scaffold's default system"
```

---

## Task 5: The supporting emitters — events, catalog, QA params

**Files:**
- Create: `src/lib/design-support.mjs`
- Test: `test/design-support.test.mjs`

**Interfaces:**
- Consumes: `withHeader` from `design-emit.mjs`
- Produces: `emitEvents(spec, {source}) => string`; `emitCatalog(spec, {source}) => string`; `emitQaParams(sourceText, {source}) => string`; `QA_PARAMS_SOURCE` (the path of `src/lib/qa-params.mjs`); `DEFAULT_SPEC` (a one-screen home spec for `ship new`)

- [ ] **Step 1: Write the failing test**

```js
// test/design-support.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_SPEC, QA_PARAMS_SOURCE, emitCatalog, emitEvents, emitQaParams } from '../src/lib/design-support.mjs';
import { checkArtifact } from '../src/lib/schemas.mjs';
import { uxSpec } from './fixtures/artifacts.mjs';

const SRC = 'design/ux.json';

test('every declared event becomes a typed constant', () => {
	const out = emitEvents(uxSpec, { source: SRC });
	assert.match(out, /paywall_viewed: 'paywall_viewed'/);
	assert.match(out, /export type AppEvent/);
	assert.match(out, /as const;/);
});

test('events are deduplicated and sorted, so two screens sharing one do not collide', () => {
	const spec = { screens: [
		{ id: 'b', events: [{ name: 'home_viewed' }] },
		{ id: 'a', events: [{ name: 'home_viewed' }, { name: 'account_viewed' }] },
	] };
	const out = emitEvents(spec, { source: SRC });
	assert.equal(out.match(/home_viewed:/g).length, 1);
	assert.ok(out.indexOf('account_viewed:') < out.indexOf('home_viewed:'));
});

test('a spec with no events still emits a compiling module', () => {
	const out = emitEvents({ screens: [] }, { source: SRC });
	assert.match(out, /export const EVENTS = \{\} as const;/);
	assert.match(out, /export type AppEvent = string;/);
});

test('monetization becomes structured data keyed by screen id', () => {
	const out = emitCatalog(uxSpec, { source: SRC });
	assert.match(out, /paywall: \{ offering: 'default', entitlement: 'pro'/);
	assert.match(out, /export const MONETIZATION/);
});

test('a spec that sells nothing still emits a compiling catalog', () => {
	const out = emitCatalog({ screens: [{ id: 'home' }] }, { source: SRC });
	assert.match(out, /export const MONETIZATION = \{\} as const;/);
});

test('the emitted QA sanitizer is the shipkit module, JSDoc types stripped', async () => {
	const src = await readFile(QA_PARAMS_SOURCE, 'utf8');
	const out = emitQaParams(src, { source: 'src/lib/qa-params.mjs' });
	assert.match(out, /export function sanitizeQa/);
	assert.match(out, /export const QA_DEFAULTS/);
	assert.doesNotMatch(out, /@type \{/);
	assert.doesNotMatch(out, /from '\.\/qa-params\.mjs'/);
});

test('DEFAULT_SPEC is a valid ux spec with one home screen', async () => {
	assert.deepEqual(await checkArtifact('ux-spec', DEFAULT_SPEC, 'ux.json'), []);
	assert.equal(DEFAULT_SPEC.screens.length, 1);
	assert.equal(DEFAULT_SPEC.screens[0].route, '/');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-support.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-support.mjs'`

- [ ] **Step 3: Implement**

```js
// src/lib/design-support.mjs
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/design-support.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-support.mjs test/design-support.test.mjs
git commit -m "feat(design): typed events, the monetization catalog, and the emitted sanitizer"
```

---

## Task 6: The screen emitter

**Files:**
- Create: `src/lib/design-screen.mjs`
- Modify: `schema/ux-spec.schema.json` (add optional `elements`), `src/lib/design-draft.mjs` (`draftSpec` `_todo`)
- Test: `test/design-screen.test.mjs`

**Interfaces:**
- Consumes: `withHeader` from `design-emit.mjs`
- Produces: `emitScreen(screen, {source}) => string`

- [ ] **Step 1: Add `elements` to the ux-spec schema**

In `schema/ux-spec.schema.json`, inside the screen item's `properties`, after `"components"`:

```json
"elements": {
	"type": "array",
	"description": "The screen's structure, in order. `ship design build` transcribes this 1:1 and infers nothing — a screen without it is generated as a plain list of its copy, not as a guessed layout.",
	"items": {
		"type": "object",
		"required": ["component"],
		"additionalProperties": false,
		"properties": {
			"component": { "type": "string", "description": "A component id from design/components.json." },
			"variant": { "type": "string" },
			"copy": { "type": "string", "description": "A key of this screen's `copy` object." },
			"event": { "type": "string", "description": "An event name this screen declares, fired on press." }
		}
	}
}
```

- [ ] **Step 2: Add it to the draft's `_todo`**

In `src/lib/design-draft.mjs`, in `draftSpec`'s returned object:

```js
		_todo: ['screens[].copy', 'screens[].elements', 'screens[].components', 'flows[].entry', 'flows[].success'],
```

- [ ] **Step 3: Write the failing test**

```js
// test/design-screen.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { emitScreen } from '../src/lib/design-screen.mjs';
import { reviewSources } from '../src/lib/design-review.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const SRC = 'design/ux.json';
const base = {
	id: 'paywall', route: '/paywall', flow: 'paywall', purpose: 'Sell.',
	copy: { title: 'Go Pro', cta: 'Start' },
	states: ['default', 'loading', 'error'],
	events: [
		{ name: 'paywall_viewed', flow: 'paywall', verb: 'viewed' },
		{ name: 'paywall_completed', flow: 'paywall', verb: 'completed' },
	],
	elements: [
		{ component: 'Text', variant: 'largeTitle', copy: 'title' },
		{ component: 'Button', variant: 'primary', copy: 'cta', event: 'paywall_completed' },
	],
};

test('elements are transcribed in order, with their variants', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /<Text role="largeTitle">\{copy\.title\}<\/Text>/);
	assert.match(out, /<Button variant="primary"/);
	assert.ok(out.indexOf('role="largeTitle"') < out.indexOf('<Button'));
});

test('the component is named for the screen and default-exported', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /export default function Paywall\(\)/);
});

test('every declared state becomes an early return', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /if \(state === 'loading'\) return <StateView kind="loading" \/>;/);
	assert.match(out, /if \(state === 'error'\) return <StateView kind="error" \/>;/);
	assert.doesNotMatch(out, /kind="default"/);
});

test('events are typed references, never string literals', () => {
	const out = emitScreen(base, { source: SRC });
	assert.match(out, /track\(EVENTS\.paywall_viewed\)/);
	assert.match(out, /track\(EVENTS\.paywall_completed\)/);
	assert.doesNotMatch(out, /track\('paywall/);
});

test('a screen with no elements gets the null layout and says so', () => {
	const { elements, ...bare } = base;
	const out = emitScreen(bare, { source: SRC });
	assert.match(out, /no elements were specified/i);
	assert.match(out, /<Text role="body">\{copy\.title\}<\/Text>/);
	assert.doesNotMatch(out, /<Button/);
});

test('monetization is re-exported as data, not written as a comment', () => {
	const out = emitScreen({ ...base, monetization: { offering: 'pro', entitlement: 'premium' } }, { source: SRC });
	assert.match(out, /export const monetization = MONETIZATION\.paywall;/);
});

test('a screen that sells nothing imports no catalog', () => {
	const out = emitScreen(base, { source: SRC });
	assert.doesNotMatch(out, /MONETIZATION/);
});

test('the generated screen passes `ship design review` — no literal it did not take from the system', () => {
	const out = emitScreen({ ...base, monetization: { offering: 'pro', entitlement: 'premium' } }, { source: SRC });
	const violations = reviewSources([{ path: 'app/paywall.tsx', source: out }], DEFAULT_SYSTEM);
	assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
});

test('copy is escaped, so an apostrophe cannot break the module', () => {
	const out = emitScreen({ ...base, copy: { title: "Don't stop", cta: 'Go' } }, { source: SRC });
	assert.match(out, /Don\\'t stop/);
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --test test/design-screen.test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/design-screen.mjs'`

- [ ] **Step 5: Implement**

```js
// src/lib/design-screen.mjs
// One ux.json screen → one expo-router route file.
//
// This is a transcriber. Every decision it could make is one the spec already
// made: `elements` gives the order and the variants, `copy` gives the strings,
// `states` gives the branches, `events` gives the names. Where `elements` is
// absent it emits the null layout — every copy key as body text — and says so
// in the file, because a guessed layout is worse than an obviously unfinished
// one that a reader will replace.
import { withHeader } from './design-emit.mjs';

/** @type {(value: string) => string} */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** JSX text is written as a `copy` reference, so escaping is a JS-string problem only. */
/** @type {(id: string) => string} */
function componentName(id) {
	return String(id)
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map(capitalize)
		.join('') || 'Screen';
}

/** @type {(word: string) => string} */
function capitalize(word) {
	return word[0].toUpperCase() + word.slice(1);
}

/** @type {(entry: [string, string]) => string} */
function copyRow([key, text]) {
	return `\t${key}: ${q(text)},`;
}

/** @type {(el: any) => string} */
function elementLine(el) {
	if (el.component === 'Button') {
		const variant = el.variant ? ` variant="${el.variant}"` : '';
		const press = el.event ? ` onPress={() => track(EVENTS.${el.event})}` : '';
		return `\t\t\t<Button${variant}${press}>{copy.${el.copy}}</Button>`;
	}
	if (el.component === 'Text') return `\t\t\t<Text role="${el.variant ?? 'body'}">{copy.${el.copy}}</Text>`;
	if (el.component === 'StateView') return `\t\t\t<StateView kind="${el.variant}" />`;
	const variant = el.variant ? ` variant="${el.variant}"` : '';
	return `\t\t\t<${el.component}${variant} />`;
}

/** @type {(key: string) => string} */
function nullLayoutLine(key) {
	return `\t\t\t<Text role="body">{copy.${key}}</Text>`;
}

/** @type {(state: string) => string} */
function stateLine(state) {
	return `\tif (state === ${q(state)}) return <StateView kind="${state}" />;`;
}

/** @type {(screen: any) => string[]} */
function usedComponents(screen) {
	const set = new Set(['Screen', 'Text']);
	if ((screen?.states ?? []).some(isNonDefault)) set.add('StateView');
	for (const el of screen?.elements ?? []) set.add(el.component);
	if (!screen?.elements) set.add('Text');
	return [...set].sort();
}

/** @type {(state: string) => boolean} */
function isNonDefault(state) {
	return state !== 'default';
}

/** @type {(event: any) => boolean} */
function isViewed(event) {
	return event?.verb === 'viewed';
}

/**
 * @type {(screen: any, opts: {source: string}) => string}
 */
export function emitScreen(screen, { source }) {
	const name = componentName(screen?.id);
	const copyEntries = Object.entries(screen?.copy ?? {});
	const states = (screen?.states ?? []).filter(isNonDefault);
	const viewed = (screen?.events ?? []).find(isViewed);
	const elements = screen?.elements;
	const sells = Boolean(screen?.monetization?.offering);

	const imports = [
		viewed ? "import { useEffect } from 'react';" : null,
		`import { ${usedComponents(screen).join(', ')} } from '../src/theme/primitives';`,
		"import { useQa } from '../src/theme/provider';",
		"import { track } from '../src/analytics';",
		"import { EVENTS } from '../src/analytics/events';",
		sells ? "import { MONETIZATION } from '../src/purchases/catalog';" : null,
	].filter(Boolean);

	const bodyLines = elements?.length
		? elements.map(elementLine)
		: ['\t\t\t{/* No elements were specified in design/ux.json, so no layout was invented.', '\t\t\t    Every copy key is rendered as body text. Add `elements` to the screen. */}',
		   ...copyEntries.map(copyKeyOf).map(nullLayoutLine)];

	const body = `${imports.join('\n')}

const copy = {
${copyEntries.map(copyRow).join('\n')}
} as const;
${sells ? `\nexport const monetization = MONETIZATION.${screen.id};\n` : ''}
export default function ${name}() {
	const { state } = useQa();
${viewed ? `\tuseEffect(() => {\n\t\ttrack(EVENTS.${viewed.name});\n\t}, []);\n` : ''}${states.map(stateLine).join('\n')}${states.length ? '\n' : ''}
	return (
		<Screen>
${bodyLines.join('\n')}
			{/* IMPLEMENT: this screen's real UI. The scaffold proves the route,
			    the theme and the states; it does not pretend to be the product. */}
		</Screen>
	);
}
`;
	return withHeader(body, { source });
}

/** @type {(entry: [string, string]) => string} */
function copyKeyOf(entry) {
	return entry[0];
}
```

- [ ] **Step 6: Run it and watch it pass**

Run: `node --test test/design-screen.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 7: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-screen.mjs schema/ux-spec.schema.json src/lib/design-draft.mjs test/design-screen.test.mjs
git commit -m "feat(design): the screen emitter, transcribing elements and inferring nothing"
```

---

## Task 7: Determinism and golden files

Byte-stability is what makes the hash mechanism meaningful, so it gets its own gate rather than being assumed by the other suites.

**Files:**
- Create: `test/design-determinism.test.mjs`, `test/fixtures/design/expected/tokens.ts.txt`, `test/fixtures/design/expected/paywall.tsx.txt`, `test/fixtures/design/expected/events.ts.txt`
- Test: as above

**Interfaces:**
- Consumes: every emitter from Tasks 3–6
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

```js
// test/design-determinism.test.mjs
// Identical inputs must produce identical bytes. The ownership hash in
// design-emit.mjs is meaningless otherwise: a generator that varied its output
// would report every file as hand-edited on the second run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { contractDoc } from '../src/lib/design-contract.mjs';
import { emitScreen } from '../src/lib/design-screen.mjs';
import { DEFAULT_SYSTEM, emitTokens } from '../src/lib/design-tokens.mjs';
import { emitCatalog, emitEvents } from '../src/lib/design-support.mjs';
import { clone, designSystem, uxSpec } from './fixtures/artifacts.mjs';

const SYS = 'design/system.json';
const UX = 'design/ux.json';
const screen = uxSpec.screens[0];

const CASES = [
	['tokens', () => emitTokens(designSystem, { source: SYS })],
	['screen', () => emitScreen(screen, { source: UX })],
	['events', () => emitEvents(uxSpec, { source: UX })],
	['catalog', () => emitCatalog(uxSpec, { source: UX })],
];

test('every emitter is byte-stable across runs', () => {
	for (const [name, emit] of CASES) assert.equal(emit(), emit(), `${name} varied between runs`);
});

test('every emitter is byte-stable against a deep clone of its input', () => {
	assert.equal(emitTokens(designSystem, { source: SYS }), emitTokens(clone(designSystem), { source: SYS }));
	assert.equal(emitScreen(screen, { source: UX }), emitScreen(clone(screen), { source: UX }));
	assert.equal(emitEvents(uxSpec, { source: UX }), emitEvents(clone(uxSpec), { source: UX }));
});

test('no emitted file carries a timestamp — it would make every run a diff', () => {
	for (const [name, emit] of CASES) {
		assert.doesNotMatch(emit(), /\d{4}-\d{2}-\d{2}T\d{2}:/, `${name} carries an ISO timestamp`);
		assert.doesNotMatch(emit(), /generatedAt/, `${name} carries generatedAt`);
	}
});

test('the contract document carries no timestamp either', () => {
	assert.ok(!('generatedAt' in contractDoc()));
});

const GOLDEN = [
	['tokens.ts.txt', () => emitTokens(DEFAULT_SYSTEM, { source: SYS })],
	['paywall.tsx.txt', () => emitScreen(screen, { source: UX })],
	['events.ts.txt', () => emitEvents(uxSpec, { source: UX })],
];

test('generated output matches its golden file', async (t) => {
	for (const [file, emit] of GOLDEN) {
		await t.test(file, async () => {
			const want = await readFile(new URL(`./fixtures/design/expected/${file}`, import.meta.url), 'utf8');
			assert.equal(emit(), want, `regenerate with UPDATE_GOLDEN=1 if this change is intended`);
		});
	}
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-determinism.test.mjs`
Expected: FAIL — `ENOENT` on the golden files

- [ ] **Step 3: Generate the golden files**

```bash
mkdir -p test/fixtures/design/expected
node -e "
import('./src/lib/design-tokens.mjs').then(async (tk) => {
  const sc = await import('./src/lib/design-screen.mjs');
  const sup = await import('./src/lib/design-support.mjs');
  const fx = await import('./test/fixtures/artifacts.mjs');
  const fs = await import('node:fs/promises');
  const SYS = 'design/system.json', UX = 'design/ux.json';
  await fs.writeFile('test/fixtures/design/expected/tokens.ts.txt', tk.emitTokens(tk.DEFAULT_SYSTEM, { source: SYS }));
  await fs.writeFile('test/fixtures/design/expected/paywall.tsx.txt', sc.emitScreen(fx.uxSpec.screens[0], { source: UX }));
  await fs.writeFile('test/fixtures/design/expected/events.ts.txt', sup.emitEvents(fx.uxSpec, { source: UX }));
});
"
```

**Read all three files before committing them.** A golden file nobody read is a rubber stamp: check that `tokens.ts.txt` has both themes and every ramp step, that `paywall.tsx.txt` compiles as TSX by eye and references `EVENTS.paywall_viewed`, and that `events.ts.txt` declares the union.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/design-determinism.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add test/design-determinism.test.mjs test/fixtures/design/
git commit -m "test(design): byte-stability, and golden files for three emitters"
```

---

## Task 8: The static primitives, provider and analytics seam

The generated code's other half. No shipkit logic — these are the files the contract in Task 2 describes.

**Files:**
- Create: `templates/app/src/theme/provider.tsx`, `templates/app/src/theme/primitives.tsx`, `templates/app/src/analytics/index.ts`
- Delete: `templates/app/app/index.tsx`
- Modify: `templates/app/app/_layout.tsx` (wrap in `ThemeProvider`, use primitives), `templates/app/package.json` if `expo-router`'s `useLocalSearchParams` needs no new dep (it does not)
- Test: covered by Task 10's command test and the CI smoke

**Interfaces:**
- Consumes: generated `src/theme/tokens.ts`, `src/theme/qa-params.ts`, `src/analytics/events.ts`
- Produces (the ABI generated screens compile against): `useQa() => {theme, state, locale, scale}`; `useTheme() => {colors, type, spacing, radii, scale}`; `<Screen scroll?>`; `<Text role>`; `<Button variant onPress disabled>`; `<StateView kind>`; `track(event: AppEvent)`

- [ ] **Step 1: Write the provider**

```tsx
// templates/app/src/theme/provider.tsx
// The QA contract's render half, and the only place the query parameters are
// read. `ship qa` drives the web build through routes with qaTheme/qaState/
// qaLocale/qaTextScale set; a build that ignores them captures the same screen
// N times and fails checkDarkMode and checkStates for a reason that is the
// app's fault, not the harness's.
import { createContext, useContext, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { tokens, type ThemeName } from './tokens';
import { sanitizeQa } from './qa-params';

const THEMES = Object.keys(tokens.color) as ThemeName[];

// expo-router honours these parameters over a deep link on native too, so an
// ungated release build would accept a URL that puts any screen into any state
// — a paywall in its success state included. Web is where QA runs; __DEV__ is
// where a developer needs them. A shipped IPA gets neither.
const QA_ENABLED = Platform.OS === 'web' || __DEV__;

export function useQa() {
	const params = useLocalSearchParams();
	return sanitizeQa(params, { enabled: QA_ENABLED, themes: THEMES });
}

const ThemeContext = createContext<ThemeName>('light');

export function ThemeProvider({ children }: { children: ReactNode }) {
	const system = useColorScheme();
	const { theme } = useQa();
	const active = (theme ?? system ?? 'light') as ThemeName;
	return <ThemeContext.Provider value={active}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const name = useContext(ThemeContext);
	const { scale } = useQa();
	return {
		name,
		colors: tokens.color[name],
		type: tokens.type,
		spacing: tokens.spacing,
		radii: tokens.radii,
		scale,
	};
}
```

- [ ] **Step 2: Write the primitives**

```tsx
// templates/app/src/theme/primitives.tsx
// The four components design/components.json describes. Generated screens
// compose these and nothing else, which is what lets `ship design review` gate
// styling: a screen that builds its own StyleSheet never mentions a token, so
// it would never trip a token rule.
import type { ReactNode } from 'react';
import { Pressable, SafeAreaView, ScrollView, Text as RNText, View } from 'react-native';
import { useTheme } from './provider';
import type { ColorToken, TypeRole } from './tokens';

export function Screen({ children, scroll = false }: { children: ReactNode; scroll?: boolean }) {
	const { colors, spacing } = useTheme();
	const inner = <View style={{ flex: 1, padding: spacing[5], gap: spacing[3] }}>{children}</View>;
	return (
		<SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
			{scroll ? <ScrollView>{inner}</ScrollView> : inner}
		</SafeAreaView>
	);
}

export function Text({ role = 'body', color = 'text', children }: {
	role?: TypeRole; color?: ColorToken; children: ReactNode;
}) {
	const { colors, type, scale } = useTheme();
	const step = type[role];
	return (
		<RNText style={{
			color: colors[color],
			fontSize: step.size * scale,
			lineHeight: step.lineHeight * scale,
			fontWeight: step.weight,
		}}>
			{children}
		</RNText>
	);
}

const FILL: Record<string, ColorToken> = { primary: 'accent', secondary: 'surface', destructive: 'danger' };
const LABEL: Record<string, ColorToken> = { primary: 'accentText', secondary: 'text', destructive: 'textInverse' };

export function Button({ variant = 'primary', disabled = false, onPress, children }: {
	variant?: 'primary' | 'secondary' | 'destructive';
	disabled?: boolean;
	onPress?: () => void;
	children: ReactNode;
}) {
	const { colors, spacing, radii, type, scale } = useTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				backgroundColor: colors[FILL[variant]],
				borderColor: colors.border,
				borderWidth: variant === 'secondary' ? 1 : 0,
				borderRadius: radii.md,
				paddingVertical: spacing[3],
				paddingHorizontal: spacing[4],
				// 44pt is the HIG minimum tap target, and `ship qa` measures it.
				minHeight: 44,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
			})}
		>
			<RNText style={{
				color: colors[LABEL[variant]],
				fontSize: type.headline.size * scale,
				lineHeight: type.headline.lineHeight * scale,
				fontWeight: type.headline.weight,
			}}>
				{children}
			</RNText>
		</Pressable>
	);
}

const STATE_COPY: Record<string, string> = {
	empty: 'Nothing here yet.',
	loading: 'Loading…',
	error: 'Something went wrong.',
	offline: 'You are offline.',
};

export function StateView({ kind }: { kind: 'empty' | 'loading' | 'error' | 'offline' }) {
	const { colors, spacing } = useTheme();
	return (
		<View style={{
			flex: 1, alignItems: 'center', justifyContent: 'center',
			padding: spacing[5], backgroundColor: colors.background,
		}}>
			<Text role="body" color="textMuted">{STATE_COPY[kind]}</Text>
		</View>
	);
}
```

- [ ] **Step 3: Write the analytics seam**

```ts
// templates/app/src/analytics/index.ts
// The seam an SDK plugs into. `track` accepts only events design/ux.json
// declares, because src/analytics/events.ts is generated from it — so an event
// nobody specified is a typecheck error rather than a string no funnel joins.
import type { AppEvent } from './events';

export function track(event: AppEvent, props?: Record<string, string | number | boolean>) {
	if (__DEV__) console.log('[analytics]', event, props ?? {});
	// Wire your SDK here. The event vocabulary is fixed by design/ux.json and
	// `ship analytics` reads the same names.
}
```

- [ ] **Step 4: Wrap the root layout, and delete the old home screen**

In `templates/app/app/_layout.tsx`: import `ThemeProvider` from `../src/theme/provider` and the primitives, wrap `<Stack />` in `<ThemeProvider>`, and rewrite `ErrorBoundary` to use `Screen`/`Text`/`Button` so it carries no literals of its own.

```bash
git rm templates/app/app/index.tsx
```

- [ ] **Step 5: Verify the tree still scaffolds**

Run:
```bash
node bin/ship new smoke-app --dir /tmp/claude-1000/-home-myen-shipkit/scratch-smoke --bundle-id com.smoke.app --dry-run
```
Expected: lists the template files, no `app/index.tsx`, includes the three new static files. (Generation of `index.tsx` arrives in Task 10 — a `--dry-run` here only proves the template tree is intact.)

- [ ] **Step 6: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add -A templates/app
git commit -m "feat(app): the themed primitives, the QA-aware provider, the analytics seam"
```

---

## Task 9: `ship design review` grows teeth

**Files:**
- Modify: `src/lib/design-review.mjs`, `src/commands/design.mjs` (widen the exemption to `src/theme/`)
- Test: `test/design-review.test.mjs`

**Interfaces:**
- Consumes: nothing new
- Produces: `EXCEPTIONS` (the exported allowlist); `scanLine` gains the new rules

- [ ] **Step 1: Write the failing test**

```js
// test/design-review.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXCEPTIONS, reviewSources } from '../src/lib/design-review.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const scan = (source, path = 'app/home.tsx') => reviewSources([{ path, source }], DEFAULT_SYSTEM);
const kinds = (source, path) => scan(source, path).map((v) => v.kind);

test('a screen that builds its own StyleSheet is caught', () => {
	assert.ok(kinds('const s = StyleSheet.create({ a: { flex: 1 } });').includes('stylesheet'));
});

test('an inline style with a numeric literal is caught', () => {
	assert.ok(kinds('<View style={{ padding: 13 }} />').includes('inline-style'));
});

test('importing a raw primitive into a screen is caught', () => {
	assert.ok(kinds("import { View, Text } from 'react-native';").includes('raw-primitive'));
});

test('a 3-digit hex is caught, which the old rule missed', () => {
	assert.ok(kinds("const c = '#fff';").includes('color'));
});

test('the documented exceptions do not fire', () => {
	for (const source of [
		'<View style={{ flex: 1 }} />',
		'<View style={{ opacity: 1 }} />',
		'<View style={{ borderWidth: 1 }} />',
		'<View style={{ zIndex: 0 }} />',
		'const h = StyleSheet.hairlineWidth;',
		"const p = Platform.select({ ios: 'a', android: 'b' });",
	]) assert.deepEqual(scan(source), [], source);
});

test('src/theme is where tokens legitimately become literals', () => {
	assert.deepEqual(scan("const c = '#abcdef';\nconst s = StyleSheet.create({});", 'src/theme/primitives.tsx'), []);
});

test('the exception list is data, so it can be reviewed', () => {
	assert.ok(Array.isArray(EXCEPTIONS.styleKeys));
	assert.ok(EXCEPTIONS.styleKeys.includes('flex'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-review.test.mjs`
Expected: FAIL — `EXCEPTIONS` is not exported

- [ ] **Step 3: Implement**

In `src/lib/design-review.mjs`, add above `scanLine`:

```js
/**
 * What the styling rules deliberately allow. A noisy gate is a disabled gate,
 * so every exception is data here rather than a special case buried in a regex.
 */
export const EXCEPTIONS = {
	/** Platform constants, not design decisions: none of these come from a scale. */
	styleKeys: ['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'borderWidth', 'aspectRatio'],
	/** 0 and 1 are identity values everywhere in RN layout. */
	numbers: [0, 1],
	/** Expressions that are their own justification. */
	identifiers: ['StyleSheet.hairlineWidth', 'Platform.select', 'Dimensions'],
	/** Where tokens legitimately become literals. */
	dirs: ['src/theme/'],
};

const EXCEPT_KEY = new RegExp(`\\b(${EXCEPTIONS.styleKeys.join('|')})\\s*:`);
const INLINE_NUMBER = /style=\{\{[^}]*?\b([a-zA-Z]+)\s*:\s*(-?\d+(?:\.\d+)?)/g;
const RAW_PRIMITIVE = /import\s*\{[^}]*\b(View|Text|Pressable|TouchableOpacity)\b[^}]*\}\s*from\s*'react-native'/;
```

Extend `scanLine` with the new rules, each guarded by the exceptions:

```js
	if (/\bStyleSheet\.create\s*\(/.test(line)) hit('stylesheet', 'StyleSheet.create outside src/theme — styling belongs in the primitives');
	for (const m of matches(INLINE_NUMBER, line))
		if (!EXCEPTIONS.styleKeys.includes(m[1]) && !EXCEPTIONS.numbers.includes(Number(m[2])))
			hit('inline-style', `inline ${m[1]} ${m[2]} — take it from the spacing scale via a primitive`);
	if (RAW_PRIMITIVE.test(line)) hit('raw-primitive', 'react-native primitive imported directly — screens compose src/theme/primitives');
```

Widen the hex rule to three digits by replacing its regex with `/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g`, and normalise a 3-digit match to 6 before the `Set` lookup with a named helper:

```js
/** `#fff` and `#ffffff` are the same colour; the system stores the long form. */
function expandHex(hex) {
	const body = hex.slice(1);
	return body.length === 3 ? `#${[...body].map(twice).join('')}`.toLowerCase() : hex.toLowerCase();
}
/** @type {(ch: string) => string} */
function twice(ch) {
	return ch + ch;
}
```

Then in `reviewSources`, skip a file whose path starts with any `EXCEPTIONS.dirs` entry, in addition to the existing `tokens` set. In `src/commands/design.mjs`, replace the token-file regex with a `src/theme/` prefix test so the whole directory is exempt.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/design-review.test.mjs && node --test test/design-command.test.mjs`
Expected: PASS both — the second confirms the existing review tests still hold.

- [ ] **Step 5: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/design-review.mjs src/commands/design.mjs test/design-review.test.mjs
git commit -m "feat(design): review catches styling that bypasses the system, with a reviewable exception list"
```

---

## Task 10: `ship design build`, and `ship new` over the same emitters

**Files:**
- Modify: `src/commands/design.mjs` (add `build`), `src/commands/new.mjs` (emit the scaffold's generated files), `src/lib/design-spec.mjs` (`checkSpec` takes the contract)
- Test: `test/design-command.test.mjs` (extended)

**Interfaces:**
- Consumes: every emitter from Tasks 2–6
- Produces: `ship design build` writing six kinds of file; `ship new` writing the same files from `DEFAULT_SYSTEM` and `DEFAULT_SPEC`

- [ ] **Step 1: Write the failing test**

Append to `test/design-command.test.mjs`:

```js
import { existsSync } from 'node:fs';
import { contractDoc } from '../src/lib/design-contract.mjs';
import { DEFAULT_SYSTEM } from '../src/lib/design-tokens.mjs';

const buildable = () => ({
	'design/system.json': DEFAULT_SYSTEM,
	'design/ux.json': {
		screens: [{
			id: 'home', route: '/', flow: 'home', purpose: 'Land.',
			copy: { title: 'Hello' }, states: ['default', 'empty'],
			events: [{ name: 'home_viewed', flow: 'home', verb: 'viewed' }],
			elements: [{ component: 'Text', variant: 'largeTitle', copy: 'title' }],
		}],
		flows: [{ id: 'home', screens: ['home'], success: 'The first screen renders.' }],
	},
});

test('build writes the tokens, the route, the events and the contract', async () => {
	const dir = await repo({ files: buildable() });
	assert.equal(await inRepo(dir, ['build']), 0);
	for (const rel of ['src/theme/tokens.ts', 'src/theme/qa-params.ts', 'src/analytics/events.ts', 'app/index.tsx', 'design/components.json'])
		assert.ok(existsSync(join(dir, rel)), `missing ${rel}`);
	const screen = await readFile(join(dir, 'app/index.tsx'), 'utf8');
	assert.match(screen, /export default function Home\(\)/);
	assert.match(screen, /kind="empty"/);
});

test('a second build is a no-op, not a refusal', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	assert.equal(await inRepo(dir, ['build']), 0);
});

test('a hand-edited file is refused by name, and every one at once', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	for (const rel of ['app/index.tsx', 'src/theme/tokens.ts']) {
		const text = await readFile(join(dir, rel), 'utf8');
		await writeFile(join(dir, rel), `${text}\n// mine\n`);
	}
	const err = await inRepo(dir, ['build']).then(() => null, (e) => e);
	assert.ok(err, 'expected a refusal');
	assert.match(err.message + err.hint, /app\/index\.tsx/);
	assert.match(err.message + err.hint, /tokens\.ts/);
});

test('--force takes an edited file back', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	await writeFile(join(dir, 'app/index.tsx'), 'export default function X() { return null; }\n');
	assert.equal(await inRepo(dir, ['build'], { force: true }), 0);
	assert.match(await readFile(join(dir, 'app/index.tsx'), 'utf8'), /@generated/);
});

test('--check writes nothing', async () => {
	const dir = await repo({ files: buildable() });
	assert.equal(await inRepo(dir, ['build'], { check: true }), 0);
	assert.ok(!existsSync(join(dir, 'app/index.tsx')));
});

test('a spec that violates the contract is refused before a byte is written', async () => {
	const files = buildable();
	files['design/ux.json'].screens[0].elements = [{ component: 'Carousel', copy: 'title' }];
	const dir = await repo({ files });
	const err = await inRepo(dir, ['build']).then(() => null, (e) => e);
	assert.ok(err);
	assert.match(err.message + err.hint, /Carousel/);
	assert.ok(!existsSync(join(dir, 'app/index.tsx')), 'nothing may be written on a failed validation');
});

test('the generated tree passes design review', async () => {
	const dir = await repo({ files: buildable() });
	await inRepo(dir, ['build']);
	assert.equal(await inRepo(dir, ['review']), 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/design-command.test.mjs`
Expected: FAIL — `design: unknown subcommand "build"`

- [ ] **Step 3: Implement `build` in `src/commands/design.mjs`**

Add the imports, then a `build` function and `SUB.build`. The shape:

```js
/**
 * Everything this repo would generate, as {rel, body} — computed before a byte
 * is written, so a failed validation leaves no half-generated tree behind.
 * @type {(cfg: Config, system: any, spec: any) => {rel: string, body: string}[]}
 */
async function planFiles(cfg, system, spec) {
	const qaSrc = await readFile(QA_PARAMS_SOURCE, 'utf8');
	const files = [
		{ rel: 'src/theme/tokens.ts', body: emitTokens(system, { source: 'design/system.json' }) },
		{ rel: 'src/theme/qa-params.ts', body: emitQaParams(qaSrc, { source: 'src/lib/qa-params.mjs' }) },
		{ rel: 'src/analytics/events.ts', body: emitEvents(spec, { source: 'design/ux.json' }) },
		{ rel: 'src/purchases/catalog.ts', body: emitCatalog(spec, { source: 'design/ux.json' }) },
	];
	for (const screen of spec?.screens ?? [])
		files.push({ rel: routeToFile(screen.route), body: emitScreen(screen, { source: 'design/ux.json' }) });
	return files;
}
```

`build` then:
1. loads the config, `system.json` (strict) and `ux.json` (strict), refusing either as a draft by name via `refuseDraft`;
2. reads `design/components.json` if present, else uses `contractDoc()`;
3. runs `gate('build', [...await checkArtifact('ux-spec', …), ...validateAgainstContract(spec, contract, system)])`;
4. computes the plan, reads each destination, calls `classify`;
5. collects every `edited`/`foreign` into one `ShipError` naming all of them, hint `--force to overwrite, or revert them`, unless `flags.force`;
6. on `--check`, prints the plan table and returns 0 without writing;
7. writes each file (`mkdir` recursive), writes `design/components.json` via `writeJSON` with `_generated`, prints a table of `rel`/action, returns 0.

Register `build` in `SUB` and add its line to `help`.

Also change `checkSpec(existing, { components: ids })` in `spec` to pass the contract through, and update `src/lib/design-spec.mjs`'s `checkComponents` to read `Object.keys(contract.components)` — keeping its existing "skipped when absent" behaviour.

- [ ] **Step 4: Point `ship new` at the same emitters**

In `src/commands/new.mjs`, after `writeScaffold` and before `ship init`, write the generated files from the built-in defaults:

```js
/**
 * The scaffold's generated half. It runs through the same emitters `ship design
 * build` uses, against shipkit's built-in default system and one-screen spec —
 * so there is one authority per generated file, and the first `design build`
 * replaces every one of them cleanly rather than colliding with a template.
 */
async function writeGenerated(targetDir, vars, dry) {
	if (dry) return;
	const { emitTokens, DEFAULT_SYSTEM } = await import('../lib/design-tokens.mjs');
	const { emitScreen } = await import('../lib/design-screen.mjs');
	const { emitEvents, emitCatalog, emitQaParams, QA_PARAMS_SOURCE, DEFAULT_SPEC } = await import('../lib/design-support.mjs');
	const { contractDoc } = await import('../lib/design-contract.mjs');
	const { routeToFile } = await import('../lib/design-emit.mjs');
	const source = "shipkit's default design system";
	const system = { ...DEFAULT_SYSTEM, brand: { ...DEFAULT_SYSTEM.brand, name: vars.NAME } };
	const spec = withAppName(DEFAULT_SPEC, vars.NAME);
	// … write tokens.ts, qa-params.ts, events.ts, catalog.ts, the one route, and design/components.json
}
```

`withAppName` replaces `DEFAULT_SPEC`'s `copy.title` with the display name — a named helper so the default spec itself is never mutated.

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test test/design-command.test.mjs`
Expected: PASS, including the seven new tests

- [ ] **Step 6: Scaffold a real app and confirm it is coherent**

```bash
rm -rf /tmp/claude-1000/-home-myen-shipkit/scratch-smoke
node bin/ship new smoke-app --dir /tmp/claude-1000/-home-myen-shipkit/scratch-smoke --bundle-id com.smoke.app
ls /tmp/claude-1000/-home-myen-shipkit/scratch-smoke/src/theme/
head -20 /tmp/claude-1000/-home-myen-shipkit/scratch-smoke/app/index.tsx
```
Expected: `tokens.ts`, `qa-params.ts`, `provider.tsx`, `primitives.tsx` all present; `app/index.tsx` carries an `@generated` header and a `Home` component.

- [ ] **Step 7: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/commands/design.mjs src/commands/new.mjs src/lib/design-spec.mjs test/design-command.test.mjs
git commit -m "feat(design): ship design build, and a scaffold generated by the same emitters"
```

---

## Task 11: CI smoke, docs and the skill

**Files:**
- Modify: the scaffold job in `.github/workflows/` (find it with `grep -rl 'ship new' .github/`), `skills/designing-apps/SKILL.md`, `docs/shipkit-2.0.md` (mark item 12 done)
- Test: the CI job itself

**Interfaces:**
- Consumes: everything
- Produces: nothing

- [ ] **Step 1: Extend the CI scaffold job**

After the existing `ship new` step, add:

```yaml
      - name: design pipeline over the scaffold
        working-directory: ${{ runner.temp }}/scaffold
        run: |
          node "$GITHUB_WORKSPACE/bin/ship" design system --check
          node "$GITHUB_WORKSPACE/bin/ship" design build
          node "$GITHUB_WORKSPACE/bin/ship" design review
```

`design system --check` runs against the scaffold, which has no `design/system.json` — so add a step before it that writes one from the default, or drop that line if the scaffold does not ship the artifact. Verify which by running the three commands locally against `/tmp/claude-1000/-home-myen-shipkit/scratch-smoke` first and matching the CI steps to what actually works.

- [ ] **Step 2: Document the loop in the skill**

In `skills/designing-apps/SKILL.md`, add `ship design build` to the command sequence and state the two rules an agent must know: **the generator infers nothing** (fill `elements` or get the null layout), and **generated files are refused if hand-edited** (`--force` takes them back).

- [ ] **Step 3: Mark the roadmap item done**

In `docs/shipkit-2.0.md` §10, change item 12 to `**DONE.**` with a one-line summary, and strike audit row 1 in §1.5 the way rows 2 and 8 are struck.

- [ ] **Step 4: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
npx tsc --noEmit 2>&1 | grep -c 'error TS'   # must not exceed 351
git add -A
git commit -m "ci(design): smoke the design pipeline over a real scaffold; docs"
```

---

## Task 12: `ship qa` reports an undrivable route SKIPPED, never FAIL

The spec (§12) says a dynamic route generates normally and `ship qa` skips it with a reason. Without this, `planMatrix` builds a cell for `/item/[id]`, the capture 404s, and every rule on that screen fails for a tooling reason rather than a quality one.

**Files:**
- Modify: `src/lib/qa-matrix.mjs`, `src/lib/qa-run.mjs`, `src/commands/qa.mjs`
- Test: `test/qa-matrix.test.mjs`, `test/qa-run.test.mjs` (both exist)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `isDrivable(route) => boolean` in `qa-matrix.mjs`; `undrivableRows(spec) => Check[]` in `qa-run.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/qa-matrix.test.mjs`:

```js
import { isDrivable } from '../src/lib/qa-matrix.mjs';

test('a dynamic segment is not drivable — there is no id to drive it with', () => {
	assert.equal(isDrivable('/paywall'), true);
	assert.equal(isDrivable('/'), true);
	assert.equal(isDrivable('/item/[id]'), false);
	assert.equal(isDrivable('/blog/[...slug]'), false);
});

test('planMatrix builds no cell for an undrivable screen', () => {
	const spec = { screens: [
		{ id: 'home', route: '/', flow: 'home', states: ['default'] },
		{ id: 'item', route: '/item/[id]', flow: 'detail', states: ['default'] },
	] };
	const cells = planMatrix(spec, { themes: ['light'] });
	assert.deepEqual([...new Set(cells.map((c) => c.screen))], ['home']);
});
```

Append to `test/qa-run.test.mjs`:

```js
import { undrivableRows } from '../src/lib/qa-run.mjs';

test('an undrivable screen is SKIPPED with the reason, never FAIL', () => {
	const spec = { screens: [
		{ id: 'home', route: '/', flow: 'home' },
		{ id: 'item', route: '/item/[id]', flow: 'detail' },
	] };
	const rows = undrivableRows(spec);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'SKIPPED');
	assert.equal(rows[0].screen, 'item');
	assert.match(rows[0].message, /dynamic segment/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/qa-matrix.test.mjs test/qa-run.test.mjs`
Expected: FAIL — `isDrivable` and `undrivableRows` are not exported

- [ ] **Step 3: Implement**

In `src/lib/qa-matrix.mjs`, above `planMatrix`:

```js
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
```

and in `planMatrix`'s screen loop, before building any cell:

```js
		if (!isDrivable(screen?.route)) continue;
```

In `src/lib/qa-run.mjs`, beside `tier2Rows`:

```js
/**
 * One SKIPPED row per screen Tier 1 cannot reach, so the report states what was
 * not measured instead of omitting the screen entirely. SKIPPED, never PASS:
 * a screen nobody captured has proven nothing.
 * @type {(spec: any) => Check[]}
 */
export function undrivableRows(spec) {
	/** @type {Check[]} */
	const out = [];
	for (const screen of spec?.screens ?? []) {
		if (isDrivable(screen?.route)) continue;
		out.push({
			id: `route-${screen.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
			category: 'route',
			requiresTier: 1,
			status: 'SKIPPED',
			screen: screen.id,
			flow: screen.flow,
			message: `route ${screen.route} has a dynamic segment — Tier 1 has no id to drive it with`,
		});
	}
	return out;
}
```

with `import { cellId, isDrivable } from './qa-matrix.mjs';` at the top.

In `src/commands/qa.mjs`, add `...undrivableRows(spec)` to the checks array alongside `...tier2Rows(spec)`.

- [ ] **Step 4: Confirm `route` is a legal category**

Run: `grep -n 'category' schema/qa-report.schema.json`

If `category` is an `enum`, add `"route"` to it. If it is a free string, nothing to change.

- [ ] **Step 5: Run them and watch them pass**

Run: `node --test test/qa-matrix.test.mjs test/qa-run.test.mjs`
Expected: PASS

- [ ] **Step 6: Full gates, then commit**

```bash
npm run lint && npm test && npm run test:c8 && npm run metrics
git add src/lib/qa-matrix.mjs src/lib/qa-run.mjs src/commands/qa.mjs schema/qa-report.schema.json test/qa-matrix.test.mjs test/qa-run.test.mjs
git commit -m "feat(qa): an undrivable route is SKIPPED with its reason, never FAIL"
```

---

## Self-Review

**Spec coverage.** §2 contract → Task 2. §5 generated/static line → Tasks 4, 5, 6, 8. §5 one authority for `tokens.ts` → Task 10 step 4 (`ship new` over the emitters) plus Task 8 step 4 (deleting the template's `index.tsx`). §6 headers → Task 3; §6 byte-stability → Task 7. §7 `elements` → Task 6 steps 1–2. §8 validation → Task 2 plus Task 10 step 3. §9 typed events → Task 5. §10 QA sanitizer → Task 1, wired in Task 8. §11 monetization → Task 5 `emitCatalog`, consumed in Task 6. §12 routes → Task 3 `routeToFile`; §12 review teeth → Task 9. §13 modules and tests → all tasks. `contractVersion` refusal → Task 2's last-but-one test.

**Gap found and closed.** The first pass of this plan implemented §12's route mapping but not its claim that `ship qa` reports a dynamic route `SKIPPED` rather than `FAIL` — `routeToFile` would generate `/item/[id]`, `planMatrix` would build a cell for it, the capture would 404, and every rule on that screen would fail for a tooling reason. That is Task 12, added rather than deferred: shipping the generator without it would leave the spec describing behaviour the code does not have.

**Type consistency.** `emitTokens(system, {source})`, `emitScreen(screen, {source})`, `emitEvents(spec, {source})`, `emitCatalog(spec, {source})`, `emitQaParams(src, {source})` — every emitter takes `{source}` and returns a string; used consistently in Tasks 7 and 10. `classify(text|null, body)` returns the four strings Task 10 branches on. `sanitizeQa(raw, {enabled, themes, states})` is called with `{enabled, themes}` in Task 8's provider, which is why `states` has a default in Task 1. `requiredTokens` returns `{type, color, radii, spacingSteps}`, consumed only inside `checkTokens`.
