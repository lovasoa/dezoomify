# Unify the extension on MV3 and make the E2E browser-agnostic

Owner prompt (2026-09-06): drop the MV2/MV3 gap ("no good reason to keep
it"), make ~99% of extension code and tests browser-agnostic, and test the
extension end-to-end downloading actual images in both headless Chromium and
headless Firefox. Owner follow-up (2026-09-06): the broken do-nothing
extension was the main issue; fix it first, then test it for real.

## Context

- MDN documents the supported cross-browser MV3 pattern: one manifest
  declaring both `background.scripts` and `background.service_worker`; Chrome
  uses the service worker, Firefox (121+) the event page. `host_permissions`
  and `optional_host_permissions` are honored in Firefox MV3 (they are
  MV3-only keys; the MV2 overlay shipped them as dead keys).
- MV2 was chosen for ESR 115 compat; ESR 115 is past end of life.
- All extension sources are import-free plain JS in `.ts`; unit tests import
  them as ESM. Shipped JS is identical classic-safe code for both browsers
  (strip `export` at staging for background/content; the page is a module
  document).
- The webapp E2E already downloads real bytes from the deterministic fixture
  server on loopback; the extension E2E reuses the same fixture pyramid and
  pixel assertions.

## Non-goals

- No new store submission in this plan (store resubmission follows the
  standing store authorization after the work lands).
- No MV2/ESR-115 support path; `strict_min_version` is 128.0.
- AMO submission stays out of scope (owner authorization required).

## Phases

### Phase 1 - One MV3 manifest, one packaging path — DONE (2026-09-06)

1. `src/manifest/{base,chromium,firefox}.json`: MV3 everywhere; dual
   `background` (service_worker + scripts); object-form CSP with
   `wasm-unsafe-eval`; firefox overlay keeps only `browser_specific_settings`
   (gecko id, `strict_min_version: "128.0"`); chromium overlay keeps only
   `minimum_chrome_version: "121"`.
2. `scripts/generate-manifests.mjs` added (deterministic merge, underscore
   keys stripped; fixes the previously missing `build:manifests` script).
3. `package-store.sh`: single staging path; background/content staged as
   classic scripts (exports stripped), page/ staged as ES modules, wasm glue
   copied; `DEZOOMIFY_TEST_HOST_PERMISSIONS=1` injects loopback grants plus
   the tabs permission for the E2E only.
4. `manifest-policy.test.mjs` rewritten for the unified shape.

### Phase 2 - Make the extension run (real wiring) — DONE (2026-09-06)

1. Background is one-shot (`src/background/index.ts`): action click opens
   `page/page.html?tab=<id>`; install opens it once. No scan state, no
   observers, no timers: suspension is harmless by construction.
2. The page (`src/page/page.ts`) hosts the whole job: tab selection (bound
   tab from the action click, or a live tab list), the finite reload scan
   (`scan.ts` state machine wired to real webRequest/tabs effects registered
   in the page), candidate picking via format hints, the wasm discovery core
   inline, level planning with probe handling, tile fetches with the browser
   session, canvas assembly, and save through a download anchor.
3. Scan/candidates/fetch/redaction moved from `src/background/` to
   `src/page/` (they are page-driven now); unit tests updated.
4. Real-browser bug this phase fixed: the scan scheduler captured the global
   `setTimeout` and called it detached, which browsers reject as an "Illegal
   invocation" — invisible to Node-based unit tests.

### Phase 3 - Browser-agnostic E2E (real bytes, both engines) — DONE (2026-09-06)

1. `tests/browser/headless.test.mjs`: one shared E2E body plus two thin
   drivers. The real store-shaped package (E2E-only loopback grant) opens a
   fixture target page, scans, discovers via the wasm core, fetches tiles,
   assembles, saves, and the body verifies the saved PNG (512x512, per-
   quadrant colors, same fixture pyramid as the webapp E2E).
2. Chromium driver: Playwright persistent context + `--load-extension`.
   Firefox driver: Selenium/geckodriver with download prefs; the first-run
   page opens as a real tab, which is the automation foothold.
3. Classic-script parse checks for background/content kept in the same file;
   the earlier page-handle-only probes were removed.
4. `cargo xtask test extension` runs unit + E2E (both engines) +
   native-messaging and is green.

### Phase 4 - Docs and ledger — DONE (2026-09-06)

1. `docs/extension.md` rewritten for the page-driven MV3 architecture and
   packaging; `docs/testing.md` E2E section updated.
2. This plan remains until the remaining scope below lands.

## Remaining scope (not in this plan's done phases)

- Embed `packages/shared-ui` controller/view in the extension page (v1 ships
  a functional minimal UI with a visible job log).
- Native handoff wiring in the page (validation/consent modules exist and
  stay unit-tested; nothing calls them yet).
- Chromium store resubmission once the UI work lands (standing store
  authorization; fail closed without secrets).

## Risks

- Firefox event pages unload when idle; the fail-closed restart behavior is
  already the documented contract, and the E2E does not depend on long-lived
  background state.
- Playwright can automate Chromium extension pages directly; Firefox uses
  the extension-opened-tab foothold.
- The E2E-only manifest variant (loopback grants + tabs) must never ship;
  `package-store.sh` gates it behind an env var and the store lane does not
  set it.
