---
name: designing-apps
description: Turn research evidence into a design system and UX spec that a coding agent cannot improvise around — the token contract in design/system.json, the screen contract in design/ux.json, and the mechanical HIG / anti-slop quality bar. Use when designing an app's look and flows, or reviewing whether an implementation drifted from its spec.
---

# Designing apps

The point of this stage is one sentence: **a coding agent may not invent a
colour, a radius, a duration, a type step, a string or a screen that is not in
these files.** Everything below exists to make that enforceable arithmetic
rather than a code-review opinion.

Asking a model to "design a beautiful app" produces the same app every time —
the purple gradient, the emoji in the tab bar, four accent colours, a 6pt gap
next to a 20pt one. Those are not taste failures, they are *countable* failures,
which is why they get counted.

## The commands

```bash
ship design system            # draft design/system.json, or gate the one on disk
ship design system --check    # gate only; never write
ship design system --force    # redraft from scratch, discarding what is there
ship design spec [--flows a,b]  # draft design/ux.json over the researched flows
ship design spec --check
ship design review [--json]   # the same rules against the implementation
```

`system` is the default subcommand. With no file on disk it **drafts**: the
platform type ramp, a 4pt spacing series, radii, motion durations and the
reduced-motion answer, each cited to a HIG rule. Colour is absent, and `_todo`
says so — choosing a hue is the one thing here that cannot be derived, and a
guessed accent that nobody notices is worse than a missing one that fails a
gate. Every gate refuses a `_todo` document by name before it looks at anything
else.

`ship design review` needs a finished `system.json` and reads the app's own
sources. A file named `theme.ts`/`theme.tsx`/`tokens.ts` is exempt — it is where
tokens legitimately become literals. Everything else is drift.

## Inputs, and the citation rule

A design system is synthesized from `product/brief.json`,
`research/<slug>/index.json`, `patterns.json`, `themes.json` and the HIG. Get
the evidence first — see the `researching-apps` skill.

Every token carries a `cite`, and it is one of exactly three things:

```
ref_<hash>       a research reference — a competitor screen that shows this
claim_<id>       a patterns.json claim, which itself cites ≥3 refs
HIG:<rule>       an Apple Human Interface Guidelines rule, e.g. HIG:typography
```

An uncited token is an invented one, and an invented token is the failure mode
this entire file exists to stop. Choosing the hue, naming the direction and
writing the rationale is agent work; justifying it is not optional.

## `design/system.json` — the token contract

Required: `brand`, `color`, `type`, `spacing`, `radii`, `motion`. Optional:
`elevation`, `haptics`.

**Colour.** Exactly **one** `accentHue` (0–359) — an integer, because multiple
accents is the most reliable tell of a generated interface, so the schema
permits only one. Both `light` and `dark` themes must define all twelve
semantic roles: `background` `surface` `surfaceAlt` `text` `textMuted`
`textInverse` `accent` `accentText` `border` `success` `warning` `danger`. Each
is `{value: "#rrggbb", cite}`.

Contrast is arithmetic and `--check` computes it: text pairs at **4.5:1**,
accent and status colours on the background at **3:1** as non-text UI. `border`
is deliberately not checked — a separator is decorative, and a rule that fails
every real iOS palette is a rule somebody switches off. Dark theme is checked
independently and identically: it is not the light theme inverted, and
`#000000` with pure white is the most common dark mode and the worst one.

The single-accent rule is enforced against the pixels, not the label: the
declared `accentHue` has to be the hue the accent swatch actually is, and no
chrome role (`background` `surface` `surfaceAlt` `text` `textMuted`
`textInverse` `border`) may sit more than 20° off it. Tint neutrals toward the
accent or leave them grey; `success`, `warning` and `danger` are exempt because
their hue *is* their meaning.

**Type.** One `family`, and a `ramp` of ≥4 steps, each with `name` `size`
`lineHeight` `weight` `cite` (and optional `tracking`, `role`). Use the platform
ramp — the iOS text styles, large title through caption — rather than an
invented scale; that is what makes Dynamic Type work and what `HIG:typography`
cites. Sizes must be monotonic, and two steps may share a size only if they
differ in weight — Apple's own ramp puts headline and body both at 17pt. What
is refused is two names for one step: 16, 17 and 18 at one weight is three
steps doing one job.

**Spacing.** A `base` of **4 or 8** and a single `scale` series. One series. A
layout that mixes a 4pt series with a 6pt one reads as noisy and nobody can say
why.

**Radii.** Named, each cited. Every corner in the implementation comes from this
map — a one-off `borderRadius: 14` is drift.

**Motion.** `durations` and `curves`, each cited, plus
`reducedMotion` — a sentence saying what happens when the OS asks for less
motion. It is a string field and it is required reading, because an
implementing agent with no answer there will animate anyway. Motion under
~200ms reads as instant; **over 400ms fails the gate** — that is not motion, it
is waiting. Animate to explain a spatial
relationship; anything else is decoration you pay for in perceived speed.

**Haptics.** Keyed `"<flow>.<verb>"` — the same vocabulary as analytics, from
`src/lib/flows.mjs`, e.g. `"paywall.completed": {value: "success", cite}`.
Values are the seven Apple feedback types. Haptics on every tap is noise; the
useful ones are commit, success and error.

## `design/ux.json` — the screen contract

Two arrays: `screens` and `flows`.

Each screen: `id`, `route`, `flow`, `purpose`, `states` — required; `components`,
`copy`, `events`, `monetization`, `notes` — optional.

- **`route`** is an expo-router path starting `/`. `ship qa` drives the web build
  through exactly these routes, so a route that does not exist becomes a failing
  check rather than a stale document.
- **`flow`** is a flow id from `src/lib/flows.mjs`. Same closed vocabulary as
  research, analytics and QA — that is the join that lets a PostHog funnel
  export be read against the screen that produced it.
- **`states`** from `default` `empty` `loading` `error` `offline` `success`
  `disabled`. QA captures one image per state, so **an unlisted state is an
  unbuilt state** — and the empty state is the first screen most users of a
  logging app ever see.
- **`copy`** is every user-visible string, keyed. Filling this is the difference
  between a spec and a wireframe: an unspecified string is a string the coding
  agent will write, and it will write "Welcome to your journey!".
- **`events`** are `{name, flow, verb, when}` with verbs from `EVENT_VERBS`
  (`viewed` `started` `completed` `skipped` `dismissed` `failed` `granted`
  `denied`). Use `eventName(flow, verb)` from `src/lib/flows.mjs` rather than
  naming events by hand — that is what makes `ship analytics onboarding` read a
  real funnel out of a generated app with zero configuration.

Each flow: `id`, `screens` (ids **in order** — the order is the journey, and QA
walks it), plus `entry` and `success`. `success` is what counts as completing
the flow and becomes the funnel's terminal event.

**Monetization is not a separate system.** A paywall screen carries its
RevenueCat `offering`/`entitlement` ids in `monetization`, so `ship rc audit`
and `auditLadder` in `src/lib/paywall.mjs` validate the implemented ladder
against this spec instead of against nothing. The paywall's shape, prices and
onboarding thresholds live in the `shipping-ios` skill; do not restate them
here, and do not design a ladder that contradicts them.

## The anti-slop counts

Mechanical, checkable, and each one is a real tell:

| Rule | Count |
| --- | --- |
| Accent hues | exactly **1** |
| Emoji in UI chrome (tabs, buttons, headers, nav titles) | **0** |
| Unmotivated gradients | **0** — a gradient earns its place or it is a default |
| Duplicate labels for one intent ("Save"/"Done"/"Confirm" on one flow) | **0** |
| Radii not in the declared scale | **0** |
| Spacing values off the declared series | **0** |
| Colours not in the theme maps | **0** |
| Type steps not in the ramp | **0** |
| Screens with no `empty`/`error` state where data can be absent | **0** |
| Font families | **1**, plus at most a display and a mono |

`ship design review` runs the countable half of that table against the
implementation, line by line, and exits non-zero with a file:line for each hit.
It is a lexical scan and says so: it finds literals that are not in the system —
hex colours, `borderRadius`, spacing keys, `fontSize`, `duration`, emoji,
gradients. Duplicate labels and missing empty states are not countable from
source alone; they are yours, and `ship design spec --check` catches the second
one from the spec side.

## The order the work goes in

1. `ship research verify && ship research index` — evidence, or you are guessing.
2. `product/brief.json` — the job, the north-star action, the activation event.
3. `ship design system` → fill the colour → `ship design system --check`.
4. `ship design spec` → write the copy and the success conditions →
   `ship design spec --check`.
5. Implement against those two files and nothing else, then `ship design review`.

Doing 5 before 3 is how an app ends up with a design system reverse-engineered
from whatever the first screen happened to use.

## What is still judgement

The bar is mechanical; the design is not. The checks cannot tell you whether
the accent hue suits the category, whether the empty state says the right thing,
or whether a flow is one screen too long. They can only guarantee that whatever
you chose is the thing that got built, everywhere, in both themes. That is worth
more than it sounds — consistency is most of what "designed" means from the
outside — but it is a floor, not a ceiling.
