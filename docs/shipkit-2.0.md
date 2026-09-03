# Shipkit 2.0 — audit, research findings, and implementation plan

Status: **proposal, revision 2** (no Mobbin/Appllama subscription; macOS lane decided).
Date: 2026-09-02. Baseline: `master` @ `91e55d4`.

---

## 0. Executive summary

Shipkit is a strong **ship** and **grow** system and a stub **build** system. The
ship half (ASC metadata, localization, screenshots, preflight gates, EAS, OTA
drift, RevenueCat, pricing, Apple Search Ads, analytics) is dense, tested,
gate-driven, and worth preserving nearly untouched. The build half is `ship new` —
one `templates/app` tree with a single `index.tsx`. No product spec, no design
system, no UX spec, no QA loop. That is the gap.

Five findings shape the plan:

1. **There is no simulator on this host.** WSL2 Linux; `ship shots` exists *because*
   of that. The QA loop becomes two tiers: local RN-Web headless Chromium, and a
   GitHub Actions `macos-latest` lane. shipkit's own repo is **public**, so that
   lane is free and unlimited for developing the harness. §7.
2. **No design-research subscription, and none is wanted.** Mobbin and Appllama are
   therefore *optional future adapters*, not dependencies. The default evidence
   engine is the **App Store storefront**, which is free, unauthenticated, and
   richer than it looks — verified live today. §2.
3. **The GitHub Student Developer Pack supplies the one thing the storefront
   can't**: Appfigures, free for a year, is download/revenue estimates + keyword
   ranks over a documented v2 API. That is the metrics dimension, without paying
   Appllama. §2.4.
4. **The highest-leverage artifact needs no provider at all.** A mechanical native
   quality bar (HIG rules + anti-slop counts + motion decision tree, enforced as
   arithmetic) is buildable today, for free, and is what actually separates a
   generated app from a shipped one. §6.
5. **Apple Ads Campaign Management API v5 sunsets 2027-01-26.** Every `ship ads`
   path dies then. `docs/apple-ads-platform-api.md` already maps the migration.
   Confirmed P0 by your call to drop Meta and the UGC engine.

---

## 1. Repository audit

### 1.1 Architecture map

```
bin/ship → src/cli.mjs
             COMMANDS registry (lazy import per command, 4 groups)
             parseArgs → flags/positional → mod.run({args,flags})
             ShipError → exit code; EPIPE swallowed

src/config.mjs   ship.config.json: find-up, deepMerge over DEFAULTS,
                 derived absolute `paths`, ads coherence check at load,
                 LIMITS (ASC field caps) — the single app identity manifest
src/log.mjs      ShipError, colour, heading/step/note/good/warn, table, Report
src/exec.mjs     subprocess + dry-run + verbose global state
src/lib/*.mjs    58 modules, pure logic + API clients, ≤500 LOC each
src/commands/*   20 command modules, thin orchestration + printing
schema/          ship.config + screenshot-spec JSON Schemas
templates/app/   the entire "build" capability
ci/              4 workflow templates shipped *into* app repos
mcp/servers.json revenuecat (http) · astro (http, Mac-only) · apple-ads (stdio)
skills/shipping-ios/SKILL.md  431-line agent operating manual
scripts/metrics.mjs  acorn-based complexity/CRAP/LOC gate
```

### 1.2 Command map (current)

| Group | Commands |
| --- | --- |
| Setup | `doctor` `init` `new` |
| Discover | `scout` (terms·brief·names·new) · `aso` (harvest·volume·score·suggest·apply·competitors·audit) |
| Ship | `meta` `loc` `shots` `preflight` `build` `submit` `ota` `release` |
| Grow | `rc` `ads` `status` `analytics` `price` `portfolio` |

### 1.3 Integration map

| System | Path | Auth |
| --- | --- | --- |
| App Store Connect | `asc` CLI shell-out + `lib/appstore-client.mjs`, `lib/analytics-api.mjs` | ASC key profile |
| Apple Search Ads | `lib/ads-*.mjs`, own JWT client (`ads-auth`) | `~/.asc/asa-private.p8` + `ASA_*` |
| RevenueCat | `lib/revenuecat.mjs` + MCP | `REVENUECAT_V2_KEY` / `~/.omp/revenuecat.key` |
| Figma | `lib/figma.mjs` | `FIGMA_API_KEY` / `~/.omp/figma.key` |
| Storefront (public) | `lib/appstore.mjs`, `lib/storefront-scout.mjs` | none, disk-cached |
| EAS/Expo | `exec` shell-out | ambient |

### 1.4 What is strong (preserve)

- **Gates, not documentation.** `preflight`, `meta stage` lint, OTA native-dep
  drift, ads config coherence at *config load*. This philosophy is the product.
- **One config, derived paths.** Nothing hardcodes an app. Extend; never add a
  second config system.
- **Artifacts on disk, versioned.** `store/staged/*`, `aso/*`, `scout/<market>/*`,
  `.asc/analytics/*`. Already the right instinct.
- **Credential-free front door.** `ship scout` reads only public storefront data.
  The research layer inherits that property — now a load-bearing decision, not a
  nicety, because there is no subscription behind it.
- **Quality bar enforced** (`scripts/metrics.mjs`, c8 --100, stryker, jscpd, knip,
  oxlint, tsc over JSDoc). CI loads every command module + scaffold/schema/gate smoke.
- **Cost-aware external access** (`lib/figma.mjs` treats Figma as a quota;
  `.cache/storefront/`). Exactly the discipline the research layer needs.

### 1.5 What is weak / missing

| # | Finding | Severity |
| --- | --- | --- |
| 1 | `templates/app` is one screen. "Build" = scaffold, not build. | P0 |
| 2 | No product brief beyond `scout brief` (keyword-shaped, not product-shaped). | P0 |
| 3 | No design system, UX spec, flow model, or component inventory. | P0 |
| 4 | No post-implementation visual/behavioural QA. `preflight` gates the *store*, not the *app*. | P0 |
| 5 | Apple Ads v5 sunset 2027-01-26 not yet migrated (notes exist, no client). | P0 |
| 6 | Onboarding/paywall *analysis* exists (`lib/paywall.mjs`); nothing *designs* them. | P1 |
| 7 | `status`/`portfolio` report state; they don't diagnose or recommend. | P1 |
| 8 | Analytics `bottleneck` stops at "which stage"; no cause, no action. | P1 |
| 9 | `astro` MCP is Mac-only + SSH-tunnel — fragile dependency in `doctor`. | P2 |
| 10 | Two `slugify` implementations (`scout-scoring` ASCII vs `cpp` Unicode). | P3 |
| 11 | 68 files modified + 1 untracked test uncommitted right now. | blocker |

### 1.6 Extension points

`src/cli.mjs` COMMANDS · `src/config.mjs` DEFAULTS + `paths` · `schema/` (ajv already
in CI) · `src/lib/` pure modules ≤500 LOC · `templates/app/` · `skills/` · `ci/*.yml`.

---

## 2. The evidence engine

### 2.1 Decision

No paid provider. The default and only implemented provider is
**`appstore`** — Apple's own public storefront. Mobbin and Appllama remain as
*documented adapter slots* against the normalized model (§4.1) so a future
subscription is a new file, not a refactor. Neither is implemented.

### 2.2 What the storefront actually gives (verified live, 2026-09-02)

| Source | Verified result |
| --- | --- |
| `GET itunes.apple.com/lookup?id=&country=` | 40 fields: `screenshotUrls` (10), `ipadScreenshotUrls`, `averageUserRating`, `userRatingCount`, `userRatingCountForCurrentVersion`, `price`/`formattedPrice`/`currency`, `releaseDate`, `currentVersionReleaseDate`, `version`, `releaseNotes`, `description`, `genres`/`genreIds`, `advisories`, `contentAdvisoryRating`, `languageCodesISO2A`, `minimumOsVersion`, `fileSizeBytes`, `sellerName`, `artistId` |
| Screenshot image resizing | URL suffix is swappable: `…/320x480bb.jpg` → `…/1290x0w.png` (2.7 MB full-res, HTTP 200) or `…/2000x0w.webp` (143 KB, HTTP 200). **Full-resolution competitor screens, free.** |
| `GET itunes.apple.com/<cc>/rss/customerreviews/page=N/id=ID/sortby=mostrecent\|mosthelpful/json` | 50 entries/page, pages **1–10** (page 11 errors) → **500 reviews per sort per app**, each with `im:rating`, `im:version`, `updated`, `title`, `content`. No auth. |
| `apps.apple.com/<cc>/app/id…` HTML | in-app purchase list + prices — already scraped by `lib/storefront-scout.mjs` |
| `itunes.apple.com/search` + autocomplete | already used by `lib/appstore.mjs` for the competitor set and demand proxy |

### 2.3 What it cannot give, and the substitute for each

| Gap | Substitute |
| --- | --- |
| In-app screens past the 10 marketing shots | Marketing shots are **developer-ranked**: position 1–10 is a deliberate priority ordering, and subscription apps routinely put onboarding, value-prop and paywall frames in the first five. Treat position as `position`, flow-tag each frame with the agent, and you have a real if shallow journey. |
| Ordered onboarding / paywall journeys | `ship research capture <dir>` — ingest screenshots or a screen recording **you** took on a real device into the same reference schema. Manual, zero cost, no ToS question, and only needed for the 2–3 competitors that actually matter. |
| Downloads / revenue | **Appfigures** (§2.4) for estimates, plus a free proxy Shipkit can build itself: snapshot `userRatingCount` per app per research run and compute **review velocity** between runs. Free, no dependency, and it gets more accurate the longer the tool runs. Neither Mobbin nor Appllama gives you this at all. |
| "Why does this pattern work?" | Reviews. 500 per sort per app, with rating and version. This is the single biggest asymmetry: it yields jobs-to-be-done, pain points, feature requests, churn reasons, and — by joining `im:rating` drops to `im:version` — *which release broke which thing*. No design-reference product has this data. |

### 2.4 Student Developer Pack — what is worth redeeming

| Offer | Value here |
| --- | --- |
| **Appfigures — free 1 year** | v2 API: `/reports/estimates` (downloads + revenue), `/ranks`, `/aso` (keyword ranks), `/reviews`, `/featured`. This is the metrics dimension. **Verify at redemption that the student tier includes API access and estimates** — entry ASO API access is ~$9/mo and estimates are a "Premium Intelligence" dataset, so the tier matters. |
| **GitHub Pro** | 3,000 Actions min/mo on private repos. macOS bills at **10×** → **300 macOS min/mo**. |
| **Sentry** (50K errors, 100K txns/mo) | Crash rate + release health into `ship status`. Fills the "quality problem" branch of `analytics diagnose`. |
| Figma | Already integrated (`lib/figma.mjs`). |
| Datadog Pro (2 yr), New Relic, Codecov, Azure $100, DigitalOcean $200, Heroku $13/mo | Not needed. Shipkit runs no services and adds none (§42 of the brief). Codecov is redundant with c8 `--100`. |

Not in the pack: any macOS CI credit. Handled in §7.

---

## 3. Challenging the brief

| Brief § | Claim | Assessment |
| --- | --- | --- |
| 2/3 | Build on Mobbin + Appllama MCPs | **Dropped.** No subscription, and this is your tool. Both become unimplemented adapter slots. Their *lessons* are kept: research-before-design, flow-not-screen, and the research/quality-bar separation. |
| 18 | Simulator QA loop | Not possible on this host. Two-tier redesign, §7. |
| 9 | Rank references by revenue/downloads/rating | Rating + rating-count are free. Downloads/revenue need Appfigures. Add **review velocity** as a free momentum signal. |
| 23–25 | Meta Ads, UGC creative engine, creative learning loop | **Dropped to out-of-scope / P3-reporting-only**, per your call. Shipkit can't render video; Advantage+ App Campaigns resist knob-turning. |
| 26 | New growth dashboard | Duplicates `ship status` + `ship portfolio`. Extend them. |
| 27 | Experimentation system | `lib/cpp.mjs` + `lib/cpp-asc.mjs` already do Custom Product Pages. Add a registry; don't build parallel infrastructure. |
| 28 | 13 config blocks | Config is *identity*, not *content*. Three blocks; the rest are files. §5.4 |
| 41 | 100% coverage, 0 mutants on new subsystems | Achievable **only** because the agent-facing parts stay pure schema+gate code. §4 keeps the network out. |
| 6 | New product brief artifact | ~40% exists as `scout brief`. Extend it. |
| 14/15 | Onboarding + paywall as new systems | Measurement half exists (`lib/paywall.mjs`: `ONBOARDING`, `CONVERSION`, `onboardingFunnel`, `auditLadder`). Build the *design* half into the same vocabulary. |
| 30 | ~30 commands | 3 new top-level + 4 subcommands. §9 |

AI where reasoning pays: reading screenshots, naming patterns, synthesizing review
themes, writing rationale, drafting copy, judging hierarchy. Determinism where it
pays: fetching, caching, dedupe, schema validation, citation enforcement, ranking
over numbers, contrast math, anti-slop counting, diffs, exit codes.

---

## 4. Core architectural decision

**Shipkit fetches what is fetchable; the agent reads what must be seen; a gate
validates everything either produced.**

The storefront half is plain HTTP with no auth, so unlike the MCP providers it
*can* live in the CLI — and does, reusing `lib/appstore.mjs` and the existing
`.cache/storefront/` discipline. Only the interpretation is agent work.

```
ship research plan      deterministic. Reads product/brief.json + the competitor
                        set. Emits research/<slug>/plan.json: which apps, which
                        flows, which sources, fetch budget, output paths.
   ↓
ship research fetch     deterministic. Downloads lookup metadata, full-res
                        screenshots, and review pages into research/<slug>/.
                        Cached, deduped, resumable, rate-limited.
   ↓
agent                   reads the committed images, flow-tags each screen, fills
                        `observations`, synthesizes patterns.json claims.
                        Guided by skills/researching-apps/SKILL.md.
   ↓
ship research verify    deterministic gate. JSON Schema; every claim cited; every
                        reference has a non-empty `doNotCopy`; budget respected;
                        image hashes present. Exits non-zero.
   ↓
ship research index     deterministic. Ranks references, joins review velocity
                        and (optionally) Appfigures estimates, writes index.json.
```

`ship design` and `ship qa` read `index.json` and never know the provider.

### 4.1 Normalized reference model

```jsonc
// research/<slug>/references/<ref-id>.json
{
  "id": "ref_a1b2c3",                       // hash(provider, providerId)
  "provider": "appstore" | "manual" | "appfigures" | "mobbin" | "appllama",
  "providerId": "341232718#screen-3",
  "kind": "screen" | "flow" | "element",
  "app": { "name": "…", "trackId": 341232718, "bundleId": "…",
           "rating": 4.7, "ratingCount": 210433, "ratingVelocity": 812,
           "price": 0, "hasIap": true, "iapPrices": ["$19.99/mo"],
           "releasedAt": "…", "updatedAt": "…", "genres": ["Health & Fitness"],
           "downloadsEst": null, "revenueEst": null },   // Appfigures only
  "flow": "paywall",                        // taxonomy §5.2
  "position": 3,                            // marketing-shot ordinal, or null
  "image": { "path": "assets/ref_a1b2c3.png", "sha256": "…", "w": 1290, "h": 2796 },
  "sourceUrl": "https://apps.apple.com/us/app/id341232718",
  "capturedAt": "2026-09-02T…Z",
  "observations": { … },                    // §11 field list, agent-filled, capped
  "doNotCopy": "…",                         // REQUIRED, non-empty, gate-enforced
  "confidence": "high" | "medium" | "low"
}
```

### 4.2 Review evidence model

```jsonc
// research/<slug>/reviews/<trackId>.json  (deterministic fetch)
{ "trackId": 341232718, "fetchedAt": "…", "sorts": ["mostrecent","mosthelpful"],
  "count": 947,
  "reviews": [{ "id","rating","version","date","title","body" }, …] }

// research/<slug>/themes.json  (agent synthesis, gate-validated)
{ "themes": [{
    "label": "logging friction",
    "kind": "pain" | "job" | "request" | "churn-reason" | "praise",
    "support": 61,                          // review ids backing it
    "ratingSkew": -1.9,                     // mean rating of supporting reviews minus app mean
    "versions": ["26.34.0"],                // im:version correlation, if any
    "quotes": ["…"],                        // ≤3, ≤200 chars, attributed
    "reviewIds": ["…"] }] }
```

`ratingSkew` and version correlation are computed in Node, not guessed.

### 4.3 Evidence vs hypothesis

```jsonc
{ "claim": "…", "kind": "evidence" | "hypothesis",
  "refs": ["ref_…"],            // ≥3 required when kind = evidence
  "counterexamples": ["ref_…"], // required field, may be []
  "confidence": "high|medium|low", "assumptions": ["…"] }
```

`research verify` fails any `evidence` claim with <3 refs, and any claim with 0 refs.

---

## 5. Pipeline and artifacts

### 5.1 Lifecycle

```
scout ──► brief(v2) ──► research ──► design ──► build ──► qa ──► preflight ──► release
                                                                                  │
              experiment ◄── diagnose ◄── analytics ◄── ads/status ◄──────────────┘
```

Three genuinely new stages: **research**, **design**, **qa**.

### 5.2 Flow taxonomy

Closed vocabulary shared by research, UX spec, analytics events and QA. One file,
`src/lib/flows.mjs`, so every subsystem agrees on names.

| Group | Flows |
| --- | --- |
| Activation | `first-launch` `welcome` `value-prop` `personalization` `permission` `account` `first-value` |
| Core | `home` `navigation` `search` `discovery` `detail` `create` `edit` `settings` |
| Monetization | `paywall` `trial` `upsell` `feature-gate` `pricing` `restore` |
| Retention | `notification` `streak` `progress` `reminder` `re-engagement` |
| Edge | `empty` `loading` `error` `offline` `destructive` `undo` |

Research is requested **per flow**, not per screen.

### 5.3 Artifact tree

```
product/
  brief.json            extends scout brief: jobs-to-be-done (from reviews),
                        target user, value prop, north-star action, activation
                        event, retention loop, monetization model, risks, go/no-go
  decisions.md          append-only decision log
research/<slug>/
  plan.json             apps, flows, sources, fetch budget
  references/*.json     normalized references (§4.1)
  reviews/*.json        raw review corpora (§4.2)
  themes.json           synthesized review themes
  assets/*.png          committed full-res screenshots
  patterns.json         claims with refs (§4.3)
  index.json            ranked, metrics-joined, provider-agnostic
design/
  system.json           colour, type ramp, spacing, radii, elevation, motion
                        durations/curves, haptics map — every token cited
  system.md             rationale
  ux.json               screens + flows (§13 field lists)
  components.json       which RN/Expo primitive backs each component
qa/<version>/
  captures/*.png        per-screen × theme × dynamic-type × locale
  report.json           per-category PASS/WARN/FAIL/SKIPPED + evidence paths
  baseline/             accepted captures for visual diffing
```

Git-tracked text + PNG. No database, no service.

### 5.4 Config additions

```jsonc
{
  "product":  { "dir": "product", "category": "health-fitness", "audience": "…" },
  "research": { "dir": "research", "providers": ["appstore"],
                "budget": { "apps": 12, "screensPerApp": 10, "reviewPages": 10 },
                "flows": ["first-launch","paywall","home"] },
  "design":   { "dir": "design", "system": "design/system.json",
                "qa": { "themes": ["light","dark"], "locales": ["en-US"],
                        "dynamicType": ["default","xl"] } }
}
```

All optional with defaults, via the existing `deepMerge`. **Existing configs stay
valid — migration is zero-touch.** `schema/ship.config.schema.json` gains the
blocks; CI's ajv step covers them free.

---

## 6. Design synthesis and the quality bar

`ship design system` is a **constrained synthesizer**, not a free-for-all.

- Inputs: `product/brief.json`, `research/<slug>/index.json`, `patterns.json`,
  `themes.json`, and a static HIG ruleset.
- Deterministic (Node): token completeness; the type ramp is a platform ramp; the
  spacing scale is a single 4pt or 8pt series; **exactly 1 accent hue**; radii
  scales all declared; both themes define every semantic colour; WCAG contrast
  computed for every fg/bg pair, fail <4.5:1 (3:1 at ≥24pt); every token cited to
  a ref or to a HIG rule.
- Agent: choosing hues, naming the brand direction, writing rationale.

`ship design review` re-runs those checks against the **implementation** (parsed
from the RN theme module / `StyleSheet`), so drift between `design/system.json` and
the code is a gate failure rather than a code-review opinion. Plus mechanical
anti-slop counts: 0 emoji in UI chrome, 0 unmotivated gradients, 0 duplicate
labels for one intent, 1 accent hue, all radii from the declared scale.

`ship design spec` emits `design/ux.json` — the sole contract for the implementing
agent, which is told: *you may not invent a colour, radius, duration, or screen
that is not in these files.* That is the actual fix for "don't ask an AI to invent
an app".

**Monetization is not a separate system.** Paywall screens in `ux.json` carry
RevenueCat `offering`/`entitlement` ids; `ship rc audit` + `lib/paywall.mjs
auditLadder` validate the implemented ladder against the spec. Analytics event
names come from `lib/flows.mjs`, the same vocabulary `lib/paywall.mjs ONBOARDING`
already uses — so `ship analytics onboarding` reads a real funnel out of a
generated app with zero configuration.

---

## 7. QA loop and the macOS lane

### 7.1 Tier 1 — local, every iteration, free

Reuse `lib/shots-capture.mjs`: RN-Web build in headless Chromium at device pixel
size, driven through the expo-router routes named in `design/ux.json`, captured per
theme × Dynamic Type setting × locale. Documented limitation (already in that
file): faithful only for plain `View`/`Text`/`Pressable` trees.

Valid on web captures: layout/overflow, contrast, spacing rhythm, tap targets
≥44pt, safe-area padding, empty/loading/error states, Dynamic Type XL overflow,
dark-mode completeness, visual regression vs `qa/<version>/baseline/`.

### 7.2 Tier 2 — macOS runner, per release

New `ci/qa.yml` on `macos-latest`: `xcrun simctl` boot, install the dev build,
drive Maestro flows (`templates/app/.maestro/screenshots.yaml` already exists),
record per-flow video, dump the accessibility tree, upload artifacts.

Valid only here: real navigation semantics, gesture/spring behaviour, keyboard
avoidance, haptics presence, frame timing, VoiceOver labels.

**Cost, decided:**

| Lane | Terms | Verdict |
| --- | --- | --- |
| GitHub Actions, **public** repo | free, unlimited, incl. macOS | **Default.** shipkit is public → the harness is developed and self-tested at zero cost. Keep app repos public where you can. |
| GitHub Actions, private repo (Student Pack → GitHub Pro) | 3,000 min/mo, macOS 10× → **300 macOS min/mo** | Enough for ~15–20 QA runs/month. Gate on release tags, never on push. |
| **Codemagic** | 500 free macOS M2 min/mo, individual accounts only (not teams) | Overflow lane for private repos. |
| **Xcode Cloud** | 25 compute-hours/mo free with the Apple Developer Program | Needs a real Xcode project (`expo prebuild`) and is awkward for Maestro. Builds already go through EAS. **Not used.** |

EAS handles building, so macOS minutes are spent **only** on QA. Guard rails in the
workflow: `concurrency` cancel-in-progress, `timeout-minutes`, and trigger on
release tag / `workflow_dispatch` only.

### 7.3 Tier 3 — not built

Physical-device motion review. Documented as a manual step in the skill. Not
pretended to be automated.

`ship qa` runs Tier 1 locally, consumes Tier 2 artifacts when present, writes
`qa/<version>/report.json`, and becomes a **required check inside `ship
preflight`** — which is how it gets teeth without a new release path. Every check
declares which tier can prove it; a Tier-1-only run reports motion/native/a11y as
`SKIPPED`, never `PASS`.

---

## 8. Growth — sequencing

1. **P0 — Apple Ads Platform API v1 migration.** Dated. Adopt
   `apple-ads-platform-api-node` (published 2026-08-14) or port `lib/ads-client.mjs`
   per the deltas already mapped in `docs/apple-ads-platform-api.md`. `lib/ads-plan.mjs`
   (the pure planner) stays untouched behind the client swap.
2. **P1 — real keyword popularity.** `POST /v1/suggestions/keywords/query` returns
   0–100 popularity per term → `aso/<locale>/volume.json`, replacing the fabricated
   values `ship aso volume` ships today. Highest-value single API call in the plan.
3. **P1 — `ship analytics diagnose`.** Extend the existing `bottleneck` from "which
   stage" to a decision table: impressions↑/page-views↓ → *listing*;
   installs↑/activation↓ → *onboarding*; activation↑/retention↓ → *core loop*;
   retention↑/subscription↓ → *monetization*; crash-rate↑ (Sentry) → *quality*.
   Each verdict names the flows to re-research and the `ux.json` screens implicated.
4. **P2 — experiments over Custom Product Pages.** `product/experiments.json`
   (hypothesis, variant, metric, window, result, decision) joined to
   `ship analytics pull`. Apple serves; Shipkit records.
5. **P3 — Appfigures ingest** into `ship portfolio` (competitor download/revenue
   estimates), if the student tier includes it.
6. **Out of scope — Meta campaign management, UGC creative engine.** Confirmed.

---

## 9. Command surface

Three new top-level commands, four new subcommands. ~15% growth.

```bash
ship research plan  [--flows a,b] [--apps n]   # deterministic planner
ship research fetch [--refresh]                # storefront: metadata, shots, reviews
ship research capture <dir>                    # ingest your own device captures
ship research verify                           # schema + citation + budget gate
ship research index                            # rank, join velocity/estimates

ship design system  [--check]                  # synthesize / validate tokens
ship design spec                               # emit design/ux.json
ship design review                             # implementation vs system, mechanical

ship qa             [--tier 1|2] [--baseline]  # capture, check, report

ship scout brief                               # now also writes product/brief.json
ship analytics diagnose                        # new subcommand
ship preflight                                 # now requires a passing qa report
```

Composition:
`scout brief → research plan → research fetch → [agent] → research verify →
research index → design system → design spec → [agent implements] → qa →
preflight → release → ads → analytics diagnose → research plan`.

---

## 10. Roadmap

**P0 — the build loop**
1. Land the uncommitted 68-file typing pass; clean tree.
2. `src/lib/flows.mjs` — shared taxonomy. Cheap, unblocks everything.
3. Schemas: reference, reviews, themes, patterns, design system, ux spec, qa report.
4. `ship research plan|fetch|capture|verify|index` over the storefront.
5. `skills/researching-apps/SKILL.md` + `skills/designing-apps/SKILL.md` — the
   research protocol and the mechanical quality bar, split from `shipping-ios`.
6. `ship design system|spec|review` + the HIG/anti-slop ruleset.
7. `ship qa` Tier 1 over `lib/shots-capture.mjs`; wire into `preflight`.
8. Apple Ads Platform API v1 client migration.

**P1 — the learning loop**
9. `ship analytics diagnose` decision table (+ Sentry crash input).
10. Real keyword popularity from the Platform API.
11. `product/brief.json` extended out of `scout brief`, seeded from review themes.
12. `templates/app` grows from the design-system output: token module, themed
    primitives, real onboarding + paywall routes wired to RevenueCat.

**P2 — measurement + experiments**
13. `ci/qa.yml` macOS Tier 2 lane.
14. Experiment registry over Custom Product Pages.
15. `status`/`portfolio` gain diagnose output. Review-velocity tracking for
    competitors.

**P3 — optional**
16. Appfigures adapter. 17. Meta reporting-only ingest. 18. Astro replacement.
19. Mobbin/Appllama adapters, if ever subscribed.

---

## 11. Test strategy

| Layer | Target |
| --- | --- |
| Unit | Schemas; flow taxonomy; ranking; review-theme arithmetic (`ratingSkew`, version correlation); contrast math; anti-slop counters; diagnose decision table; budget arithmetic; dedupe hashing. All pure → c8 `--100` and 0 surviving mutants are honest targets. |
| Integration | Fixture-driven: recorded `lookup`/RSS/screenshot payloads in `test/fixtures/research/`, following the existing `test/fixtures/storefront.mjs` pattern. No live network in `npm test`. |
| E2E (CI smoke) | Extend the scaffold job: `ship new` → fixture brief → `research plan` → inject fixture references → `research verify` → `design system --check` → `design spec` → `qa --tier 1` against the scaffold's own web build → assert `preflight` blocks on a failing qa report and passes on a good one. |
| Live | Opt-in `npm run test:live` only. Never in CI. |

Metrics gate unchanged (cyclomatic/cognitive <22, Halstead <80, LOC <500, CRAP <25).
`schema/*.json` and `research/**` are data, already outside `scripts/metrics.mjs`.

---

## 12. Security, cost, legal

- **Credentials.** Storefront needs none — the research front door stays
  credential-free like `ship scout`. Appfigures (if redeemed) follows the existing
  pattern: env var → `~/.omp/appfigures.key`, never in a repo, `ship doctor`
  reports *skipped* not *failed* when absent.
- **Cost.** `research/plan.json` carries a hard fetch budget; `verify` fails if
  exceeded. Committed `assets/` mean a re-run costs zero. Reuse
  `.cache/storefront/`. Rate-limit and back off on 403/429 — Apple's RSS and
  lookup endpoints are undocumented-but-public and must be treated politely:
  serial fetch, ≥250 ms spacing, hard cap of `apps × (10 shots + 20 review pages)`
  per run.
- **Legal.** Screenshots and reviews are publicly served marketing/UGC assets,
  fetched at the volume a person browsing the store would generate, used as
  research inputs. They are **never shipped in a binary or a store asset**. Every
  reference carries a required non-empty `doNotCopy`. `ship design review` asserts
  no generated asset is byte- or perceptually-similar to a reference image. No
  bulk catalog mirroring, and there is no `research all` command.
