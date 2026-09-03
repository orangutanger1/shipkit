# Apple's Analytics Reports API — what `ship analytics pull` actually gets

Verified live against app 6797103341 / request `841f7624-…` on 2026-09-03, using
`asc` 2.5.0. Everything below is an observed response.

## The four things that made `pull` not work

All four were live failures, not review findings, and all four are silent —
none of them produces an error that names its own cause.

| # | Bug | How it showed |
| --- | --- | --- |
| 1 | **Instance listings carry no `processingDate`.** `asc analytics reports links` answers with bare relationship identifiers — `{"type","id"}` and nothing else. The window filter compared `''` against `from`, dropped every instance, and the command died claiming *"analytics request … has no report instances in \<window\>"* — blaming Apple's 48 h backfill for a filter bug. | `pull` had never returned data for this app. After the fix, the same window found **38 segments**. |
| 2 | **Two segments of one instance collide on disk.** `asc analytics download` names the file after the *instance*, not the segment, so in a shared directory the second download silently overwrites the first. | Instance `9d9e0f96` has two segments; they are 5 and 8 rows of different data under one filename. Downloaded into one directory, 10 segments produced 9 files. |
| 3 | **`/discovery\|engagement\|install\|download/` matches four different cuts of the same day.** Discovery and Engagement **Standard** *and* **Detailed**, plus **Web Preview** Engagement, which is the website surface rather than the App Store. Summing them multiplies the funnel. | On 2026-08-28: Standard 1,273 impressions, Detailed 1,086, Web Preview 0/8 page views. |
| 4 | **Apple serves a DAILY *and* a WEEKLY instance under the same `processingDate`.** Folding both counts the week on top of the day. | 2026-08-28 carried Discovery and Engagement Standard at both granularities: 1,273 (DAILY) and 600 (WEEKLY). |

There is a fifth, which is why `foldReports` exists at all: these reports **do
not share a header**, and `foldRecords` reads the column roles off the *first*
record it is given. Handed a concatenation of every report, it read every row
through whichever report happened to be parsed first and silently dropped the
rest. The live failure was `the downloaded reports have no impression / page
view / install columns`, listing App Downloads' headers — the funnel had been
folded through a report with no `Event` column at all.

## How the reports are reached

`asc analytics view --request-id <id> --date <day> --include-segments
--paginate` returns report → instance (**with** `processingDate` and
`granularity`) → segment (with a signed `downloadUrl`) in one payload, and only
for reports that produced data that day. That is one call per day in the window
against 157+ for the reports → instances → segments walk, and it is the only
route that carries the date. `collectSegments` walks days for exactly this
reason.

`asc analytics reports links` and `asc analytics instances links` are still the
documented route; `instances view` does return `{processingDate, granularity}`
per instance, but that is one extra call each.

## The reports worth reading

156 exist for this app; 7 produced data. `REPORTS` in `lib/analytics-api.mjs`
names six, one per concern:

| Concern | Report | Key columns |
| --- | --- | --- |
| impressions, page views | `App Store Discovery and Engagement Standard` | `Event` ∈ {Impression, Page view, Tap}, `Counts` |
| installs | `App Downloads Standard` | `Download Type` ∈ {First-time download, Manual update, Re-download}, `Counts` |
| deletions | `App Store Installation and Deletion Standard` | `Event` ∈ {Install, Delete}, `App Download Date` (the cohort day), `Counts`, `Unique Devices` |
| engagement | `App Sessions Standard` | sessions and unique devices |
| quality | `App Crashes` | crash counts |
| revenue | `App Store Subscription State Report Standard` | subscription states |

Only the first three had produced instances for this app; the other three are
requested and come back absent, which `foldReports` reports as `null` rather
than zero. **That distinction is the point** — `analytics diagnose` reads a
missing report as `unknown` and names the command that would answer it, never
as a passing stage.

The absence is Apple's, not ours. Enumerating the `ONGOING` request on
2026-08-28 returns nine report/granularity instances, and `App Sessions
Standard` and `App Crashes` are not among them:

```
App Downloads Standard                        DAILY   segs=2   ← read
App Store Installation and Deletion Standard  DAILY   segs=1   ← read
App Store Discovery and Engagement Standard   DAILY   segs=1   ← read
App Store Discovery and Engagement Standard   WEEKLY           ← skipped, granularity
App Store Discovery and Engagement Detailed   DAILY/WEEKLY     ← skipped, not in REPORTS
App Store Web Preview Engagement Std/Detailed DAILY            ← skipped, website surface
Platform App Installs                         DAILY            ← skipped, not in REPORTS
```

So `analytics diagnose`'s hint for an unmeasured crash rate — *run `analytics
pull`* — is the right instruction only once Apple provisions the report. There
is no request field that asks for it; the report set is Apple's to populate.

Notes on reading them:

- **Only a first-time download is an install.** `Manual update` and
  `Re-download` are the same person again; counting them turns a release week
  into a fake acquisition spike. On 2026-08-28: 5 first-time, 12 updates, 3
  re-downloads.
- **A `Tap → Get` is not an install.** It is the tap that starts one, and it
  lives in the engagement report. Installs come from App Downloads.
- **Downloads and installs disagree, correctly.** Apple counted 5 first-time
  *downloads* and 2 first-time *installs* on the same day: a download is an App
  Store transaction, an install is a device event.
- `App Store Installation and Deletion` carries `App Download Date`, so a
  deletion can be charged to the cohort it came from. `foldInstallDelete` only
  uses the ratio today; the cohort column is what a real retention curve would
  be built from.

## Search terms are not in the API

None of these reports carries a search-term column. `pull` writes an empty
terms file over the API, and `aso`'s demand table gets its terms from the App
Store Connect web export instead: **Analytics → Metrics → Search Terms →
Export**, then `ship analytics pull --file <export.csv>`.

## Timeouts

`asc analytics requests` is **slow on a cold cache, not down.** First call of a
session took 2m53s and returned normally; the next was 0.47s. It fails with
`retry cancelled: context deadline exceeded`, which reads like an outage and is
not one — bare `asc` behaves identically, so it is not shipkit. `ASC_TIMEOUT`
is read from the environment and `run()` inherits `process.env`, so
`ASC_TIMEOUT=300s ship analytics pull …` is the fix. Retry before concluding
the endpoint is broken.

`asc analytics download` can exceed its own default request timeout on a large
segment. It says so — *"Hint: Increase the request timeout (e.g. set
`ASC_TIMEOUT=90s`)"* — and `downloadSegments` warns and carries on rather than
failing the pull for one segment.
