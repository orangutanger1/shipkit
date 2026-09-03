---
name: researching-apps
description: Gather competitor evidence with `ship research` — the App Store storefront pipeline (plan, fetch, capture, verify, index), the deterministic/agent split, and the citation gate. Use before designing or building an app, or when a claim about "how successful apps do X" needs evidence behind it.
---

# Researching apps

`ship research` is the evidence engine. It answers "how do the apps that
actually work in this category do <flow>" with committed artifacts — full-res
screenshots, review corpora, and claims that cite them — instead of with a
model's recollection of what an app looks like.

It reads the **public App Store storefront only**. No credentials, no
subscription, no Mobbin, no Appllama. Same posture as `ship scout`.

## The split, which is the whole design

| Node does | You do |
| --- | --- |
| picks and ranks the apps, fixes the budget | nothing — the plan is deterministic |
| downloads metadata, screenshots, reviews | nothing |
| computes support counts, rating skew, velocity, weights | nothing |
| refuses a draft, an uncited claim, a broken hash, an over-budget run | fix what it names |
| | **read the screens and the reviews** — the only step a program cannot do |

The rule that follows: **never write a number Node computes.** `support`,
`ratingSkew`, `weight`, `ratingVelocity` are checked against the corpus, and a
guessed one fails `verify` rather than quietly becoming the record.

## Before the first run

The planner ranks a competitor set it does not gather:

```bash
ship aso competitors --locale en-US    # writes aso/en-US/competitors.json
```

Without that file `ship research plan` refuses and says so. Config is optional —
defaults apply — but the blocks exist:

```jsonc
"product":  { "category": "health-fitness", "audience": "…" },
"research": { "dir": "research", "providers": ["appstore"],
              "budget": { "apps": 12, "screensPerApp": 10, "reviewPages": 10 },
              "flows": ["first-launch","paywall","home"] }
```

## The pipeline

```bash
ship research plan  [--flows a,b] [--apps n] [--locale en-US] [--name q4]
ship research fetch [--refresh] [--slug 2026-09-02]
ship research capture ./device-shots --app "Competitor"
ship research verify
ship research index
```

Every run lives at `research/<slug>/`, slug = the date (plus `--name` when one
date holds two runs). `--slug` acts on an older run; with no flag every
subcommand takes the newest.

`plan` → `fetch` → **you read** → `verify` → `index`. `verify` is a gate: it
exits non-zero and lists every issue at once. Do not proceed past a failing
`verify` by editing the gate.

## Flows, not screens

Research is requested **per flow**. The vocabulary is closed and lives in
`src/lib/flows.mjs` — 31 ids in five groups, and it is the join key across
research references, `design/ux.json`, analytics event names and QA captures.
A flow id that is not in that file is a typo, and `requireFlow` says so.

Default six when nothing is configured: `welcome`, `personalization`,
`first-value`, `home`, `paywall`, `empty`. Researching all 31 spends the whole
fetch budget proving things nobody asked about.

## What `fetch` leaves you

One reference per marketing screenshot, written as a **draft**: `flow`,
`observations` and `doNotCopy` are absent rather than guessed, and `_todo`
names what is missing. Fields beginning `_` are annotations every loader
ignores and every schema tolerates.

Your job, per reference in `references/*.json`:

- **`flow`** — one id, and it must be one of the run's planned flows.
- **`observations`** — `summary`, `hierarchy`, `copy` (≤8 strings), `components`
  (≤12), `motion`, `monetization`. All capped, deliberately: a reference is a
  note, not an essay. Write what is *on the screen*, not what you infer from it;
  inference belongs in `patterns.json` where it has to declare itself.
- **`doNotCopy`** — required, non-empty. What in this screen is that app's brand
  or IP: the wordmark, the mascot, the photography, the specific phrasing. The
  field is required because the gate's job is to make sure the question was
  asked, before an agent reproduces a competitor's onboarding screen for screen
  and Apple rejects the clone.
- Then **delete `_todo`**. A leftover `_todo` fails `verify` by name.

`position` is already filled and is evidence in itself: it is the marketing-shot
ordinal, which is the competitor's own ranking of what matters most about their
app. Shot 1 is what they believe sells it. `index` scores later shots down
gently for exactly that reason.

Do not touch `image.sha256`. `verify` re-hashes every asset; a mismatch means
the notes and the pixels drifted apart and every observation is now about a
different screen.

### Your own captures

`ship research capture ./dir --app "Name"` ingests PNG/JPG you recorded on a
device as `provider: "manual"` references, in filename order, with `position:
null` — a journey you walked has an ordering but not a developer's ranking.
Re-running the same directory overwrites its own references instead of doubling
them. These need the same three fields filled.

## Reviews → `themes.json`

`fetch` pulls both RSS orderings, and they answer different questions:
`mostrecent` is what broke in the last release, `mosthelpful` is what has been
wrong for years. Merged, deduped, newest first, in `reviews/<trackId>.json`.

You write `themes.json`: `label` (≤60 chars), `kind` (`pain` `job` `request`
`churn-reason` `praise`), `quotes` (≤3, verbatim, ≤200 chars), `reviewIds`, and
optionally `flow` and `trackId`.

- `support` **must equal** `reviewIds.length`.
- Every id must exist in the corpus. A theme citing a review the fetch never
  returned is how a synthesized quote gets attributed to nobody, and it is the
  single failure this check exists for.
- `ratingSkew` is optional and is checked against the corpus when present — the
  supporting reviews' mean minus the app's own mean. Omit it unless you computed
  it from the actual ids; a negative skew is the useful signal (this theme
  travels with unhappiness) and a guessed one is worse than none.

Reviews are the cheapest jobs-to-be-done source in existence and they are about
*their* users, not yours. A 1★ pattern in the leader is your product spec.

## Inference → `patterns.json`

Every claim declares what it is:

- `kind: "evidence"` — **needs ≥3 refs**. Fewer is a coincidence with citations.
- `kind: "hypothesis"` — needs ≥1 ref and should name its `assumptions`.
- `counterexamples` is **required and may be empty**. It is required so that you
  have to go looking for one. A claim with three supporting refs and no search
  for a contradiction is a claim you found because you went looking for it.
- `refs` must be reference ids that exist in this run; `themeLabels` links a
  review-grounded claim back to the theme it came from.

`verify` checks citation, not truth. Whether a claim is *true* is not a gate's
business; whether it is *cited* is.

## Reading `index.json`

```bash
ship research index          # ranked, joined, provider-agnostic
```

`ship design` (and anything downstream) reads this one file and never learns
which provider produced any of it. Three things in it are worth acting on:

- **`weight`** — `stars × log10(ratings+1)`. A 4.8 over 300 ratings is a nicer
  app than a 4.4 over 300k and far weaker evidence about what works.
- **`coverage`** — flows with zero references. The command warns; the fix is
  another `capture` or a wider `--apps`, not a claim written anyway.
- **`ratingVelocity`** — ratings gained per day since the *previous* run. It is
  Shipkit's free stand-in for the downloads number the storefront withholds, and
  it is `null` on a first run. This is the argument for running `research` on a
  schedule against the same competitor set: the second run is the first one
  worth reading.

## The budget

`plan` prices the run exactly — one lookup per app, one GET per screenshot, one
per review page per sort — and `verify` checks the artifacts against that cap
rather than against the fetcher's own tally, because a tally can be wrong in
exactly the direction that makes it useless. `fetch` caches to
`.cache/storefront`, so an interrupted run does not pay Apple twice; `--refresh`
is the only thing that re-fetches held apps.

Assets are committed. That is deliberate: a re-run of a past decision costs zero
fetches, and the screenshot a claim rests on is still there a year later.

## What the tool cannot enforce

- **Evidence is not a licence to copy.** Everything here is one category's
  answer to a problem. Reproducing it screen for screen fails review and, worse,
  ships the most readable, most easily beaten part of a competitor's product.
- **The apps you research are the apps you will be compared to**, so research
  the leaders (`weight`), not the newest arrivals — `ship scout brief`'s clone
  gate exists because the recent arrivals in a hot term are everyone's same
  generated app.
- **A pattern common to twelve apps may be twelve apps copying one app.** Note
  it in `assumptions` when the claim rests on convergence alone.
