# `ship design build` — growing `templates/app` from the design system

Status: **approved design**. Date: 2026-09-03. Baseline: `master` @ `45a7fe1`.
Implements roadmap item 12 of `docs/shipkit-2.0.md` (§10, P1).

---

## 1. The problem

`templates/app` is one screen. Audit row 1 of the Shipkit 2.0 plan calls this out
as the P0 gap: "Build" means scaffold, not build.

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

Nothing in `templates/app` reads them. So the contract is documented on the
capture side and unimplemented on the render side, and the checks that exist to
catch exactly that (`checkDarkMode`, `checkStates`) fail on every generated app
for a reason that is shipkit's own fault.

This spec closes both: the routes come from the spec, and the query-param
contract is honoured by construction because the code that reads it is
generated, not remembered.

## 2. Scope

**In scope.** A fourth subcommand, `ship design build`, that reads
`design/system.json` and `design/ux.json` from the app repo and writes a themed
token module, one route file per specified screen, and `design/components.json`.
Four new static files in `templates/app` that the generated code consumes.

**Out of scope.** Domain logic of any kind. The generator does not wire
RevenueCat offerings, build an onboarding carousel, or decide what a screen
does. It emits layout, copy, states and analytics events — everything the spec
already contains — and marks where the implementing agent takes over.

**Explicitly rejected.** Generating the primitives themselves (§4), and
generating screens from a per-flow layout library. Both make the generator the
author of the design, which is the thing `design/system.json` exists to prevent.

## 3. Command surface

```
ship design system   → design/system.json          (exists)
ship design spec     → design/ux.json              (exists)
ship design build    → app/*.tsx, src/theme/*      NEW
ship design review   → gates the generated tree    (exists)
```

`build` sits in the `design` group rather than under `ship build`, which already
means "produce an IPA via EAS". Two meanings of the word in one command is a
worse cost than a slightly crowded subcommand list.

```
ship design build [--force] [--json]
```

`--force` overwrites files that were hand-edited since generation. `--json`
prints the file plan instead of the table, matching the other three
subcommands.

There is no new config block. Everything derives from `cfg.paths.app`,
`cfg.paths.design` and `cfg.paths.designSystem`, which already exist.

## 4. The generated / static line

The line falls where the data/code line already falls. Token *values* vary with
the design system; the components that consume them do not.

### Generated

| File | Source | Notes |
| --- | --- | --- |
| `src/theme/tokens.ts` | `design/system.json` | the one file allowed to contain literals |
| `app/<route>.tsx` | one per `ux.json` screen | layout, copy, states, events |
| `design/components.json` | the static primitive inventory | gives `checkComponents` something real |

### Static, shipped in `templates/app`

| File | Why it is not generated |
| --- | --- |
| `src/theme/provider.tsx` | `ThemeProvider`, `useTheme`, `useQa`. Reviewable code, not a template literal. |
| `src/theme/primitives.tsx` | `Screen`, `Text`, `Button`, `StateView`. Reference tokens by name only. |
| `src/analytics/index.ts` | No-op `track()`. The seam an SDK plugs into; generated screens call it, so event names are real before a vendor is chosen. |
| `src/theme/tokens.ts` | A default token set **carrying a generated header**, so `ship new` alone still typechecks and boots. It appears in both tables deliberately: the template ships the default, and `design build` regenerates it from `system.json` under the ownership rule in §5. |
| `app/index.tsx` | Today's home, **gaining a generated header**, so the first `design build` replaces it with no `--force`. |

Generating the primitives was considered and rejected: every line of React
Native becomes a string inside a `.mjs`, the emitters split three or four ways
against the 500-line limit, and code that should be reviewed becomes code that
is concatenated.

`ship design review` needs no change to accommodate this. Its exemption regex is
`/(^|\/)(theme|tokens)\.(ts|tsx|js|jsx)$/`, which already matches
`src/theme/tokens.ts` and nothing else in the new tree. `provider.tsx` and
`primitives.tsx` are *not* exempt, and must not be — they contain no literals,
and the gate is what keeps that true.

## 5. Ownership and regeneration

Every generated file carries a header:

```
// @generated by `ship design build` from design/system.json
// @hash 3f2a1c9e
// Edit freely. `ship design build` refuses to overwrite a changed file and
// names it, rather than destroying your work. --force takes it back.
```

`@hash` is the first 8 hex of the sha256 of the body **below** the header, so
the header is never self-referential and reformatting the comment does not
falsify the hash.

On re-run, for each file the generator intends to write:

| On disk | Recomputed hash | Action |
| --- | --- | --- |
| absent | — | write |
| header present | matches | write (silently; it is ours) |
| header present | differs | **refuse**, name the file |
| no header | — | **refuse**, name the file (foreign) |

`--force` writes regardless. Refusals are collected and reported together — the
gate's error message is the agent's contract, and fixing one file per run is how
a build takes ten rounds.

JSON artifacts cannot carry a `//` header, so `design/components.json` uses
`"_generated": { "by": …, "hash": … }`. Every schema in this repo already
tolerates `^_` properties, so this needs no schema exception.

This rule is what makes the `app/index.tsx` handover clean. The scaffold's home
screen ships pre-hashed, so `design build` recognises it as generated and
replaces it without ceremony the first time `ux.json` declares a home screen —
while a home screen the developer actually edited is protected by the same rule
that protects everything else.

## 6. Route mapping, and one new gate

| `ux.json` route | file |
| --- | --- |
| `/` | `app/index.tsx` |
| `/paywall` | `app/paywall.tsx` |
| `/settings/notifications` | `app/settings/notifications.tsx` |

**A route containing `[` is refused by name.** expo-router supports dynamic
segments; `ship qa` cannot drive one, because there is no id to drive it with.
A spec that declares `/item/[id]` is declaring a screen QA will never capture,
and saying so at build time is better than a silently uncovered route.

Duplicate routes need no new check — `checkScreens` in `lib/design-spec.mjs`
already rejects two screens on one route, for this exact reason.

## 7. The ramp-role gate

Static primitives reference type roles and radii by name. A `system.json` whose
ramp omits one would produce a `tokens.ts` that breaks the app repo's
typecheck — an error thrown by the wrong tool, in the wrong repo, naming the
wrong thing.

So `design build` asserts up front that `system.json` provides what the
primitives use, and names every missing one at once:

- type roles: `largeTitle`, `title`, `body`, `footnote`
- radii: `md`

Colours need no gate. `schema/design-system.schema.json` already requires all
twelve semantic colours in both themes.

## 8. What a screen emits

For each screen in `ux.json`:

```tsx
// @generated by `ship design build` from design/ux.json
// @hash …

import { useEffect } from 'react';
import { Button, Screen, StateView, Text } from '../src/theme/primitives';
import { useQa } from '../src/theme/provider';
import { track } from '../src/analytics';

const copy = {
	title: 'Go Pro',
	subtitle: 'Everything, with no limits.',
	cta: 'Start free trial',
} as const;

export default function Paywall() {
	const { state } = useQa();
	useEffect(() => {
		track('paywall_viewed');
	}, []);

	if (state === 'loading') return <StateView kind="loading" />;
	if (state === 'error') return <StateView kind="error" />;

	// IMPLEMENT: offering "pro" · entitlement "premium" · packages monthly, annual
	return (
		<Screen>
			<Text role="largeTitle">{copy.title}</Text>
			<Text role="body">{copy.subtitle}</Text>
			<Button onPress={() => track('paywall_completed')}>{copy.cta}</Button>
		</Screen>
	);
}
```

**Copy keys map to roles mechanically**, so nothing is invented and the mapping
is reviewable in one table:

| key | renders as |
| --- | --- |
| `title` | `<Text role="largeTitle">` |
| `subtitle` | `<Text role="body">` |
| matching `^cta` or `^action` | `<Button>` |
| anything else | `<Text role="body">` |

Keys render in their declared order.

**States.** Every state in `screen.states` other than `default` becomes an early
return on `useQa().state`. An unlisted state is an unbuilt state, which is
already what `checkStates` asserts.

**Events.** A `viewed` verb fires on mount. The primary button takes
`completed`, else `started`. Every remaining declared event becomes a named
handler with an `IMPLEMENT` comment naming it, so an unwired event is visible
rather than absent.

**Monetization.** A `monetization` block emits a comment carrying the offering,
entitlement and packages. Wiring RevenueCat is domain logic and stays the
agent's, but `ship rc audit` and the agent both read the ids from the same
place.

## 9. The QA contract

`src/theme/provider.tsx` reads the four parameters and is the only place that
does:

```tsx
const QA_ENABLED = Platform.OS === 'web' || __DEV__;

export function useQa() {
	const p = useLocalSearchParams();
	if (!QA_ENABLED) return DEFAULTS;
	return { theme: p.qaTheme, state: p.qaState, locale: p.qaLocale, scale: Number(p.qaTextScale) };
}
```

**The gate is a security decision, not a tidiness one.** expo-router honours the
same parameters over a deep link on native. Without `QA_ENABLED`, a shipped
release build would accept a URL that puts any screen into any state —
including a paywall in its success state. Tier 1 drives the web build, so QA is
unaffected by the restriction.

`useTheme()` resolves the active theme as `qaTheme` when enabled, else the OS
colour scheme. `Text` multiplies its ramp size by `scale`.

**Known limit, not solved here.** With a single configured locale nothing varies
by `qaLocale`, so that axis measures nothing today. Generated copy is inline;
localising it through `src/i18n` remains the agent's job. Recorded so it is a
known gap rather than an assumed feature.

## 10. Modules

| File | Holds | Est. |
| --- | --- | --- |
| `src/lib/design-emit.mjs` | header format, hash, header parsing, route→path, refusal classification | ~120 |
| `src/lib/design-tokens.mjs` | `emitTokens(system)`, `checkTokenRoles(system)` | ~150 |
| `src/lib/design-screen.mjs` | `emitScreen(screen)`, copy-role mapping, event wiring | ~200 |
| `src/commands/design.mjs` | `buildCmd` added to `SUB` | 213 → ~290 |

Every emitter is a pure function from JSON to a string. None touches the disk;
the command reads, hashes, writes and prints. That is the same split that keeps
`lib/qa-checks.mjs` and `lib/ads-v1.mjs` at full coverage with `npm test`
offline, and it is what makes the header/hash logic testable without a temp
directory.

## 11. Testing

| Layer | What |
| --- | --- |
| `test/design-emit.test.mjs` | header round-trip, tamper detection, missing header, route mapping, dynamic-route refusal |
| `test/design-tokens.test.mjs` | token emission shape, the ramp-role gate reporting every miss at once |
| `test/design-screen.test.mjs` | copy→role mapping, state branches, event wiring, monetization comment |
| `test/design-command.test.mjs` | extended over a temp repo: build writes, re-run refuses a hand-edited file by name, `--force` overwrites |
| CI scaffold smoke | `ship new` → `design system` → `design spec` → `design build` → `design review` exits 0 |

**The self-constraint is a test, not an aspiration:** the generated tree must
pass `ship design review` clean. No hex literal, no off-scale spacing, no
undeclared radius, no emoji anywhere but `tokens.ts`. `design-screen.test.mjs`
asserts it by running `reviewSources` over its own output.

Per the metrics gotcha in this repo: `npm run test:c8` must be re-run before
trusting a CRAP count, because `scripts/metrics.mjs` joins coverage on line
numbers and any edit that shifts lines produces phantom violations. Callbacks
inside the emitters are extracted into named functions — c8's `fnMap` charges
CRAP against anything it cannot register, including an anonymous `.map`.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Generated tree fails `design review`, making item 12 fail item 6 | Asserted directly in `design-screen.test.mjs` and in the CI smoke |
| Copy-key→role mapping is too crude for a real screen | It is documented, mechanical and small; the `IMPLEMENT` region is where a real layout goes. The generator's job is a measurable screen, not a finished one |
| Hash churn from formatter differences | Hash covers the body only; the repo has one formatter and generated files are written by it |
| `app/index.tsx` handover surprises someone who edited it | That is the refusal path working. It names the file and offers `--force` |
