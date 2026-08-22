---
name: shipping-ios
description: Ship an iOS app with the `ship` CLI — App Store Connect metadata, ASO keyword research, EAS builds, OTA updates, RevenueCat monetization, and Apple Search Ads. Use when the task involves releasing, updating, or growing an iOS app in /home/myen/tour, /home/myen/glovebox, /home/myen/noor, or any repo containing ship.config.json.
---

# Shipping iOS apps

One CLI (`ship`) drives the whole lifecycle. Three MCP servers cover the
conversational half. Never hand-run `eas`/`asc` for something `ship` already
encodes — the wrappers exist because each one carries a gate that was learned
from a production incident.

## Environment truth

This host is **WSL2 Linux**. There is no macOS, no Xcode, no simulator, no
ruby, no fastlane.

- Native builds happen on **EAS cloud** (`ship build`). Local iOS builds are impossible.
- App Store Connect work happens through the **`asc` CLI** (installed, authenticated).
- **fastlane adds nothing here.** `deliver` → `asc metadata`, `pilot` → `asc testflight`,
  `precheck` → `ship preflight`, `match` → EAS-managed credentials, `gym` → EAS Build.
  The one lane fastlane uniquely owns is `snapshot` (simulator screenshots), which
  needs a Mac; that lives in `ci/screenshots.yml` on a GitHub macOS runner.
- **Screenshots cannot be captured here.** `ship shots` validates and uploads
  files that already exist on disk. Do not pretend otherwise.

## First move in any app repo

```bash
ship doctor      # credentials, tooling, MCP wiring, repo identity
ship status      # review state, builds, revenue, ad spend, OTA safety — one screen
```

`ship doctor` is cheap and answers "why is this broken" faster than reading configs.

## The config

Every repo has `ship.config.json` at its root. It is the only place an app's
identity lives — ASC app id, bundle id, EAS project, RevenueCat project,
entitlement, store dir, locales, legal URLs. Read it before assuming anything.
`ship init` creates or repairs it by auto-detection.

`appDir` matters: `/home/myen/tour` keeps its Expo app in `mobile/`, the others
at the repo root.

## Choosing what to build

`ship scout` is the research pass that happens before a repo exists. It reads
public storefront data only and writes under `./scout/`.

```bash
ship scout terms "car maintenance" "service log"   # sweep + score a category
ship scout brief "car maintenance log"             # go/no-go on one term
ship scout names "glovebox"                        # is the brand word taken?
ship scout new car-maintenance-log --from …        # scaffold the repo
```

**Read this before generating ideas.** Glovebox shipped in August 2026 into
`car maintenance log` and found `Car Maintenance Log - Glovebox` already on the
storefront: same feature set, same privacy-and-offline angle, same brand word,
released two weeks earlier. Searching the term returned a page of car
maintenance logs, all released within a month of each other, several of them
pitching privacy. Nobody copied anybody. Every one of those developers ran the
same pipeline — ask a model for high-volume low-competition terms, ask it for an
app idea, ask it for a name — and models are near-deterministic, so the pipeline
converged. The output of a popular process is a crowded market.

Three concrete rules follow, all enforced by the tool:

1. **Weak incumbents are not automatically a gap.** `ship scout terms` sorts by
   `viability` = `opportunity × (1 − saturation/100)`, not by `opportunity`. The
   `sat` and `clones` columns say whether the weakness is a decade-old category
   nobody served or a stampede that started three weeks ago. `ship scout brief`
   fails the `clones` gate when more than two of the top ten are titled after
   the term, shipped inside a year, and still under 25 ratings — that is not a
   competitor, it is your unbuilt app, already built. On a NO-GO the next step
   is a different term. `--max-clones` moves the threshold; it does not move the
   storefront.
2. **The obvious differentiator is already taken.** Every brief prints
   *Positioning already taken*, mined from the incumbents' own descriptions.
   "Private, offline, no account" scored 6/10, 1/10 and 4/10 on the live
   `car maintenance log` page — the angle Glovebox launched on was the category
   norm. Anything at 40% or higher is table stakes; differentiation has to be
   something not on that table, and it survives into the staged listing as
   `notes.evidence.claimsAlreadyTaken`.
3. **Name it against the storefront, not against the metaphor.** The first
   metaphor a model produces for a car app is `glovebox`, which is exactly why
   eleven live apps already use the word. `ship scout names` queries the brand
   word on its own — a category sweep never surfaces a collision that lives in
   somebody's title suffix.

Two rules the tool cannot enforce, so they are yours:

- **Seed the sweep from something a model would not say.** Seeds decide
  everything downstream, and a model asked for "app ideas in a category" emits
  the same list to everyone who asks. Seed from what you personally know, from
  1-star reviews of a specific incumbent, from a forum thread, from a workflow
  you actually perform. `ship scout terms` accepts many seeds; the sweep is only
  as unique as they are.
- **Confirm the market with a source that is not a keyword tool.** A term can
  clear every gate and still be a category nobody pays for. `ship scout brief`
  reads whether the leaders sell in-app for exactly that reason and says so when
  no evidence of a payer exists.

## Store listings

Listings are authored in `store/staged/<locale>.json` — one human-editable file
per locale, with an optional `notes` block recording why each keyword was chosen.
`ship meta stage` expands those into the canonical tree `asc` consumes
(`store/app-info/<locale>.json` + `store/version/<v>/<locale>.json`).

**Never hand-edit the canonical tree.** It is generated; `stage` overwrites it.

```bash
ship meta lint                 # offline: length limits, ", " in keywords, dupes, wasted slots
ship meta pull                 # seed staged files from what is live in ASC
ship meta migrate              # auto-detects localizations/ + app-info-localizations/
ship meta apply                # gated deploy
ship meta keywords en-US       # per-term char cost, headroom, wasted slots
```

Two rules the linter enforces because they silently cost ranking:

- No space after commas in `keywords`. `"a, b"` wastes one indexed character per term.
- Terms already in `name` or `subtitle` are indexed anyway; repeating them in
  `keywords` burns slots for nothing.

`ship meta apply` runs `asc metadata apply` **twice** on purpose. The first pass
creates empty localizations and reports "entity with locale already exists"; the
second fills them. Only second-pass failures are real. It also refuses to run
unless the ASC version state is one of `READY_FOR_SALE`, `PREPARE_FOR_SUBMISSION`,
`DEVELOPER_REJECTED`, `REJECTED` — pushing metadata during review is rejected by Apple.

## Keyword research

Two complementary sources, for an app that already exists (pre-repo research is
`ship scout`, above):

- **`ship aso`** — live App Store autocomplete harvest plus top-10 competition
  scoring. No subscription, works from Linux. Produces an `opportunity` score
  (0-100) weighting weak incumbents, low review moat, and few exact-title matches.
- **`astro` MCP** — rank tracking over time, keyword popularity/difficulty,
  competitor keyword extraction. Requires the Astro macOS app plus an SSH tunnel
  (see `shipkit/mcp/README.md`). Use it to check whether shipped keywords moved.

```bash
ship aso harvest --locale en-US --seeds "car maintenance,oil change"
ship aso score --locale en-US
ship aso suggest --locale en-US      # proposed 100-char field + diff, writes nothing
ship aso apply --locale en-US        # writes it into the staged listing
ship aso competitors --locale en-US
```

Research first, listing second, ads third. Ads bid on terms the listing already
ranks for; bidding on terms your metadata ignores pays Apple to fix your ASO.

## Building and updating

```bash
ship build            # EAS production build; records the native fingerprint
ship ota --check      # is an OTA safe right now?
ship ota --message "…"
ship submit
ship release          # preflight → meta → build → submit, gated at every step
```

`ship ota` refuses when the native dependency graph or native Expo config keys
drifted since the last `ship build`. Both `tour` and `idea6` recorded the same
incident: an OTA shipped against changed native deps breaks every installed
client, because the JS bundle references native modules the installed binary
does not contain. The baseline lives in `.asc/native-lock.json` and is written
by `ship build`. `--force` exists; using it is how the incident happened.

For `tour` specifically, backend deploys must land **before** the OTA
(`supabase db push` → `supabase functions deploy …` → `ship ota`), because old
clients treat new response shapes as errors.

## Monetization

```bash
ship rc status
ship rc audit          # the paywall-breakage gate
```

`ship rc audit` catches the four failures that ship a dead paywall: no offering
marked current, a current offering with zero packages, a RevenueCat bundle id
that disagrees with the build, and a missing entitlement. It runs inside
`ship preflight`.

Use the `revenuecat` MCP server for anything conversational or mutating —
creating products, entitlements, offerings, paywalls. Use the CLI for gates.

## Acquisition

```bash
ship ads status                       # also prints the exact login line when unconfigured
ship ads plan --locale en-US --top 15 --budget 10
ship ads sync                         # idempotent: matches campaigns by name
ship ads report --from 2026-08-01
```

Apple Ads credentials are **separate** from App Store Connect credentials and
are not configured on this machine yet. `ship ads plan` works offline from
`aso/<locale>/scored.json`, so a campaign plan can be prepared before any
credential exists.

The kill rule encoded in the plan: pause any keyword whose 7-day spend exceeds
one month of subscription revenue with zero conversions.

## Before claiming a release is done

`ship preflight` is the gate. It checks listing lint, version coherence between
`app.json` and ASC, review state, a VALID build, an iPhone screenshot set live on
App Store Connect for the primary locale, Apple's own `validate` plan, RevenueCat
wiring, reachable legal URLs, and OTA compatibility. Run it and read the output;
do not assert readiness from the absence of errors elsewhere.
