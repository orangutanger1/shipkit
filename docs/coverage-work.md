# Getting to 100% coverage

`npm run test:c8` gates on `--100`. This is the standing brief for closing the
gap, written so a fresh session can pick up a file and finish it without
re-deriving any of it.

## The loop, per file

1. **Measure.** `npm run coverage:json` once (≈2 min, whole suite), then
   `npm run coverage:gap` for the worst-first list, and
   `node scripts/coverage-gap.mjs <path fragment>` for one file's detail. The
   detail form prints, for every uncovered branch, **the source text of the arm
   that never ran** — `"?? []"`, `": 's'"`, the body of an `if`. That text is
   the thing to make happen.
2. **Read the code around each arm.** Decide, one at a time: is there an input
   that reaches it?
3. **Write the test, or delete the arm.** Both are correct outcomes — see
   *Dead code* below. Never write a test that reaches into a module to force a
   state the command cannot produce.
4. **Verify.** `node --test test/<file>.test.mjs`, then re-measure that one
   file:
   ```
   npx c8 --reporter=text --include 'src/<the file>' node --test test/*.test.mjs
   ```
   (Every test file may touch it, so measure against the whole suite, not just
   the one you edited.)
5. **Finish the file.** 100% statements, functions *and* branches before moving
   on. A file left at 98% is a file someone has to re-read from scratch.
6. **Full check, then commit.** `npm test`, `npm run typecheck`, `npm run lint`.
   One commit per file (or per closely-related pair).

## Dead code is a finding, not an obstacle

A large share of the remaining branch arms cannot be reached, and the honest
close is to delete them. Ones already found and removed:

- `cfg.aso.minVolume ?? 0` — `DEFAULTS` is deep-merged into every config, so the
  key is always present. Same for any other default-backed key **that the user
  cannot null out** (`deepMerge` lets a user's `null` replace a default, so
  `store.locales ?? []` *is* reachable — that one got a test).
- `packedProposal(...).keywords` over the 100-char limit — `packKeywords` stops
  at the limit it was given, so the guard downstream could not fire.
- `loadConfig()` returning null when `optional` is not set — it throws.
- `stack.pop()` returning undefined inside `while (stack.length)`.
- A `?? ''` on a field the function itself assigned two lines earlier.

Before deleting, prove it: read the producer of the value, not just its type.
Where a type says "optional" but the producer always sets it, **tighten the
type** (`stableGlossary`'s return) rather than leaving a fallback nobody can
reach. Say which it was in the commit message.

## What a test here looks like

Match the file you are adding to; the suite has one voice.

- **Test names are sentences about behaviour**, not about coverage: *"a harvest
  walled halfway keeps what it already paid for"*, not *"covers onPartial"*.
  Never name a line number or a branch.
- **Comments say why the case exists** — the real failure it stands for. If a
  case is only here to reach an arm, that is a smell: either it represents
  something real (write that down) or the arm is dead.
- Assert on **what the operator sees**: the message, the hint, the exit code,
  the file on disk. Not on internals.
- **Offline, always.** `test/fixtures/cmd.mjs` gives you `repo`, `inDir`,
  `capture`, `withFetch`, `fakeBins`/`setBin` (fake `asc`/`eas`/`npx`),
  `fakeHome`, `linkNativeDeps` (stand-in sharp/fontkit/puppeteer in
  `test/fixtures/native`). An unstubbed `fetch` throws by design.
- Slow knobs have env overrides — `SHIP_STOREFRONT_BACKOFF_MS=5`, set before the
  module is imported. Do not sit through a real backoff.
- Prefer driving the **command** over the helper: it covers the helper too, and
  it tests the thing that ships.

## Commit style

Follow the log. Subject `test(<area>): <what is now covered>`, lower case, no
period. Body: what was untested and why it mattered, then any source change and
the reason it was unreachable. Wrap at ~76. End with the session trailer that
the current session's instructions give.

## Bookkeeping

Coverage is not the only gate: `npm run metrics` counts CRAP, which falls as
coverage rises. Do not chase it separately.
