---
name: shipping-ios
description: Ship an iOS app with the `ship` CLI — App Store Connect metadata, ASO keyword research, EAS builds, OTA updates, RevenueCat monetization, and Apple Search Ads. Use when the task involves releasing, updating, or growing an iOS app in any repo containing ship.config.json.
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
- **No simulator screenshots here.** `ship shots plan|validate|upload` works on
  files that already exist. With a committed design spec
  (`store/figma-geometry.json`), `ship shots capture` + `render` build those
  files two other ways — the app's own web build driven headless, or Apple's
  live composites with the caption band repainted. Both are real pixels; neither
  is a simulator. See "Screenshots" below.

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

`appDir` matters and is not always the repo root — some repos keep the Expo app
in a subdirectory. Read it; never assume.

## Choosing what to build

`ship scout` is the research pass that happens before a repo exists. It reads
public storefront data only and writes under `./scout/`.

```bash
ship scout terms "car maintenance" "service log"   # sweep + score a category
ship scout brief "car maintenance log"             # go/no-go on one term
ship scout names "glovebox"                        # is the brand word taken?
ship scout new car-maintenance-log --from …        # scaffold the repo
```

**Read this before generating ideas.** Models are near-deterministic, so every
developer who asks one for high-volume low-competition terms, then an app idea,
then a name, converges on the same app — a term can return a page of
near-identical apps released within a month of each other, pitching the same
angle, with nobody having copied anybody. The output of a popular process is a
crowded market.

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

Four rules the tool cannot enforce, so they are yours:

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
- **Sell into a core human desire.** Health, addiction, appearance, faith,
  mental health, money, food, intimacy, learning — the categories where the
  outcome is worth handing a card to a stranger. `ship scout brief` can prove
  that the leaders sell in-app; it cannot prove anyone wants the outcome badly
  enough to buy. A term that clears every gate in a category nobody aches about
  is a term you will fund with ads forever.
- **iOS only until there is traction, and keep shipping after launch.** A second
  platform before the first one converts is marketing effort spent on
  engineering instead. Launch is where the work starts, because retention is
  revenue and the friction that costs retention is inside the app, not in the
  funnel — instrument both (see "The post-install funnel"). `ship portfolio`
  prices the alternative: under $10/mo, older than 90 days, no release in 60 is
  a sunset candidate, and an app that stopped shipping arrives there on its own.

## Building the app itself

Two sibling skills cover the stages before a listing exists, and this skill does
not repeat them:

- **`researching-apps`** — `ship research plan|fetch|capture|verify|index`.
  Competitor evidence from the public storefront: full-res screenshots, review
  corpora, and claims that have to cite them. Credential-free, like `ship scout`.
- **`designing-apps`** — `design/system.json` and `design/ux.json`, the token
  and screen contracts, plus the mechanical HIG / anti-slop bar. Read it before
  generating any UI.

The order is `scout → research → design → build → qa → preflight → release`.
`ship scout` decides *whether* to build; `ship research` decides *what*, from
evidence rather than from a model's memory of what an app looks like.

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

**What converts, in descending order of weight: screenshots, reviews, name and
subtitle, icon.** That ordering is where the day goes. Screenshots carry the
install decision and get their own section below. Reviews are a threshold rather
than a gradient — having none is not a negative signal, a rating under about
four stars is, and once a version sits under four the honest fix is a rating
reset in the next update, not more prompts stacked on the old average. The icon
matters least early; a day spent on the icon is a day not spent on frame 1.

Name and subtitle are the exception that looks like a contradiction: almost
nobody reads them, and they are still the substrate everything else ranks on.
Apple indexes the two as one pool, which is why `ship meta lint` warns on any
keyword already covered by `name` or `subtitle` — and why the same word must not
appear in both halves of that pool either. Repetition inside it buys nothing.
`ship meta keywords <locale>` prices every term in characters so the trade is
visible before it ships, and `ship aso competitors --locale en-US` shows what
the category leaders actually index: the same handful of generic words, each
spent exactly once.

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

## Screenshots

Screenshots carry more of the install decision than the rest of the page
combined, and the binding constraint is that the first image is often the only
one seen — it has to communicate the whole app alone, before a thumb moves.
Depth is what stops the scroll: a chip, a slider, a dialog lifted out past the
phone frame reads as a product rather than a slide, and colour that survives a
thumbnail beats a faithful capture of a white screen. `ship shots plan` measures
what is on disk, `ship shots validate` gates pixel sizes, and `ship shots
render` typesets the caption you wrote; none of the three has an opinion about
whether frame 1 says anything, so that judgement is yours and it is the
expensive one.

```bash
ship shots plan       # measure every image on disk, write .asc/screenshots.json
ship shots validate   # gate: wrong pixel size, empty group, >10 per group
ship shots upload     # one asc call per display type, fanning out across locales
```

`--locale` and `--display-type` take comma-separated lists and narrow `validate`
and `upload` identically, so a broken locale nobody is pushing cannot block the
ones that are. With no `--locale`, upload is asc's app-scoped fan-out over every
locale directory under `store/screenshots`; naming locales switches to the
per-locale path.

A repo with `store/figma-geometry.json` also renders those images:

```bash
ship shots capture               # web build headless, or Apple's live composites
ship shots render de-DE fr-FR    # composite raw + store/screenshot-captions.json
ship shots verify                # calibration + safety; run after any spec change
ship shots figma                 # has the design moved? (cheap — not the render endpoint)
ship shots upload --render --replace
```

Three things to know before touching this:

1. **`--render` and scope travel together.** Rendering one locale and then
   letting the app-scoped fan-out upload everything ships a stale locale beside
   a fresh one. `--render` runs both halves over one scope resolution; keep it
   that way.
2. **Re-rendered bytes are new bytes.** `--skip-existing` cannot skip them, so
   they append beside the attached set. Use `--replace` unless you mean to add.
3. **Figma's render endpoint is a daily quota.** The committed exports under
   `store/figma-export/` are build inputs in git, not a cache. `ship shots
   figma` checks for drift without spending quota; `--export` is the only thing
   that does, and a 429 keeps the committed copies.

`ship shots render` fails on a caption it cannot fit rather than clipping it,
and `ship shots verify` fails a caption-band render that touched a single pixel
outside the caption band. Read its numbers; do not assert the set is right
because the command exited 0 somewhere else.

Dimensions are read straight out of the PNG/JPEG header, never from the
filename and never from an image library. A file whose header cannot be parsed
measures as unreadable rather than as a guess: `plan` warns and prints
`unreadable` in the DIMENSIONS column, `validate` fails it as `?x?`. Treat that
warning as a corrupt or half-written export and re-render it — a truncated
upload is one of the failures Apple reports late.

## Building and updating

```bash
ship build            # EAS production build; records the native fingerprint
ship ota --check      # is an OTA safe right now?
ship ota --message "…"
ship submit
ship release          # preflight → meta → build → submit, gated at every step
```

`ship ota` refuses when the native dependency graph or native Expo config keys
drifted since the last `ship build`. An OTA shipped against changed native deps
breaks every installed client, because the JS bundle references native modules
the installed binary does not contain. The baseline lives in
`.asc/native-lock.json` and is written by `ship build`. `--force` exists; using
it is how this breaks in production.

For `tour` specifically, backend deploys must land **before** the OTA
(`supabase db push` → `supabase functions deploy …` → `ship ota`), because old
clients treat new response shapes as errors.

## The post-install funnel

Everything above stops at the install. `ship analytics funnel` ends at
impressions → page views → installs, which is where the money starts, not where
it lands. The stage after it has its own numbers, and they live in
`src/lib/paywall.mjs` as code rather than prose because they are contested
business rules: `ONBOARDING`, `CONVERSION`, `LADDER`.

`ship analytics diagnose` reads the whole chain at once — impressions, page
views, installs, paywall reach, deletions, sessions, paid, crashes — and names
one stage to work on. Two rules make it worth trusting:

- **The culprit is the earliest failing stage, not the worst one.** Every later
  stage is measured on the users an earlier one already lost, so a catastrophic
  paywall under a leaking product page is a number about nobody.
- **A stage with no data is `unknown`, never a pass.** It names the command that
  would answer it instead. Apple does not produce every report for every app.

Crash rate is judged before the funnel and outranks it: a crashing app fails
everything downstream as a symptom. That number is Apple's own `App Crashes`
report — no third-party SDK — and arrives with `ship analytics pull` alongside
the deletion rate and session counts. See `docs/apple-analytics-reports.md`.

```bash
ship analytics onboarding --file export.csv        # a PostHog-style funnel export
ship analytics onboarding --locale en-US           # or .asc/analytics/en-US-onboarding.json
ship analytics onboarding --installs 4200 --paid 190
```

Onboarding does exactly two jobs: convince the user they have a problem, then
convince them this app solves it. Anything on those screens doing neither is
drop-off you paid for. Sell the outcome, never the product — a feature tour
before the paywall is a paywall fewer people reach.

`ONBOARDING.minScreens`/`maxScreens` is a 10-15 band and deliberately not a
target. More screens qualify harder: fewer users arrive at the paywall, and the
ones who do arrive with higher intent. Fewer screens convert worse. So the count
is a trade you measure, and the finding worth acting on is an uninstrumented
funnel, which cannot be tuned in either direction.

`ONBOARDING.paywallReach` is the one hard gate at 75% — under that, the
onboarding has already capped total conversion at whatever fraction reaches the
paywall, times whatever the paywall can do. `ship analytics onboarding` prints
that as a failure row and names the single step losing the most users, which is
the screen to cut or rewrite first. `ONBOARDING.maxQuizScreens` caps the quiz at
four: a quiz feels productive to build and is the most common place a funnel
dies quietly. Images over text, social proof only where it is real, and every
screen defends its place in the reach number or it goes.

Do not clone a competitor's onboarding screen for screen. Apple rejects clones,
and an onboarding is the one part of a shipped app anyone can read in full for
free — which makes it the easiest thing in the category to beat rather than copy.

## Monetization

```bash
ship rc status
ship rc audit          # the paywall-breakage gate
ship price audit       # the paywall-shape gate
```

`ship rc audit` catches the four failures that ship a dead paywall: no offering
marked current, a current offering with zero packages, a RevenueCat bundle id
that disagrees with the build, and a missing entitlement. It runs inside
`ship preflight`.

That gate proves the paywall *renders*. It says nothing about whether the
paywall's shape can convert, which is a separate audit: `ship price audit`
checks the ladder against the edges that cost money regardless of storefront —
an annual tier exists, a weekly or monthly tier exists beside it, the yearly is
at or under `LADDER.annualUsd` ($49.99), the trial sits on the yearly and not on
the weekly, and a win-back offering exists without being marked current. It
consumes `auditLadder` from `src/lib/paywall.mjs` rather than restating those
thresholds, so there is one place to argue with them.

$49.99 is a ceiling, not a suggestion. In the EU the 14-day right of withdrawal
makes a refund essentially automatic for anything that is not usage-based, so a
yearly above it converts once and reverses later with the acquisition cost
already spent. `LADDER.monthlyUsd` ($14.99) and `LADDER.weeklyUsd` ($7.99) catch
the users who will not commit for a year; the standard shape is a seven-day
trial on the yearly and no trial on the weekly, because a trial on the weekly
cannibalises the yearly it should be qualifying for. At those prices the
per-territory table is not a rounding error — `ship price show|plan|apply` owns
it, and `apply` refuses to move any territory by more than 50% without
`--force`, because price changes are visible to existing subscribers and are not
casually reversible.

Paywall order, top to bottom: social proof, a headline about the outcome and not
the feature, a features block phrased as outcomes, price last. The number that
judges all of it is install → paid, scored by `CONVERSION`: 3% is the floor —
below it no amount of ASO or `ads.targetCpi` tuning pays for itself — ~5% is a
working app, 10%+ is a tuned one. `ship analytics onboarding --installs <n>
--paid <n>` prints which tier you are in and what that tier means to fix.

Use the `revenuecat` MCP server for anything conversational or mutating —
creating products, entitlements, offerings, paywalls. Use the CLI for gates.

Ship the paywall through RevenueCat's **remote** paywalls, so pricing, layout
and A/B tests move without an app review cycle; the queue is the reason a
paywall experiment otherwise costs a week per iteration. That is not licence to
serve a non-compliant one — remote or not, it is the screen Apple reads hardest.

The exit offer is the other half of the ladder, and it is a sequence rather than
a button. In-app "manage subscription" asks why first (preset reasons plus free
text — the only honest churn data you will ever get), then presents a discounted
save at around `LADDER.winbackUsd` ($24.99/year, optionally a lifetime, noting a
lifetime tier is awkward to explain in an acquisition), and only falls through to
the App Store subscription page on a no. Show the discount exclusively to
subscribers who are **not** already on the yearly; offered to a yearly
subscriber it is a giveaway, not a save. `ship price audit` fails a win-back
offering that is marked current, which is the same giveaway served to everyone.

Notifications follow the same asymmetry: they go to engaged users, keyed off
activity metadata, not to a list on a schedule. Waking a lapsed weekly
subscriber is work nobody pays you for.

## Acquisition

```bash
ship ads status                       # also prints the exact login line when unconfigured
ship ads plan --locale en-US --top 15 --budget 10 --bid 0.55
ship ads plan --render                # rewrite campaign-plan.md from the plan on disk
ship ads snapshot                     # observed state: ids, statuses, bids, per-object spend
ship ads sync --dry-run               # the exact mutation set; nothing runs
ship ads report --level ad-group --from 2026-08-01
ship ads mine --apply --confirm       # negatives + promotions, evidence printed first
```

Apple Ads credentials are **separate** from App Store Connect credentials.
`ship ads plan` needs none of them: it works from `aso/<locale>/scored.json`, so a
campaign plan can be prepared before any credential exists.

Five rules to know before touching a live account:

- **The plan is intent, the snapshot is state.** `sync` reconciles them by Apple's
  object ids, which it records into the plan. It refuses — and exits non-zero —
  rather than pause anything without `--prune`, or overwrite a value changed
  outside `ship` without `--force` (plan wins) or `--adopt` (account wins). Read
  the printed diff; it is the whole mutation set.
- **A plan with ids in it cannot be regenerated.** `plan` builds from
  `scored.json`, so replanning drops every hand-set bid, pruned ad group and
  non-ASO keyword — and the next `sync --force` then reverts the account to match.
  It refuses to overwrite a bound plan: `--render` refreshes `campaign-plan.md`
  alone, `--force` replans and keeps `campaign-plan.prev.json`. Never hand-edit
  `campaign-plan.md`; it is generated, and `--render` is the way to refresh it.
- **Budgets are campaign-level only.** Apple has no ad-group budget, so no ad group
  in a plan has one. One ad group per keyword buys creative control (its own Custom
  Product Page and bid), not budget isolation.
- **Bids come from the market.** The account's realised cost-per-tap, else
  `ads.seedBid`. Apple's $0.30 minimum loses every auction; `--bid` sets a
  market-clearing price without editing generated JSON.
- **The kill rule needs a sample, not just a bill.** `ship ads mine` negates only
  past `2 × ads.targetCpi` *and* past the tap count at which a keyword converting at
  `ads.baselineInstallRate` would have converted (6 taps by default). It prints the
  terms it is holding and why, and `--apply` requires `--confirm`.

`plan` and `sync` read the configured RevenueCat project. With no subscriptions and
no revenue they say so in the real numbers and label every threshold a research
cap: buying installs worth $0.00 is a decision, not a default.

## Before claiming a release is done

`ship preflight` is the gate. It checks listing lint, version coherence between
`app.json` and ASC, the Tier 1 quality report for this version, review state, a
VALID build, an iPhone screenshot set live on App Store Connect for the primary
locale, Apple's own `validate` plan, RevenueCat wiring, reachable legal URLs,
and OTA compatibility. Run it and read the output; do not assert readiness from
the absence of errors elsewhere.

The quality row is `ship qa` (see the `designing-apps` skill). In a repo with no
`design/ux.json` it skips; once that spec exists, preflight fails without a
current report, and a report written for another version counts as no report —
it is the one that would say PASS about screens this build does not contain.

Preflight owns the mechanical blockers. The review itself is a person, and three
rules survive every submission that went badly:

- **Attach a video of what changed.** A reviewer who has to hunt for the new
  behaviour finds something else instead.
- **Be relentlessly literal about what the app does**, in the review notes and
  in the listing, with no gap between the two. Never mislead — the rejections
  that cost a week started as copy that was technically true.
- **Do not argue with a reviewer.** Fix, resubmit, and when the circumstances
  genuinely warrant it — a factual misreading, a committed launch date — request
  a call or an expedited review instead of a longer reply.

Apple is answering one question: does the user end up happy. Every rule above is
downstream of that one, and so is the funnel — a release that clears preflight
into an onboarding nobody measured is done only in the mechanical sense. Run
`ship analytics onboarding` before you call it shipped.
