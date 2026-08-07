# __NAME__

An Expo managed iOS app, scaffolded by `ship new` and already wired to the
shipkit release pipeline.

- **Bundle id:** `__BUNDLE_ID__` (the development build gets `__BUNDLE_ID__.dev`)
- **Scheme:** `__SCHEME__` (`__SCHEME__dev` for the development build)
- **Router:** expo-router, screens live in `app/`
- **Monetisation:** RevenueCat, entitlement `pro`, wired in `src/purchases/`

## First run

```sh
npm install
eas init            # fills extra.eas.projectId in app.json
ship doctor         # every precondition, in one exit code
```

`ship doctor` fails until `eas init` has run. That is deliberate: an app with a
null projectId builds locally and then dies in CI.

## Day to day

```sh
npm start           # dev server, APP_VARIANT=development
npm run ios         # same, opening the dev client
```

The development build carries a `.dev` bundle identifier suffix. iOS allows one
app per identifier, so without the suffix a TestFlight install silently replaces
your development client and Fast Refresh disappears with no error anywhere.

## RevenueCat

Set `EXPO_PUBLIC_RC_IOS_KEY` (public SDK key, not a secret) in `.env` or in the
EAS environment for each profile. Without it the SDK configures nothing and the
paywall renders empty — `initPurchases()` warns rather than throwing.

```sh
ship rc status      # project, entitlements, offerings, product count
ship rc audit       # gate: exits 1 on anything that renders an empty paywall
```

## The pipeline

| Command | What it does |
| --- | --- |
| `ship doctor` | preconditions: toolchain, config, credentials, identities |
| `ship aso harvest` | pull real competitor keywords for your markets |
| `ship aso score` | rank harvested terms by traffic vs difficulty |
| `ship aso pack` | fill the 100 keyword characters optimally |
| `ship meta lint` | offline validation of `store/staged/*.json` |
| `ship meta apply` | push the listing to App Store Connect |
| `ship shots` | validate and upload screenshots already on disk |
| `ship build` | EAS cloud build (native changes) or OTA update (JS only) |
| `ship preflight` | full readiness report before you submit |
| `ship status` | release dashboard: version, builds, TestFlight, review |

## Store listing

`store/staged/en-US.json` is the authored listing: one file per locale. It ships
empty on purpose, with a `notes` block spelling out the 30/30/100/170/4000
character limits and the two keyword rules that cost the most traffic:

1. No space after commas — every space burns one of your 100 characters.
2. Never repeat a word from the name or subtitle — those are already indexed.

Delete the `notes` block once the listing is written; every ship command ignores
it either way.

## Native vs OTA

`runtimeVersion.policy` is `appVersion`, so an OTA update only reaches builds
with a matching marketing version. `ship build` fingerprints native
dependencies and refuses to push an OTA update when they changed — that
combination is how you brick every installed copy at once.
