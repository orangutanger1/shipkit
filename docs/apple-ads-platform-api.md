# Apple Ads Platform API v1 — migration and backlog

Source: [Apple Ads Platform API Preview Release Notes](https://ads.apple.com/adsdam/app-store/us/en_us/documents/api-preview-guide.pdf), July 2026.

Two separate things live in here. The **migration** is not optional and has a date
on it. The **backlog** is new capability worth taking once a client exists.

## Status

| Fact | Evidence |
| --- | --- |
| Platform API host is live | `GET https://api.ads.apple.com/v1/me` → `401` (routing, not DNS/404) |
| `asc` 2.5.0 speaks v5 only | binary carries `api.searchads.apple.com`, `v5/campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords`; zero occurrences of `api.ads.apple.com`, `adAccountId`, `v1/insights` |
| `asc ads api request --path …` cannot reach v1 | the raw passthrough resolves against the searchads base URL |
| Campaign Management API v5 sunsets | **2027-01-26** — every `asc ads` call in `src/commands/ads.mjs` returns an error after that date |

So nothing below can be built until either `asc` ships Platform API support or
shipkit does its own HTTP. Authentication is **unchanged** between the two APIs
(same client-credentials token), so a direct client is viable; only the base URL,
the `X-AP-Context` value, and the request/response envelopes differ.

## Done

- **`ship aso volume --file` accepts raw v1 payloads.** `normaliseVolume` in
  `src/commands/aso.mjs` unwraps `result` / `result.rows` and reads `text` and
  `searchTerm` keys, so a saved response from either popularity endpoint imports
  with no hand-editing. Covered by `test/aso.test.mjs`. This is the manual half of
  backlog item 1; the automated half still needs a client.

## Migration — required before 2027-01-26

Structural changes that hit code we already have:

| Where | v5 today | v1 |
| --- | --- | --- |
| base URL | `api.searchads.apple.com/api/v5/` | `api.ads.apple.com/v1/` |
| context header | `X-AP-Context: orgId=…` | `X-AP-Context: adAccountId=…` |
| `ads.mjs` `orgOf`/`requireOrg` | `ads.orgId`, `ASC_ADS_ORG_ID` | `adAccountId`; the old `parentOrgId` becomes `orgId` |
| response envelope | `data` | `result` |
| list/find | `POST …/find`, `conditions`, `orderBy`, `ASCENDING` | `POST …/query`, `filters`, `sorting`, `ASC` |
| hierarchy | parent ids in the path | flat top-level resources, parent ids in the body |
| `ads.mjs` `mine` search-term payload | `selector: { orderBy, pagination }` | top-level `filters` / `sorting` / `pagination` |
| `lib/asa.mjs` `resolveBidding`, `ads.mjs` `adGroupBody` | `defaultBidAmount` | `bidStrategy.bid` |
| `ads.mjs` `campaignBody` | campaign `adamId` | `promotedObjectId` + `promotedObjectType: "APPSTORE_APP"` (immutable after create) |
| `ads.mjs` `campaignBody` | `dailyBudgetAmount` — campaign only, and lifetime budget is already rejected | `dailyBudget` only; still no ad-group budget |
| `ads.mjs` `adGroupBody` | `pricingModel: 'CPC'` | doc uses `CPT` / `bidStrategyType: MANUAL_CPT` throughout |
| `ads.mjs` `updateKeywords` | keyword `status: 'ACTIVE'` | `'ENABLED'` (same for negative keywords) |
| `ads.mjs` `bindProductPage` | ad body carries `creativeType` + `productPageId` | `creativeType` removed from the ad object; create a **Creative** first, ad references `creativeId` |
| `ads.mjs` `reportRows`/`totalsOf` | `res.data.reportingDataResponse.row`, `total` or summed `granularity` | `result.rows[].totalMetrics` / `granularMetrics` / `metadata`, plus `summary.grandTotal` |
| report options | `returnRowsWithNoMetrics: true` | `options.includeRows: ["EMPTY_METRICS"]` — mutually exclusive with `groupBy` |
| `ads.mjs` `LEVELS` | selector fields are Apple's, and the error message over-reports them: there is no `installs`, and `campaignId` is rejected at ad-group level | re-verify the whole projection: v1 renames the metric block |
| `lib/cpp.mjs:15-17` | Ads exposes `/v5/apps/{adamId}/product-pages`, joined **by name** | `POST /v1/product-pages/query` returns a real `productPageId`; creatives take it in `destination.parameters` |

Also deprecated: ad group `cpaCap` (we never emitted it) and lifetime budget.
`automatedKeywordsOptIn` survives.

The creative split is the sharpest edge: `bindProductPage` becomes two calls plus a
new entity to reconcile idempotently.

Report-shape constraints worth knowing before rewriting `ads mine`:

- all report types except campaign-level require a `campaignId` filter, so the
  per-campaign fan-out in `pullReport` survives structurally;
- ad-group-scoped keyword/search-term reports are gone as endpoints — filter by
  `adGroupId` on the consolidated one instead;
- search-term reports: **ORTZ only** (no UTC), no `HOURLY`, and `groupBy` excludes
  `storefront`, `ageRange`, `gender`, `countryCode`, `adminArea`, `locality`.

## Backlog — new capability, in the order worth taking

### 1. Real popularity into `aso volume`

`POST /v1/suggestions/keywords/query` takes `terms IN [...]` + `countriesOrRegions`
and returns `{text, popularity}` on the 0-100 axis. That is the per-term lookup the
demand table has never had: `aso.mjs`'s own comment notes that *a fabricated 50
outranks real terms*, and `VOLUME_TEMPLATE` ships literal placeholder rows.

Wire it as a network source behind a flag, writing the same
`aso/<locale>/volume.json` the `--file` path already produces. Gated on an ad
account, so `ship scout` — deliberately credential-free — stays on the autocomplete
rank proxy.

### 2. Eligibility preflight before `ads sync`

`POST /v1/eligibilities/apps/query` returns one record per
(supplyPlacement × countryOrRegion × deviceClass) with `state: ELIGIBLE|INELIGIBLE`
and a `reasons` array. Today `ads sync` will create a campaign targeting storefronts
where the app cannot serve and you find out from a zero-impression report a week
later. Belongs in `ship preflight` or as a gate inside `ads sync`.

### 3. Impression share in `ads report`

`POST /v1/insights/apps/impression-share/query` — in v5 this was async
(`POST /v5/custom-reports` → poll → `GET /v5/custom-reports/{id}`), which is why we
never used it; v1 is a single synchronous call and adds `FIRST_SLOT` alongside
`ALL_SLOTS`. It answers the question `ads report` currently cannot: the
`ads.mjs:406` warning *"campaign(s) spent with zero installs"* can't distinguish
losing the auction from never entering it.

### 4. Bulk keyword writes in `ads sync`

`POST /v1/keywords/bulk-create|bulk-update|bulk-delete` and the negative-keyword
equivalents, with a `correlationId` per item and `allowPartialSuccess`. Collapses
the per-keyword loop at `ads.mjs:992-996` into one call per ad group, with per-item
results instead of all-or-nothing.

### 5. Search term popularity as a seed source

`POST /v1/insights/apps/search-term-popularity/query` — filters `genre` +
`countryOrRegion`, granularity `WEEKLY_SUN_SAT` or `MONTHLY`, returns
`rankInGenre`, `searchPopularityInGenre`, `searchPopularity1to100`,
`searchPopularity1to5`.

It is a genre leaderboard, **not** a per-term oracle: you cannot ask about one
term, and shipkit's 3-4 word long-tail candidates will mostly miss. Two real uses:
seeding `aso harvest` (which today needs human `aso.seedsByLocale`), and
week-over-week trend deltas, which nothing in shipkit currently sees —
`analytics terms` is retrospective and yours-only.

### 6. Campaign health in `ship status ads`

`systemStatusLimitingReasons` on the campaign object says why a campaign is not
running. Incomplete as specified: the endpoint identifying *which* storefront is
affected is "shared later" in the preview doc.

### 7. Attribution loop (needs app-side work)

AdServices payloads carry `keywordId` and `adId`, joinable against keyword- and
ad-level reports for true cost-per-install per keyword. Requires client-side token
capture, so at most `templates/app/` ships the snippet — shipkit is a CLI.

## Explicitly out of scope

- **Ads on Apple Maps** / `BUSINESS_BRAND` — wrong surface. Note that an ad account
  is provisioned for exactly one surface (`APPSTORE_APP_MANUAL` vs
  `BUSINESS_BRAND_MANUAL`) and cannot be repurposed.
- **`/v1/shared-budgets`** (replaces budget orders) — Apple Ads Advanced on monthly
  invoicing only; irrelevant at a $10/day budget.
- **Ad account creation**, **advertiser resources / delegations** — one-time console work.
- **Assets API** — we never read asset URLs. Relevant only because app- and
  product-page locale endpoints now return bare `assetId`s instead of full objects.
- **Client libraries** (Swift/Python/Java/Node.js, open source, Summer 2026) — a
  Node.js client would remove the need to hand-roll HTTP, but pulls a dependency
  into a repo whose `package.json` currently has `"dependencies": {}`. Evaluate when
  it exists; the direct-`fetch` path is small enough that the dependency has to earn
  its place.
