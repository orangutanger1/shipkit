# Apple Ads Platform API v1 — migration and backlog

Source: [Apple Ads Platform API Preview Release Notes](https://ads.apple.com/adsdam/app-store/us/en_us/documents/api-preview-guide.pdf), July 2026.

Two separate things live in here. The **migration** is not optional and has a date
on it. The **backlog** is new capability worth taking once a client exists.

## Status

Verified live against a real ad account (org 23259140) on 2026-09-03, read-only.
Everything in the table below is an observed response, not a reading of the PDF —
the preview guide is wrong or incomplete in four places and they are marked.

| Fact | Evidence |
| --- | --- |
| Platform API v1 is live and usable today | `GET /v1/me` → `200 {"result":{"orgId":23259140,"userId":107265077}}` |
| Auth needs no new code | `asc ads auth token --confirm --output json` returns a bearer token from the stored profile. v5 and v1 take the same token, so shipkit does its own HTTP while handling **no private key and storing no credential**. |
| `X-AP-Context` accepts either spelling | `adAccountId=<id>` and `orgId=<id>` both returned `200`. The ad account id **is** the old org id. |
| `asc` 2.5.0 cannot reach v1 at all | `--path v1/me` → `Error: --path must start with v5/`; a full `https://api.ads.apple.com/...` URL → `Error: --path must be an Apple Ads v5 URL`. The raw passthrough is genuinely closed. |
| Campaign Management API v5 sunsets | **2027-01-26** |
| **The performance-report endpoint was not found** | `reports/*` is routed but every v1 path under it 404s into the *legacy* envelope. Blocks `pullReport`, and therefore `ads report`, `ads mine`, `ads snapshot` and `ship status ads`. **A full cutover is impossible until this is known.** |

### Reading the two error envelopes

The host serves two services, and which envelope comes back tells you which one
answered — this is the fastest way to tell a wrong path from a wrong body:

| Shape | Means |
| --- | --- |
| `{"result": …, "pagination": …}` | v1 answered |
| `{"error":{"code","details":[{code,message,info:{field}}]}}` | v1 rejected the body — `details[].info.field` names the offending key |
| `{"data":null,"pagination":null,"error":{"errors":[{messageCode,…}]}}` | the **legacy** service answered; the path is not a v1 path |
| `503` + nginx HTML | the path prefix is **not routed at all**. This is a typo in the path, *not* an outage — `ad-groups/query` 503s and `adgroups/query` works. |

## Done

- **`ship aso volume --file` accepts raw v1 payloads.** `normaliseVolume` in
  `src/commands/aso.mjs` unwraps `result` / `result.rows` and reads `text` and
  `searchTerm` keys, so a saved response from either popularity endpoint imports
  with no hand-editing. Covered by `test/aso.test.mjs`.
- **`ship aso volume --fetch` measures popularity over the network** (backlog 1,
  closed). `src/lib/aso-volume.mjs` + `v1Suggestions` in `ads-http.mjs`; one call
  per harvested candidate, `--max` caps the budget. Verified live against org
  23259140 on 2026-09-03: 70 candidates, 70 calls, 8 measured, 62 at the floor.
  See the endpoint's own grammar below — it does not obey the rules the other
  `/query` endpoints do.

### `POST /v1/suggestions/keywords/query` — verified grammar

```jsonc
{
  "filters": [
    { "field": "promotedObjectId",   "operator": "EQUALS", "value": ["6797103341"] },
    { "field": "promotedObjectType", "operator": "EQUALS", "value": ["APPSTORE_APP"] },
    { "field": "terms",              "operator": "IN",     "value": ["car care"] },
    { "field": "countriesOrRegions", "operator": "IN",     "value": ["US"] }
  ],
  "pagination": { "pageSize": 100, "offset": 0 }
}
```

Four things it does that no other v1 endpoint does, each of which cost a probe:

| Rule | Evidence |
| --- | --- |
| every `value` is an **array**, `EQUALS` included | a scalar returns `VALIDATION_ERROR` / `REQUEST_INVALID` **"Request body is not readable"**, which names no field. This is Jackson failing to bind, not a validator — it looks identical whatever you got wrong. |
| `promotedObjectId` + `promotedObjectType` are **required**, `EQUALS` only | omitting either → `REQUIRED_VALUE_FIELD filters.promotedObjectId`; `IN` → `Operator 'IN' is not supported for field 'promotedObjectId'` |
| the app must belong to **this** ad account | another publisher's adamId → `INVALID_INPUT adamId App not found or access denied` |
| `terms` takes an array and honours only the **first** entry | `["qqxzv wobble","instagram","car maintenance log"]` returned one row, for `qqxzv wobble`. Silently. One term per call is the contract. |

`countriesOrRegions` is optional and validated: `ZZ` → `INVALID_INPUT storefront`.
Omitting `terms` returns the account's whole suggestion universe (202 rows here),
which is backlog 5's seed source, not a demand reading.

**Popularity is 5-100, not 0-100, and 5 is also the "no data" sentinel.** Across
426 live rows nothing came back below 5; 36% came back at exactly 5, including
invented terms (`qqxzv` → 5). A real 5 and an unknown are indistinguishable, so
`volumeTerms` drops floor rows rather than recording them — writing them would
flatten every long-tail candidate onto one value and hand the ranking to
competition alone, which is the failure `aso.mjs`'s header comment names.

**Popularity is seed-relative.** `car care` reads **26** as its own seed and
**14** inside `carfax`'s expansion. The expansion rows are therefore not
interchangeable with a direct reading, and `collectPopularity` reads only the row
matching the term it asked about — reusing an expansion row to save a call would
put two scales in one column. This is why the command is N calls, not fewer.

Concurrency is fine: fifteen parallel calls answered in 929ms, against ~620ms
each serially. `collectPopularity` runs batches of five.

## Migration — required before 2027-01-26

### Verified request grammar

```jsonc
// POST https://api.ads.apple.com/v1/<resource>/query
{
  "filters":    [{ "field": "campaignId", "operator": "EQUALS", "value": 2144514548 }],
  "pagination": { "pageSize": 2, "offset": 0 }
}
```

- the key is **`value`** (singular), not `values` — `values` is rejected outright;
- `campaignId` **must** use `EQUALS`; `IN` is refused with
  `campaignId condition must use EQUALS operator`;
- pagination is **`{pageSize, offset}`** — `limit`, `size` and `maxResults` are all rejected;
- the response echoes `pagination` back, so paging is offset arithmetic over `pageSize`;
- `result` is a **bare array** for every `query` endpoint, not `{rows: […]}`.

Note that `/v1/suggestions/keywords/query` breaks the first rule: there `value` is
always an array, even under `EQUALS`. Do not generalise either grammar onto the
other — see [its own section](#post-v1suggestionskeywordsquery--verified-grammar).

### Structural changes that hit code we already have

| Where | v5 today | v1 (verified) |
| --- | --- | --- |
| base URL | `api.searchads.apple.com/api/v5/` | `api.ads.apple.com/v1/` |
| context header | `X-AP-Context: orgId=…` | `adAccountId=…` (the same number) |
| `ads.mjs` `orgOf`/`requireOrg` | `ads.orgId`, `ASC_ADS_ORG_ID` | `adAccountId`; the old `parentOrgId` becomes `orgId` |
| response envelope | `data` | `result` (bare array on `query`) + sibling `pagination` |
| list/find | `POST …/find`, `conditions`, `orderBy` | `POST …/query`, `filters`, `sorting` — see the grammar above |
| **ad group path** | `ad-groups` | **`adgroups`** — no hyphen. *The preview guide is wrong here; the hyphenated path 503s.* |
| hierarchy | parent ids in the path | flat top-level resources, parent id as a `filters` entry |
| campaign geo + placement | `countriesOrRegions`, `supplySources` | **`targeting: {countryOrRegion: {include: […]}, supplyPlacement: {include: […]}}`**. *Not mentioned in the preview guide at all; found by reading a live campaign.* |
| campaign budget | `dailyBudgetAmount: {amount, currency}` | **`dailyBudget: {value: {amount, currency}}`** — one level deeper than the guide states. Lifetime budget is gone. |
| ad group bid | `defaultBidAmount` | `bidStrategy: {bid: {amount, currency}, bidStrategyGoal: "TAP", bidStrategyType: "MANUAL_CPT"}` |
| keyword bid | `bidAmount` | plain **`bid`: {amount, currency}** — not `bidStrategy.bid`, which is the ad-group spelling |
| campaign app | `adamId` | `promotedObjectId` (string) + `promotedObjectType: "APPSTORE_APP"`, immutable after create |
| `adGroupBody` | `pricingModel: 'CPC'` | no `pricingModel`; `bidStrategyType: MANUAL_CPT` carries it |
| `updateKeywords` | keyword `status: 'ACTIVE'` | `'ENABLED'` (same for negative keywords) |
| `bindProductPage` | ad body carries `creativeType` + `productPageId` | create a **Creative** first, ad references `creativeId`. Live creative shape: `{creativeType: "DEFAULT_PRODUCT_PAGE", destination: {destinationType: "APP_STORE_PRODUCT_PAGE", parameters: {adamId}, url}}` |
| `lib/cpp.mjs:15-17` | `/v5/apps/{adamId}/product-pages`, joined **by name** | `POST /v1/product-pages/query` returns a real `productPageId`; creatives take it in `destination.parameters` |
| `reportRows`/`totalsOf` | `res.data.reportingDataResponse.row` | **unknown — endpoint not found.** Blocks the cutover. |

New fields worth reading that v5 never returned: `deleted`, `displayStatus`,
`systemStatus`, `systemStatusLimitingReasons` (backlog 6), `paymentModel`,
`regulationResponses`, and `automatedKeywordsRequired` on ad groups.
Times come back as `2026-08-23T18:28:09.044` — **no trailing `Z`**, so
`parseAppleTime` must not assume one.

Also deprecated: ad group `cpaCap` (we never emitted it) and lifetime budget.
`automatedKeywordsOptIn` survives.

Report-shape constraints from the preview guide, unverified because the endpoint
is not reachable — treat as unconfirmed until it is:

- all report types except campaign-level require a `campaignId` filter;
- ad-group-scoped keyword/search-term reports are gone as endpoints;
- search-term reports: ORTZ only, no `HOURLY`, restricted `groupBy`.

## Backlog — new capability, in the order worth taking

### 1. Real popularity into `aso volume` — **done**, see above.

### 2. Eligibility preflight before `ads sync`

**Verified reachable.** `POST /v1/eligibilities/apps/query` returns one record per
(supplyPlacement × countryOrRegion × deviceClass) with `state: ELIGIBLE|INELIGIBLE`
and a `reasons` array. Today `ads sync` will create a campaign targeting storefronts
where the app cannot serve and you find out from a zero-impression report a week
later. Belongs in `ship preflight` or as a gate inside `ads sync`.

### 3. Impression share in `ads report`

**Verified reachable.** `POST /v1/insights/apps/impression-share/query` — in v5 this was async
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

**Verified reachable.** `POST /v1/insights/apps/search-term-popularity/query` — filters `genre` +
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
