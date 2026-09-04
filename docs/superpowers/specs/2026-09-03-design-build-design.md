# `ship design build` — growing `templates/app` from the design system

Status: **approved design, revision 2**. Date: 2026-09-03. Baseline: `master` @ `dd58163`.
Implements roadmap item 12 of `docs/shipkit-2.0.md` (§10, P1).

Revision 2 makes the component contract the centre of the design: the generator
transcribes a validated spec against a declared contract and infers nothing.

---

## 1. The problem

`templates/app` is one screen. Audit row 1 of the Shipkit 2.0 plan calls this
the P0 gap: "Build" means scaffold, not build.

The consequence is concrete rather than aesthetic. `ship qa` drives an app
through the routes named in `design/ux.json` and measures contrast, tap targets,
safe-area padding, Dynamic Type overflow and dark-mode completeness on what comes
back. A scaffold with one route gives it one route to drive. Every rule in
`lib/qa-checks.mjs` is then measuring a screen the spec never described.

`ship qa` also depends on a contract the generated app has to honour by hand
today. `lib/qa-matrix.mjs` sets four query parameters per capture —
`qaTheme`, `qaState`, `qaLocale`, `qaTextScale` — and says so in its own header:

> A build that ignores them still captures cleanly — it just captures the same
> screen N times.

Nothing in `templates/app` reads them. The contract is documented on the capture
side and unimplemented on the render side, so the checks that exist to catch
exactly that (`checkDarkMode`, `checkStates`) fail on every generated app for a
reason that is shipkit's own fault.

## 2. Scope, and the one rule that bounds it

**`ship design build` is a transcriber, not a designer.**

It converts two validated artifacts into a structurally complete, safe
implementation scaffold. It does not infer layout, choose a component, pick a
type role, or invent a screen. Where the spec is silent, the generator emits the
null layout and says so — it never fills the gap with a guess.

Sophisticated UI is the AI implementation phase's job, working inside the
scaffold. This is the same split the rest of shipkit already runs on: Node
writes what it can derive, omits what is a judgement, and gates both.

**In scope.** A fourth subcommand, `ship design build`. A real component
contract at `design/components.json`. Validation of `ux.json` against that
contract. Generated tokens, routes, typed events, structured monetization and a
QA-parameter sanitizer.

**Out of scope.** Domain logic. RevenueCat wiring. Any per-flow layout library.
Any heuristic that maps a copy key, a screen name or a flow id onto a visual
decision.

**Explicitly rejected.** Generating the primitives themselves (§5). Inferring
element structure from copy keys — revision 1 proposed a `title`→`largeTitle`
mapping table and it is gone, replaced by the explicit `elements` array in §7.

## 3. Command surface

```
ship design system   → design/system.json          (exists)
ship design spec     → design/ux.json              (exists)
ship design build    → app/*.tsx, src/theme/*      NEW
ship design review   → gates the implementation    (exists, strengthened §12)
```

`build` sits in the `design` group rather than under `ship build`, which already
means "produce an IPA via EAS". Two meanings of the word in one command costs
more than a crowded subcommand list.

```
ship design build [--force] [--check] [--json]
```

`--force` overwrites files hand-edited since generation. `--check` validates and
prints the file plan without writing — the same verb `design system` uses.
`--json` prints the plan as JSON.

No new config block. Everything derives from `cfg.paths.app`, `cfg.paths.design`
and `cfg.paths.designSystem`, which already exist.

## 4. The component contract

`design/components.json` is the **contract between generated screens and the
static primitives**: what components exist, what variants and states each
supports, what props it takes, and which design tokens it requires in order to
render at all.

It is authored by shipkit — the primitives are shipkit's own code, so shipkit
declares what they support — and written to the app repo by `design build` so
that `design spec` and any implementing agent can read it without importing
shipkit.

```jsonc
{
  "_generated": { "by": "ship design build", "contractVersion": 1, "hash": "…" },
  "contractVersion": 1,
  "components": {
    "Screen": {
      "primitive": "SafeAreaView",
      "file": "src/theme/primitives.tsx",
      "role": "container",
      "props": { "scroll": { "type": "boolean", "default": false } },
      "variants": [],
      "states": [],
      "requires": { "color": ["background"], "spacingSteps": 6 }
    },
    "Text": {
      "primitive": "Text",
      "file": "src/theme/primitives.tsx",
      "role": "content",
      "props": { "role": { "type": "enum", "values": ["largeTitle", "title", "headline", "body", "footnote"] } },
      "variants": ["largeTitle", "title", "headline", "body", "footnote"],
      "states": [],
      "requires": { "type": ["largeTitle", "title", "headline", "body", "footnote"],
                    "color": ["text", "textMuted"] }
    },
    "Button": {
      "primitive": "Pressable",
      "file": "src/theme/primitives.tsx",
      "role": "action",
      "props": { "variant": { "type": "enum", "values": ["primary", "secondary", "destructive"] },
                 "disabled": { "type": "boolean", "default": false } },
      "variants": ["primary", "secondary", "destructive"],
      "states": ["default", "pressed", "disabled", "loading"],
      "requires": { "color": ["accent", "accentText", "border", "danger", "textInverse"],
                    "radii": ["md"], "type": ["headline"], "spacingSteps": 5 }
    },
    "StateView": {
      "primitive": "View",
      "file": "src/theme/primitives.tsx",
      "role": "state",
      "props": { "kind": { "type": "enum", "values": ["empty", "loading", "error", "offline"] } },
      "variants": ["empty", "loading", "error", "offline"],
      "states": [],
      "requires": { "color": ["background", "textMuted"], "type": ["body"], "spacingSteps": 6 }
    }
  }
}
```

Governed by a new `schema/components.schema.json`, validated in CI by the ajv
step that already covers `schema/`.

**`requires` is the single source of the token gate.** Revision 1 hardcoded a
list of type roles the primitives use; that list now lives here, and the gate in
§8 is computed from it. One place declares what a primitive needs, and both the
validator and the token emitter read it.

`contractVersion` exists so a scaffold generated against an older contract can
be detected rather than silently mis-transcribed. `design build` refuses a
`components.json` whose `contractVersion` is newer than the one it ships.

## 5. The generated / static line

The line falls where the data/code line falls: token *values* vary with the
design system, the components consuming them do not.

### Generated — every one of these, always, by the same emitters

| File | Source |
| --- | --- |
| `src/theme/tokens.ts` | `design/system.json` |
| `src/theme/qa-params.ts` | shipkit's `lib/qa-params.mjs` (§10) |
| `src/analytics/events.ts` | `design/ux.json` events (§9) |
| `src/purchases/catalog.ts` | `design/ux.json` monetization blocks (§11) |
| `app/<route>.tsx`, one per screen | `design/ux.json` |
| `design/components.json` | shipkit's component contract (§4) |

### Static, shipped in `templates/app`

| File | Why it is not generated |
| --- | --- |
| `src/theme/provider.tsx` | `ThemeProvider`, `useTheme`, `useQa`. Reviewable code, not a template literal. |
| `src/theme/primitives.tsx` | `Screen`, `Text`, `Button`, `StateView`. The contract in §4 describes exactly this file. |
| `src/analytics/index.ts` | `track(event: AppEvent)`. The seam an SDK plugs into. |

Generating the primitives was considered and rejected: every line of React
Native becomes a string inside a `.mjs`, the emitters split three or four ways
against the 500-line limit, and code that should be reviewed becomes code that
is concatenated.

### One authority for `tokens.ts`

**`templates/app` ships no generated-shaped file.** No `tokens.ts`, no
`app/index.tsx`. Revision 1 had the template ship both as static files carrying
a generated header, which meant one path on disk had two authors.

Instead, `ship new` calls the same emitters `design build` calls, against
shipkit's built-in `DEFAULT_SYSTEM` and a built-in single-screen `DEFAULT_SPEC`:

```
ship new           → tokens.ts   from DEFAULT_SYSTEM   (header names the default)
                   → index.tsx   from DEFAULT_SPEC
                   → qa-params.ts, events.ts, components.json
ship design build  → the same files, from design/system.json + design/ux.json
```

One emitter per file, one code path, one authority. The scaffold still installs,
boots and renders — the property `ship new`'s header calls load-bearing — and
the first `design build` replaces every file cleanly, because every one of them
was already generated and hashes as such.

`ship design system`'s draft flow is untouched: `DEFAULT_SYSTEM` is a shipkit
constant, never written to `design/system.json`, so the agent is still asked to
choose a hue and the `--check` gate still refuses until it does.

## 6. Ownership, regeneration, and byte-stability

Every generated file carries a header:

```
// @generated by `ship design build` from design/system.json
// @contract 1
// @hash 3f2a1c9e
// Edit freely. `ship design build` refuses to overwrite a changed file and
// names it, rather than destroying your work. --force takes it back.
```

`@hash` is the first 8 hex of the sha256 of the body **below** the header, so
the header is never self-referential and reformatting the comment does not
falsify the hash.

| On disk | Recomputed hash | Action |
| --- | --- | --- |
| absent | — | write |
| header present | matches | write |
| header present | differs | **refuse**, name the file |
| no header | — | **refuse**, name the file (foreign) |

`--force` writes regardless. Refusals are collected and reported together — the
gate's error message is the agent's contract, and fixing one file per run is how
a build takes ten rounds.

JSON artifacts cannot carry a `//` header, so `design/components.json` uses
`"_generated"`. Every schema in this repo already tolerates `^_`.

### Byte-stability is a requirement, not a property

**Identical inputs must produce byte-identical output.** The hash mechanism in
this section is meaningless otherwise: a generator that varies its output across
runs reports every file as hand-edited on the second run.

Concretely:

- Every emitter is a pure function of its argument. No `Date.now()`, no
  `new Date()`, no `process.env`, no filesystem read, no randomness, no
  iteration over an unordered `Set`.
- **Generated files carry no timestamp.** This deliberately diverges from the
  repo's other artifacts, which all carry `generatedAt`; a timestamp inside a
  hashed file makes every run a diff. `_generated` in `components.json` carries
  `by`, `contractVersion` and `hash` only.
- Object key order is explicit — emitters iterate declared arrays or sorted
  keys, never raw `Object.keys` order inherited from a parsed document.
- Emitted source is written in the repo's formatting (tabs, single quotes,
  trailing commas) so the app repo's formatter is a no-op on it.

Tested directly: emit twice from the same input and from a deep clone, assert
byte equality (§13).

## 7. What a screen emits, and the `elements` array

Revision 1 inferred element structure from copy-key names. That is exactly the
inference §2 forbids, so it is replaced by an explicit, ordered, validated
`elements` array on each screen — an additive, optional field in
`schema/ux-spec.schema.json`:

```jsonc
"elements": [
  { "component": "Text",   "variant": "largeTitle", "copy": "title" },
  { "component": "Text",   "variant": "body",       "copy": "subtitle" },
  { "component": "Button", "variant": "primary",    "copy": "cta", "event": "paywall_completed" }
]
```

Generation is then a 1:1 transcription with no decisions in it:

```tsx
// @generated by `ship design build` from design/ux.json
// @contract 1
// @hash …

import { useEffect } from 'react';
import { Button, Screen, StateView, Text } from '../src/theme/primitives';
import { useQa } from '../src/theme/provider';
import { track } from '../src/analytics';
import { EVENTS } from '../src/analytics/events';
import { MONETIZATION } from '../src/purchases/catalog';

const copy = {
	title: 'Go Pro',
	subtitle: 'Everything, with no limits.',
	cta: 'Start free trial',
} as const;

export const monetization = MONETIZATION.paywall;

export default function Paywall() {
	const { state } = useQa();
	useEffect(() => {
		track(EVENTS.paywall_viewed);
	}, []);

	if (state === 'loading') return <StateView kind="loading" />;
	if (state === 'error') return <StateView kind="error" />;

	return (
		<Screen>
			<Text role="largeTitle">{copy.title}</Text>
			<Text role="body">{copy.subtitle}</Text>
			<Button variant="primary" onPress={() => track(EVENTS.paywall_completed)}>
				{copy.cta}
			</Button>
			{/* IMPLEMENT: the paywall's product UI. Offering ids are in `monetization`. */}
		</Screen>
	);
}
```

**When `elements` is absent, the generator emits the null layout**: every copy
key as `<Text role="body">` in declared order, under a comment saying no layout
was specified. It does not guess. `design spec` drafts `elements` into `_todo`,
so an unspecified layout is a gate failure at spec time rather than a silent
improvisation at build time.

**States.** Every state in `screen.states` other than `default` becomes an early
return on `useQa().state`. An unlisted state is an unbuilt state, which is
already what `checkStates` asserts.

## 8. Validation before generation

`design build` validates before it writes a byte, and reports every problem at
once. Nothing is partially written: the plan is computed, validated, and only
then applied.

| Check | Failure |
| --- | --- |
| `components.json` `contractVersion` ≤ shipkit's | `contractVersion 2 is newer than this shipkit understands` |
| every `elements[].component` is in the contract | names the component and lists the supported set |
| every `elements[].variant` is in that component's `variants` | names both |
| every `screen.states` entry is supported by `StateView` | names the unsupported state |
| every `elements[].copy` key exists in `screen.copy` | names the dangling key |
| every `elements[].event` is declared in `screen.events` | names it |
| every token in the contract's `requires` exists in `system.json` | lists every missing role, radius and colour at once, and a `spacing.scale` shorter than the largest `spacingSteps` |

The last row replaces revision 1's hardcoded ramp-role gate. The list of type
roles, radii and colours the primitives need is computed from the contract's
`requires` blocks, so adding a primitive that needs a new token updates the gate
automatically.

Spacing is the one token that is **indexed, not named**: `system.json` carries
`spacing.scale` as an unnamed numeric series (`[0, 4, 8, 12, 16, 24, 32, 48]`),
so a primitive declares how many steps it needs as `spacingSteps` and reads
`spacing[n]` by index. Requiring names there would invent a vocabulary the
design-system schema does not have.

The default drafted system satisfies every requirement in the shipped contract —
`draftSystem` emits radii `sm`/`md`/`lg`, the seven-step `PLATFORM_RAMP`, and an
eight-step spacing scale — so the gate fires only when an author removes
something a primitive needs, never on a fresh draft.

The same validation runs inside `ship design spec`, which already accepts a
component set — it is upgraded to take the whole contract. A spec that cannot be
built fails at `design spec`, not three commands later.

## 9. Typed analytics events

Event names stop being strings. `design build` emits `src/analytics/events.ts`
from the events declared in `ux.json`:

```ts
export const EVENTS = {
	paywall_viewed: 'paywall_viewed',
	paywall_completed: 'paywall_completed',
} as const;

export type AppEvent = (typeof EVENTS)[keyof typeof EVENTS];
```

The static `track(event: AppEvent)` accepts nothing else, so an event the spec
does not declare is a typecheck error in the app repo. Names are still derived
by `eventName(flow, verb)` from `lib/flows.mjs` — `checkEvents` already refuses a
hand-typed name that disagrees — so the closed vocabulary reaches the
implementation as a type.

## 10. The QA contract, and its security boundary

`src/theme/qa-params.ts` is **generated from `src/lib/qa-params.mjs`**, so the
sanitizing logic has one source and shipkit's own test suite exercises the real
thing rather than a lexical approximation of it. shipkit types that module in
JSDoc and the app is TypeScript, where JSDoc types are ignored — so `emitQaParams`
translates each `@type` annotation onto the declaration rather than dropping it,
and the app repo's own `tsc --strict` sees a fully typed module:

```ts
export const QA_DEFAULTS = { theme: null, state: 'default', locale: null, scale: 1 } as const;

export function sanitizeQa(
	raw: any,
	{ enabled, themes, states }: { enabled: boolean, themes: readonly string[], states?: readonly string[] },
): { theme: string|null, state: string, locale: string|null, scale: number } {
	if (!enabled) return QA_DEFAULTS;
	// theme ∈ themes; state ∈ states; locale matches /^[a-z]{2}(-[A-Z]{2})?$/;
	// scale is finite and clamped to [0.5, 4]. Anything else falls back to the
	// default for that field. Never throws — a hostile parameter costs a
	// capture at default settings, not a crash.
}
```

`provider.tsx` supplies `enabled` and calls it:

```tsx
const QA_ENABLED = Platform.OS === 'web' || __DEV__;
export function useQa() {
	return sanitizeQa(useLocalSearchParams(), { enabled: QA_ENABLED, themes: THEMES, states: STATES });
}
```

**The gate is a security decision, not a tidiness one.** expo-router honours the
same parameters over a deep link on native. Without `QA_ENABLED`, a shipped
release build would accept a URL that puts any screen into any state —
including a paywall in its success state. Tier 1 drives the web build, so QA is
unaffected by the restriction.

`enabled: false` returns `QA_DEFAULTS` **before reading any field**, so there is
no code path from a production build to a parameter-driven state. That is the
property §13 tests against hostile input.

**Known limit, not solved here.** With a single configured locale nothing varies
by `qaLocale`, so that axis measures nothing today. Generated copy is inline;
localising it through `src/i18n` remains the agent's job.

## 11. Structured monetization

A `monetization` block becomes data, not a comment. `design build` emits
`src/purchases/catalog.ts`:

```ts
export const MONETIZATION = {
	paywall: { offering: 'pro', entitlement: 'premium', packages: ['monthly', 'annual'] },
} as const;
```

keyed by screen id. The screen re-exports its own entry, so the ids are
reachable from the component, from `ship rc audit`, and from any implementing
agent, without parsing a comment. Wiring RevenueCat remains domain logic and
stays out of the generator.

## 12. Routes, and strengthening `design review`

### Route mapping

| `ux.json` route | file |
| --- | --- |
| `/` | `app/index.tsx` |
| `/paywall` | `app/paywall.tsx` |
| `/settings/notifications` | `app/settings/notifications.tsx` |
| `/item/[id]` | `app/item/[id].tsx` |

**Dynamic routes generate normally.** Revision 1 refused them; that was a
permanent architectural restriction standing in for a temporary tooling gap.
`ship qa` cannot drive `/item/[id]` because it has no id to drive it with, so
`ship qa` reports that cell `SKIPPED` with the reason — the same honest verb it
already uses for every Tier 2 category — rather than `FAIL`, and rather than the
generator refusing a legitimate screen. A future `qaParams` field on the screen
supplying a fixture id is the escape hatch, and is not built here.

Duplicate routes need no new check: `checkScreens` already rejects two screens
on one route.

### `design review` gets teeth

Today `design review` catches values that are not in the system. It should also
catch **implementation that bypasses the system entirely** — a screen that
builds its own `StyleSheet` never trips a token rule, because it never mentions
a token.

New rules, over files under `app/` and `src/` excluding `src/theme/`:

| Rule | Rationale |
| --- | --- |
| no `StyleSheet.create` outside `src/theme/` | styling lives in primitives |
| no `style={{ … }}` containing a numeric literal | the same bypass, inline |
| no `View`/`Text`/`Pressable` imported from `react-native` in `app/` | screens compose primitives |
| 3-digit hex (`#fff`) also counted | the existing rule only matched 6-digit |

**Explicit exceptions, because a noisy gate is a disabled gate:**

- the numbers `0` and `1` anywhere
- `flex`, `opacity`, `zIndex`, `borderWidth`, `aspectRatio` — platform
  constants, not design decisions
- `StyleSheet.hairlineWidth`, `Platform.select`, `Dimensions`
- everything under `src/theme/`, which is where tokens legitimately become
  literals (the existing exemption regex already covers `tokens.ts`; it widens
  to the directory)

Each exception is a named entry in one exported constant, so the list is
reviewable and testable rather than scattered through regexes.

## 13. Modules and testing

| File | Holds | Est. |
| --- | --- | --- |
| `src/lib/design-contract.mjs` | the contract constant, `validateAgainstContract`, `requiredTokens` | ~180 |
| `src/lib/design-emit.mjs` | header format, hash, header parsing, route→path, refusal classification | ~140 |
| `src/lib/design-tokens.mjs` | `DEFAULT_SYSTEM`, `emitTokens` | ~170 |
| `src/lib/design-screen.mjs` | `emitScreen`, null layout, state branches | ~180 |
| `src/lib/design-support.mjs` | `emitEvents`, `emitCatalog`, `emitQaParams` | ~150 |
| `src/lib/qa-params.mjs` | `sanitizeQa` — the real logic, emitted into the app | ~70 |
| `src/commands/design.mjs` | `buildCmd` added to `SUB` | 213 → ~300 |
| `src/commands/new.mjs` | calls the emitters for the scaffold's generated files | 297 → ~330 |

Every emitter is a pure function from JSON to a string. None touches the disk;
the command reads, hashes, writes and prints. That is the split that keeps
`lib/qa-checks.mjs` and `lib/ads-v1.mjs` at full coverage with `npm test`
offline, and it is what makes the header/hash logic testable without a temp
directory.

### Tests

| File | What |
| --- | --- |
| `test/design-contract.test.mjs` | unsupported component, unsupported variant, unsupported state, dangling copy key, undeclared event, missing required token — each reported **by name**, and all reported **at once** |
| `test/design-emit.test.mjs` | header round-trip, tamper detection, missing header, foreign file, route mapping including dynamic segments |
| `test/design-tokens.test.mjs` | token emission shape; `requiredTokens` computed from the contract; a `system.json` missing a role lists every miss |
| `test/design-screen.test.mjs` | element transcription, the null layout when `elements` is absent, state branches, typed event references, monetization re-export |
| `test/qa-params.test.mjs` | **security**: `enabled: false` returns defaults for every hostile input — injected theme, unknown state, `../` locale, `NaN`/`Infinity`/negative/huge scale, array-valued params. And `enabled: true` accepts exactly the valid set and rejects the rest |
| `test/design-determinism.test.mjs` | every emitter run twice, and against a deep clone, asserts byte equality; asserts no emitted file contains a timestamp |
| `test/design-review.test.mjs` | each new rule fires; each documented exception does not |
| `test/design-command.test.mjs` | extended over a temp repo: build writes, re-run refuses a hand-edited file by name, `--force` overwrites, `--check` writes nothing |
| golden files | `test/fixtures/design/expected/*.tsx.txt` — a full generated screen, tokens module and events module, compared byte-for-byte. The readable diff when a change is intentional, and the alarm when it is not |
| CI scaffold smoke | `ship new` → `design system` → `design spec` → `design build` → `design review` exits 0 |

**The self-constraint is a test, not an aspiration:** the generated tree must
pass the strengthened `ship design review` clean. `design-screen.test.mjs`
asserts it by running `reviewSources` over its own output.

Per the metrics gotcha in this repo: `npm run test:c8` must be re-run before
trusting a CRAP count, because `scripts/metrics.mjs` joins coverage on line
numbers and any edit that shifts lines produces phantom violations. Callbacks
inside the emitters are extracted into named functions — c8's `fnMap` charges
CRAP against anything it cannot register, including an anonymous `.map`.

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Generated tree fails the strengthened `design review`, making item 12 fail item 6 | Asserted in `design-screen.test.mjs` and in the CI smoke |
| The strengthened review is noisy enough that someone disables it | Exceptions are an explicit, tested constant (§12), not a scattered set of regexes |
| The `elements` array is a schema change to an artifact already on disk | Additive and optional; a spec without it generates the null layout and is refused at `design spec` for an unfilled `_todo`, not at build |
| Contract and primitives drift | `requires` is the only declaration of what a primitive needs, and the token gate reads it. A primitive needing a token nobody declared fails the app repo's typecheck |
| Golden files rot into rubber-stamped churn | They cover three files, not the whole tree; the behavioural assertions in the other suites are what actually gate |
