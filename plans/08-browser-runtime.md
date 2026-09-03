# Phase 08: Browser Runtime

## Objective

Build the browser execution layer around the shared Rust core. This phase owns
workers, browser image decoding, display/clean surfaces, resource limits, and a
bounded optional browser cache for non-secret data. The runtime must support two
deliberately different tile paths:

1. **Ordinary image display path:** load cross-origin tiles as ordinary `<img>`
   elements without `crossorigin`. The runtime may position the elements directly
   or draw them into a display canvas. Drawing can taint that canvas; the assembled
   image remains visible and the UI offers browser/user-agent right-click save
   guidance where the browser supports it. The surface records
   `originClean = false` and forbids only programmatic pixel reads, processing,
   hashing, `toBlob`, `toDataURL`, and claims of clean export.
2. **Readable-byte path:** obtain readable metadata and tile bytes with `fetch` or
   an injected privileged transport, decode and process them, composite only
   origin-clean pixels, and export a clean file. Website proxy policy is owned by
   phase 09; extension privileged transport is owned by phase 12.

The browser runtime owns discovery driving, transport selection, cancellation, bounded scheduling, image decoding, compositing, export preflight, and structured progress. It does not own product-specific UI.

## Non-Goals

- Do not implement the website, extension, or desktop user interface.
- Do not treat canvas taint as a display failure. Do not attempt programmatic
  readback, processing, hashing, `toBlob`, `toDataURL`, or clean export when
  `originClean` is false.
- Do not add a general-purpose hosted proxy, select proxy capability before a
  classified CORS/network failure, or conceal the active transport. Phase 09 may
  automatically select its restricted proxy capability after that failure when
  the resource is eligible and the user has not opted out.
- Do not read cookies, accept cookie strings, or add browser cookie APIs.
- Do not duplicate dezoomer or tile-grid logic in TypeScript; that remains in the Rust core/Wasm boundary.
- Do not solve images larger than browser canvas or memory limits. Detect those limits and emit a native-handoff recommendation.
- Do not add service-worker caching, telemetry, background downloads, or storage
  of secrets. An optional browser cache must be bounded, clearable, and limited
  to explicitly classified non-secret resources.

## Dependencies

- Phases 01-07 are complete and green.
- `crates/dezoomify-core/` exposes pure discovery and tile-plan APIs without I/O.
- `crates/dezoomify-wasm/` exposes the generated Wasm boundary defined by the protocol phase.
- `crates/dezoomify-protocol/` is the canonical Rust protocol model.
- `packages/protocol-ts/` provides the generated TypeScript protocol, parsing, and exhaustive tagged-union helpers.
- Protocol and Wasm generated artifacts are clean under the exact locations established by phases 05 and 07.
- `crates/fixture-server/` and `testdata/scenarios/` provide deterministic
  same-origin, CORS-readable, CORS-denied, auth-required, delayed, failed-tile,
  and large-image scenarios with payloads and expected outcomes co-located in
  each scenario.
- Node, pnpm, Rust, `wasm32-unknown-unknown`, `wasm-bindgen-cli`, and Playwright browsers are pinned by the repository toolchain files.

If any dependency path differs, stop and reconcile this plan with phases 01-07. Do not create a second package with equivalent responsibility.

## Exact Paths

Create or modify only these paths in this phase:

- `packages/browser-runtime/package.json`
- `packages/browser-runtime/tsconfig.json`
- `packages/browser-runtime/src/index.ts`
- `packages/browser-runtime/src/types.ts`
- `packages/browser-runtime/src/session.ts`
- `packages/browser-runtime/src/worker.ts`
- `packages/browser-runtime/src/worker-client.ts`
- `packages/browser-runtime/src/buffers.ts`
- `packages/browser-runtime/src/transport.ts`
- `packages/browser-runtime/src/image-display-surface.ts`
- `packages/browser-runtime/src/readable-canvas-surface.ts`
- `packages/browser-runtime/src/cache.ts`
- `packages/browser-runtime/src/limits.ts`
- `packages/browser-runtime/src/export.ts`
- `packages/browser-runtime/test/*.test.ts`
- `tests/harness/browser-runtime/index.html`
- `tests/harness/browser-runtime/package.json`
- `tests/harness/browser-runtime/src/main.ts`
- `tests/harness/browser-runtime/src/style.css`
- `tests/harness/browser-runtime/tests/runtime.spec.ts`
- `tests/harness/browser-runtime/playwright.config.ts`
- `testdata/scenarios/browser-runtime/**`
- `crates/xtask/src/browser.rs`
- `crates/xtask/src/main.rs`
- `docs/browser-runtime.md`
- `docs/migration/gates.md` for the phase-08 execution record only
- `artifacts/phase-08/**` for ignored local evidence
- root workspace manifests only where required to register these packages and commands

Do not modify `apps/web/`, `apps/extension/`, `apps/desktop/`, or legacy migration snapshots.

## Command Availability

- Available before this phase: `cargo xtask fixtures verify`, `cargo xtask parity validate`, `cargo xtask test`, `cargo xtask protocol check`, `cargo xtask check`, `cargo xtask test wasm`, `cargo test --workspace`, and the root pnpm checks created in earlier phases. The unqualified `cargo xtask test` is the fast deterministic suite.
- Added during step 14: the `cargo xtask build wasm --browser-runtime` mode.
- Added during step 17: the complete `cargo xtask test browser` target.
- Until those xtask commands exist, use the direct commands shown in the relevant validation blocks. Do not report a missing future command as a product failure.

## Sequential Implementation Steps

1. Verify the phase boundary. Run `git status --short`, `cargo xtask protocol check`, `cargo xtask test`, `cargo test --workspace`, and the root pnpm typecheck command established in phase 05. Record pre-existing failures in `artifacts/phase-08/preflight.md`; do not edit files responsible for unrelated failures. Confirm the phase-07 WASM package exposes only its adapter capabilities and does not claim browser transport, worker, surface, cache, decode, or native-only encoder support; phase 08 adds the browser-runtime capability report.

   **Validate:** `git diff --name-only` must show no phase-08 edits yet. `cargo xtask protocol check` must produce no diff. Stop if generated protocol files are stale or browser Wasm cannot instantiate in the existing smoke test.

2. Add `packages/browser-runtime/package.json` and `tsconfig.json`. Declare dependencies only on the generated `dezoomify-wasm` package and `packages/protocol-ts`; keep React, Vite, Playwright, and product code out of runtime dependencies. Export the public entry point and make tests use the repository-standard runner.

   **Validate immediately:** run `pnpm install --frozen-lockfile` after the workspace entry is present; if registration changes the lockfile, use the repository-approved pnpm lockfile update command first and inspect only expected workspace metadata. Then run `pnpm --filter ./packages/browser-runtime typecheck`.

3. Define public runtime types in `src/types.ts`: `BrowserSession`, `BrowserSessionEvent`, `TileTransport`, `TileResponse`, `TileSurface`, `ExportCapability`, `BrowserLimits`, and explicit error codes. Model transport outcomes as `readable`, `ordinary-image-allowed`, `http-error`, `network-error`, `cancelled`, and `policy-denied`. Every surface reports `originClean`; never represent an ordinary image load as readable bytes.

   **Validate immediately:** add compile-time exhaustive-switch tests and run `pnpm --filter ./packages/browser-runtime test -- --run types`. Verify that an object containing both `ordinaryImage: true` and `bytes` does not type-check and that `originClean: false` removes all programmatic export/read/process capabilities.

4. Implement `src/transport.ts` with a direct readable transport. Use `fetch`
   with an `AbortSignal`, explicit redirect handling consistent with the
   protocol, and `credentials: "omit"` for the website context. Reject explicit
   `Cookie`, `Authorization`, and browser-credential inputs at the website
   boundary. Return final URL, status, safe response metadata, and an
   `ArrayBuffer` only when JavaScript can read the body. Do not infer CORS failure
   from status because a rejected fetch has no readable status.

   **Validate immediately:** use the deterministic scenario server and run direct tests for same-origin success, cross-origin CORS success, cross-origin CORS rejection, redirect, 404, abort, and timeout. Run `pnpm --filter ./packages/browser-runtime test -- --run transport`.

5. Implement `src/image-display-surface.ts`. Create one `<img>` per visible tile without setting `crossOrigin`; apply exact integer geometry; treat `load` as display success and `error` as failure; remove event handlers and elements on cancellation. Support both a DOM tile surface and drawing loaded images into a supplied display canvas. Once an ordinary cross-origin image is drawn, set `originClean = false` before any caller can request another operation. Keep the visible surface available and expose only non-programmatic browser/user-agent save guidance, such as right-clicking the displayed image or canvas where supported.

   **Validate immediately:** assert generated `<img>` elements have no `crossorigin` attribute, cross-origin fixtures assemble visibly in both display modes, `originClean` becomes false before any tainted-canvas operation can be offered, failed fixtures report failure, save guidance is displayed, and disposal leaves zero tile nodes/listeners. In a controlled test only, call `getImageData` on the tainted display canvas and require `SecurityError`; separately instrument product code and require zero calls to `getImageData`, processing, hashing, `toBlob`, or `toDataURL`. Run `pnpm --filter ./packages/browser-runtime test -- --run display`.

6. Implement `src/readable-canvas-surface.ts`. Decode fetched bytes using `createImageBitmap` with a tested `<img src=blob:...>` fallback; revoke every object URL; draw tiles in deterministic row-major coordinates; close every `ImageBitmap`; and never accept a URL in place of bytes. This path handles readable metadata, processed tiles, and clean export. Maintain an `originClean` invariant initialized to true and make every pixel read, processing operation, hash, and export fail closed if the invariant cannot be proven.

   **Validate immediately:** run tests with distinct-color tiles and compare decoded output pixels, dimensions, and MIME classification in Chromium, Firefox, and WebKit. Assert resource cleanup after success, decode error, abort, and replacement. Do not require browser encoder bytes to hash identically across engines. Run `pnpm --filter ./packages/browser-runtime test -- --run readable`.

7. Implement `src/limits.ts`. Probe maximum canvas width, height, area, and allocation with bounded test canvases; cache only within the page lifetime; combine probe results with estimated decoded-byte and output-byte budgets. Return `native-required` before downloading tiles when dimensions are definitely impossible, and `browser-risk` when only memory is uncertain.

   **Validate immediately:** inject deterministic low limits in tests. Verify exact boundary values, multiplication overflow protection, zero dimensions, a normal fixture, and a multi-gigapixel fixture. Run `pnpm --filter ./packages/browser-runtime test -- --run limits`.

8. Implement `src/export.ts`. Permit programmatic export only from an origin-clean readable-byte surface; use `canvas.toBlob` or the repository-owned deterministic encoder; include decoded output dimensions, actual MIME type, and a suggested safe filename; reject null blobs and unsupported formats with protocol error codes. For an `originClean = false` display surface return `EXPORT_REQUIRES_READABLE_BYTES` before invoking any browser export API, while preserving browser/user-agent save guidance.

   **Validate immediately:** export the deterministic 2x2 readable scenario and compare decoded output pixels, dimensions, and MIME in all three engines. Compare exact encoded SHA-256 only when using the deterministic repository-owned encoder. For the tainted display scenario, assert the capability/UI never calls the JavaScript export entry point and instrumentation records no pixel read, processing, hash, `toBlob`, or `toDataURL`; the controlled readback test, not product code, owns the expected `SecurityError`. Run `pnpm --filter ./packages/browser-runtime test -- --run export`.

9. Implement `src/worker.ts`, `worker-client.ts`, `buffers.ts`, and `session.ts` as the only coordinator boundary. The browser runtime, not Studio or an application adapter, owns worker creation/lifecycle, each Wasm session, image decode dispatch, and surface coordination. The main-thread client executes browser-only effects, transfers readable `ArrayBuffer` ownership rather than cloning/base64 encoding, applies byte-count backpressure, and returns correlated results. Choose a surface only after the caller approves the mode, preserve deterministic commit order, and emit monotonic sequence-numbered events. Make cancellation/disposal idempotent, terminate failed/replaced workers, release every Wasm/JS buffer handle, and ensure late responses cannot mutate a cancelled or replaced session.

   **Validate immediately:** run unit tests for discovery follow-ups, transferable-buffer detachment, byte backpressure, duplicate/stale responses, retryable tile errors, cancellation during discovery/transfer/decoding, worker crash, session replacement, progress monotonicity, completion exactly once, and zero outstanding Wasm/JS buffers after disposal. Run `pnpm --filter ./packages/browser-runtime test -- --run session`.

10. Add a fallback-policy API. Only after classifying a direct readable attempt
    as a CORS/network failure, return structured allowed next transports supplied
    by the embedding product. The runtime must not know website proxy URLs,
    extension IDs, native protocol URLs, product installation state, or proxy
    eligibility policy. It may identify ordinary image display, restricted proxy,
    extension, or native only through protocol capability identifiers and must
    emit the active transport on every attempt. The phase-09 website adapter may
    automatically select restricted proxy when its public non-credential target
    policy allows it and proxy fallback is not opted out; automatic fallback
    requires no additional product/user decision.

    **Validate immediately:** test that direct is always attempted before any
    fallback and that the same classified CORS/network failure yields only the
    options passed by the host. Assert no proxy capability appears before that
    classification, active-transport events are ordered, and credentials,
    cookies, authorization headers, and source response bodies never appear in
    fallback diagnostics.

11. Add browser-runtime scenarios under `testdata/scenarios/browser-runtime/`: `same-origin-readable`, `cors-readable`, `cors-denied-display`, `cors-denied-no-display`, `redirect-readable`, `slow-cancel`, `missing-tile`, `decode-error`, `cache-non-secret`, `protocol-current`, `protocol-n-1`, and `too-large`. Co-locate route payloads and expected transcripts/results in each scenario. Give every case fixed dimensions, tile colors, response IDs, headers, request counts, logical delays, cache classification, and expected event transcript. Current and N-1 must produce equivalent supported behavior; N-2/future incompatibility must fail before browser effects.

    **Validate immediately:** run `cargo xtask fixtures verify` and `cargo xtask parity validate`. Extend the phase-03 case/transcript schemas only when a browser field cannot be represented; do not add a competing scenario format.

12. Implement `src/cache.ts`, then create `tests/harness/browser-runtime/` as a test-only Vite application. The optional cache has explicit byte/entry quotas, LRU or another deterministic eviction policy, clear controls, and a classifier that rejects credentials, authorization-dependent/private responses, signed URLs, handoff data, and unknown sensitivity. Cache keys exclude secrets and entries never outlive configured browser storage scope. Expose harness controls for scenario, mode, concurrency, cache, cancel, and export. The harness may import `packages/browser-runtime` but not shared React UI.

   **Validate immediately:** run cache quota/eviction/clear/rejection tests, then `pnpm --filter ./tests/harness/browser-runtime build` and serve the built app with `crates/fixture-server`. Confirm there are no network requests except selected scenario resources and no secret canary appears in Cache Storage, IndexedDB, local storage, or persisted test profiles.

13. Add Playwright tests in Chromium, Firefox, and WebKit for both paths. For ordinary image mode, assert visible assembled layout, no `crossorigin`, no response-body reads, `originClean = false` after display-canvas draw, displayed save guidance, a controlled readback `SecurityError`, and zero product attempts to read/process/hash/`toBlob`/`toDataURL`/clean-export. For readable mode, assert direct CORS fetch, origin-clean readback, decoded pixels/dimensions/MIME, cancellation, and cleanup. Require exact encoded hashes only for the repository-owned deterministic encoder. Mark no browser-specific expected failures without a linked issue and expiry date.

    **Validate immediately:** run `pnpm --filter ./tests/harness/browser-runtime test:e2e -- --project=chromium`, then Firefox, then WebKit. Preserve traces only on failure. All three must pass locally or the phase stops.

14. Add the `cargo xtask build wasm --browser-runtime` mode in `crates/xtask/src/browser.rs`. It must run the phase-07 Wasm build, verify generated bindings are clean, and run the browser-runtime TypeScript build without executing browser tests. Use argument arrays rather than shell interpolation.

    **Validate immediately:** run `cargo xtask build wasm --browser-runtime` twice. The second run must leave `git status --short` unchanged and must not rewrite generated files nondeterministically. This mode becomes available only after this step.

15. Add bundle and dependency boundary checks. Fail if Node built-ins, filesystem APIs, native runtime crates, Tauri APIs, extension APIs, or product UI packages enter the browser-runtime graph. Set an explicit compressed bundle budget based on the phase-07 baseline plus the reviewed runtime allowance.

    **Validate immediately:** run `pnpm --filter ./packages/browser-runtime lint`, the repository dependency-boundary test, and `cargo xtask build wasm --browser-runtime`. Inspect the emitted dependency report in `artifacts/phase-08/`.

16. Add security regression tests. Feed hostile filenames, SVG tiles, malformed image bytes, oversized dimensions, redirect loops, credential-bearing URLs, HTML error pages, and secret-bearing responses offered to cache. Ensure no HTML is injected, no URL credentials are logged or cached, object URLs are revoked, tainted surfaces cannot reach programmatic pixel/export APIs, and errors are bounded in size.

    **Validate immediately:** run `pnpm --filter ./packages/browser-runtime test -- --run security` and inspect captured browser console output for secrets and uncaught errors.

17. Complete `cargo xtask test browser` so it starts the deterministic server on allocated loopback ports, builds Wasm and the harness, runs all three Playwright projects, stops child processes on success or failure, and writes machine-readable results to `artifacts/phase-08/results.json`.

    **Validate immediately:** run `cargo xtask test browser` twice, once normally and once with `DEZOOMIFY_TEST_CONCURRENCY=1`. Verify no server process or temporary profile remains. The complete browser test target becomes available only after this step.

18. Run the final phase gate: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, the root pnpm lint/typecheck commands, `cargo xtask protocol check`, `cargo xtask test`, `cargo xtask build wasm --browser-runtime`, and `cargo xtask test browser`.

    **Validate immediately:** `git status --short` may contain only the intended phase files, root manifest/lock updates, and reviewed artifacts. Generated output must be clean after rerunning `cargo xtask protocol generate` and `cargo xtask protocol check`.

19. Append the phase-08 row in `docs/migration/gates.md` with exact commands, results, artifacts, exceptions, and reviewer identity. Do not alter another phase row.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/08-browser-runtime.md` and confirm every blocking result references deterministic evidence rather than a live URL.

## Deterministic User Workflows

### Ordinary Cross-Origin Image Display

1. Run `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` in terminal A and use the `cors-denied-display` scenario under `testdata/scenarios/browser-runtime/cors-denied-display/`.
2. Run `pnpm --filter ./tests/harness/browser-runtime dev -- --host 127.0.0.1` in terminal B.
3. Open the printed harness URL in Chromium.
4. Select `cors-denied-display`, choose `Ordinary image display`, and start.
5. Verify the colored tile grid is visible and geometrically complete.
6. Inspect one tile and verify it is an `<img>` with no `crossorigin` attribute.
7. Verify programmatic export is disabled with `Readable tile bytes are required` and browser/user-agent save guidance is visible where supported.
8. Cancel and verify the tile container and pending-request counters return to zero.
9. Repeat in Firefox and WebKit using the Playwright projects rather than manual browser substitutions.

### Readable Direct Export

1. Select `cors-readable` and `Readable bytes`.
2. Start the session and verify progress advances monotonically to the fixture's exact tile count.
3. Export PNG.
4. Decode `artifacts/phase-08/manual/cors-readable.png` and compare pixels, dimensions, and MIME with the scenario expectations.
5. If this run selected the repository-owned deterministic encoder, compare its exact SHA-256; otherwise do not assert browser encoder byte identity.
6. Verify the fixture-server request log contains no cookies and exactly the expected metadata and tile requests.

### Taint Guard

1. Select `cors-denied-display` and render to the display canvas.
2. Verify the assembled image remains visible and `originClean` is false.
3. In the isolated unsafe-control hook, read one pixel and verify `SecurityError`.
4. Verify product export is unavailable and the capability reason is `EXPORT_REQUIRES_READABLE_BYTES`; do not invoke the JavaScript export entry point.
5. Verify instrumentation reports no product export call, pixel read, process, hash, `toBlob`, or `toDataURL` attempt and that save guidance remains visible.

### Large Image Escalation

1. Select `too-large` with injected limits from the scenario.
2. Start the session.
3. Verify no tile request occurs.
4. Verify the result contains dimensions, estimated resource use, and `native-required`, without including any credentials.

## Stop Conditions

- Stop if the core requires browser networking or DOM APIs; repair the boundary in the owning earlier phase first.
- Stop if ordinary image display cannot remain visible after taint, or if product
  code attempts a pixel read, processing, hash, `toBlob`, `toDataURL`, or clean
  export while `originClean` is false.
- Stop if direct CORS behavior differs across browsers in a way that cannot be represented by the typed transport outcomes.
- Stop if a fallback transport can start before the direct attempt has produced
  a classified CORS/network failure or if the active transport is not observable.
- Stop if any test needs public internet access, a real museum, timing sleeps without deterministic server coordination, or fixed globally shared ports.
- Stop if generated protocol/capability output changes without a reviewed schema change.
- Stop if a browser crash or memory exhaustion occurs in the large-image preflight; lower the bounded probe and validate detection without allocating the advertised image.
- Stop if credentials appear in logs, errors, snapshots, traces, or artifacts.

## Risks And Mitigations

- **Canvas taint is misclassified:** track `originClean` explicitly, prove taint
  with a controlled `SecurityError`, and instrument product code to forbid only
  programmatic pixel/export operations while retaining visible assembly and save
  guidance.
- **Object URL/ImageBitmap leaks:** centralize cleanup and test resource counters on every terminal path.
- **Browser-specific image decode behavior:** use fixed PNG/JPEG fixtures, test three engines, and expose decode errors without retry loops.
- **Wasm/TypeScript protocol drift:** generate types with `cargo xtask protocol generate`, reject unknown major versions, and gate on `cargo xtask protocol check`.
- **Unbounded browser memory:** preflight limits, cap concurrency, close decoded resources, and escalate large images to native.
- **Nondeterministic browser encoding:** compare decoded pixels, dimensions, and
  MIME across engines; reserve exact encoded hashes for the deterministic
  repository-owned encoder.
- **CORS failure misdiagnosis:** distinguish fetch rejection from HTTP status and never claim that a proxy will necessarily work.
- **Hidden transport fallback:** emit typed active-transport events and require
  direct-before-fallback transcript assertions; phase 09 owns proxy eligibility
  and opt-out.

## Safe Rollback

1. Capture `git diff -- plans/08-browser-runtime.md packages/browser-runtime tests/harness/browser-runtime crates/xtask/src/browser.rs crates/xtask/src/main.rs testdata/scenarios/browser-runtime docs/browser-runtime.md` and identify only phase-08 hunks.
2. Remove newly added phase-08 files with an explicit patch or `git rm` only after verifying they are unmodified by another worker.
3. Revert only phase-08 registration lines in root manifests and lockfiles using a targeted patch; do not restore whole files from `HEAD`.
4. Regenerate protocol files only if this phase changed their schema intentionally; otherwise leave generated artifacts untouched.
5. Run the pre-phase commands again and compare against `artifacts/phase-08/preflight.md`.
6. Never use `git reset --hard`, `git checkout -- .`, broad clean commands, or deletion of untracked paths.

## Artifacts

- `artifacts/phase-08/preflight.md`
- `artifacts/phase-08/results.json`
- `artifacts/phase-08/bundle-report.json`
- `artifacts/phase-08/request-logs/*.json`
- `artifacts/phase-08/manual/cors-readable.png`
- Failure-only Playwright traces and screenshots
- Reviewed generated Wasm bindings and capability report

Artifacts containing local absolute paths, browser profiles, response bodies, or credentials must remain ignored and must not be committed.

## Completion Checklist

- [ ] Ordinary cross-origin `<img>` tiles assemble visibly without `crossorigin`; a display canvas may taint and records `originClean = false`.
- [ ] Controlled readback proves `SecurityError`, product code makes no programmatic read/process/hash/export attempt, and save guidance is displayed.
- [ ] Readable tile bytes produce an origin-clean export with expected decoded
  pixels, dimensions, and MIME; exact bytes are required only from the
  repository-owned deterministic encoder.
- [ ] Direct same-origin and CORS-readable fetches work in Chromium, Firefox, and WebKit.
- [ ] CORS/network-denied direct fetch is typed correctly; fallback capabilities
  cannot run before classification and every active transport is visible.
- [ ] Optional browser cache is bounded, clearable, and stores only classified non-secret data.
- [ ] Protocol current and N-1 scenarios pass; incompatible versions fail before browser effects.
- [ ] Cancellation and session replacement release all resources.
- [ ] Large images fail preflight and recommend native before tile download.
- [ ] No cookies, credentials, proxy URL, extension API, Tauri API, or Node API entered the runtime.
- [ ] Generated files are deterministic and clean.
- [ ] `cargo xtask build wasm --browser-runtime` passes twice without diff.
- [ ] `cargo xtask test browser` passes in all three browser engines.
- [ ] Final Rust and TypeScript workspace gates pass.
- [ ] The phase-08 migration gate row contains exact deterministic evidence.
- [ ] Only phase-08 paths and necessary workspace registration changes are present.
