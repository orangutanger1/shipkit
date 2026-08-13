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

Two complementary sources:

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
