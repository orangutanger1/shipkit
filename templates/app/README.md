# __NAME__

An Expo managed iOS app, scaffolded by `ship new` and already wired to the
shipkit release pipeline.

- **Bundle id:** `__BUNDLE_ID__` (the development build gets `__BUNDLE_ID__.dev`)
- **Scheme:** `__SCHEME__` (`__SCHEME__dev` for the development build)
- **Router:** expo-router, screens live in `app/`
- **Monetisation:** RevenueCat, entitlement `pro`, wired in `src/purchases/`
- **Languages:** `en` and `de`, catalogues in `src/i18n/`

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
| `ship aso suggest` | fill the 100 keyword characters optimally |
| `ship meta lint` | offline validation of `store/staged/*.json` |
| `ship loc draft` | translate the listing into the rest of `store.locales` |
| `ship loc review` | gate: the localized listing against the glossary |
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

## Languages

The app ships `en` and `de`. `src/i18n/en.ts` is the source of truth; every
other catalogue is typed against it, so a key you forget to translate is a
build error rather than an English sentence in the middle of a German screen.

```tsx
import { t } from '../src/i18n';

<Text>{t('home.action.upgrade')}</Text>;
```

Add a language by dropping `src/i18n/<code>.ts` next to the others and listing
it in `CATALOGUES`. `app.config.js` reads this directory to build
`ios.infoPlist.CFBundleLocalizations`; do not maintain that array by hand. iOS
offers the app only the languages the bundle declares, so an undeclared
catalogue is dead code — the phone reports `en`, and the localized listing you
paid for sells an English binary.

**The one rule: the binary and the listing share one vocabulary.**
`store/glossary.json` holds it — the source term, its translation per locale,
and the `neverTranslate` list (the app name, the entitlement, anything the
paywall calls a product). A feature named one way in `src/i18n/de.ts` and
another way in the German listing costs you the install twice: the searcher
does not find the word they typed, and the person who installs anyway does not
find the feature they were sold. `ship loc review` fails on that mismatch.

## Native vs OTA

`runtimeVersion.policy` is `appVersion`, so an OTA update only reaches builds
with a matching marketing version. `ship build` fingerprints native
dependencies and refuses to push an OTA update when they changed — that
combination is how you brick every installed copy at once.
