# Plan: Real webapp + CLI completion (post-migration)

Status: active (accepted by owner 2026-09-05).

The migration phases 00–15 (see `docs/migration/gates.md`) completed their
declared scope, but that scope stopped at honest scaffolds for the two primary
user-facing programs. The end state of this plan is: **every test for the web
app and the CLI passes while exercising real code, and both apps genuinely
discover, download, assemble, and save zoomable images** — no stubs asserted as
green, no emulated transport claimed as egress, no hardcoded site data standing
in for discovery.

## Current stub inventory (what this plan must close)

| Stub | Location | Legacy behavior it replaces |
|---|---|---|
| Native HTTP egress absent (`dezoomify-native` has no HTTP dependency; `client.rs` builds requests only) | `crates/dezoomify-native/src/client.rs`, `download.rs`, `runtime.rs` | `migration-sources/dezoomify-rs/src/network.rs` fetch loop |
| CLI exits "native download pipeline not yet implemented" | `apps/cli/src/main.rs:31-41` | full dezoomify-rs CLI flow |
| Webapp: discovery only; tile download and save are alerts | `apps/web/src/main.ts:152,191`, `main.js:180,219` | `migration-sources/dezoomify-web/zoommanager.js` |
| WASM adapter embeds a "temporary minimal job machine" instead of delegating to `dezoomify-job` (E01) | `crates/dezoomify-wasm/src/session.rs` | job engine delegation |
| Browser worker-client stub (no real Worker in tests) | `packages/browser-runtime/src/session.ts` | `dezoomify-web` worker assembly |
| No browser E2E for the new webapp (E02) | `apps/web/test/` (node unit only) | `migration-sources/dezoomify-web/tests/` Playwright suites |
| Live suite covers 3 sites with hardcoded meta/tile URLs; tests sites, not our code (E03) | `crates/xtask/src/live.rs` | `migration-sources/dezoomify-rs/tests/live_dezoomers.rs` (36), `dezoomify-web/tests/live-compat.spec.js` (35) |
| Desktop packaging deferred (E04) | `apps/desktop` | out of scope here; tracked by E04 |

## Constraints

- Keep `dezoomify-core` pure: all fetching stays in `dezoomify-native`,
  `packages/browser-runtime`, and the hosts.
- Live checks remain credential-free, https-bounded, sequential, and
  diagnostic; they never substitute for deterministic coverage. The CLI `-H`
  header path (trusted native memory) is the only cookie-bearing route, used
  only where a legacy target requires it (e.g. BLB VLS `js_enabled=2`).
- Do not edit `migration-sources/`; port behaviors, not code.
- A phase is complete only when its acceptance checks pass on real code and
  the gate table below is updated in the same change.

## Phases

### C1 — Native HTTP egress

Add a real HTTP client to `dezoomify-native` (rustls-based, no native-TLS
dependency creep), implementing the transport behind `client.rs` request
construction: redirects with per-URL header rebuild, size/time limits, and
byte streams consumed by the download loop in `download.rs`.

Acceptance:
- `cargo xtask test native` includes loopback integration tests through
  `crates/fixture-server` exercising redirects, limits, retries, and failures
  over real sockets (no emulated transport left in the native suite).
- `dezoomify-core` purity tests still pass; no HTTP dependency leaks into core.

### C2 — CLI download pipeline

Wire `NativeRuntime` end-to-end: discovery (core) → tile plan → concurrent
bounded download → decode/assemble → encode and write output. Replace the
honest-scaffold exit in `apps/cli/src/main.rs` with the real pipeline and real
progress events.

Acceptance:
- Fixture-server scenarios produce real output files whose bytes/pixels match
  expected results (extend `testdata/scenarios/native+cli`).
- `cargo xtask test native` and `cargo xtask test scenario` pass with the
  pipeline actually downloading from loopback.
- The CLI snapshot tests that currently assert the stub error exit are deleted
  or inverted.

### C3 — Live CLI port (dezoomify-rs targets)

Replace the hardcoded meta/tile harness in `crates/xtask/src/live.rs` with a
driver that runs the real built CLI binary (as `live_dezoomers.rs` ran
`CARGO_BIN_EXE_dezoomify-rs`) against the legacy input URLs — page URLs and
metadata URLs alike — asserting auto-selected discovery and a real output
image. Port every legacy target from `migration-sources/dezoomify-rs/tests/live_dezoomers.rs`;
probe each and record dead or changed sites in `docs/migration/live-inventory.csv`
(new rows for rs-only targets: custom_yaml, topviewer_media_api, fsi server
info, arcgis basemap URL, micr.io IIIF, zoomify express, etc.).

Acceptance:
- `cargo xtask test live --public` runs the actual CLI; every still-alive
  legacy target passes; dead/blocked targets are documented rows, not silent
  omissions.
- The `--dry-run --fixtures` mode still works without network.

### C4 — WASM job delegation

Replace the minimal session machine in `crates/dezoomify-wasm` with real
delegation to `dezoomify-job` (closes E01's engine gap), keeping transcripts
equivalent.

Acceptance: `cargo xtask test wasm --transcripts` passes with the job engine
driving; the "temporary minimal job machine" comment and fallback are removed.

### C5 — Webapp real pipeline

Wire the webapp (repository root since 2026-09-05) to the full flow: shared-UI controller → browser-runtime real
worker (replace the session.ts stub) → direct-first transport + eligible
metadata proxy fallback → ordinary image display assembly → readable-byte
processing → real save. Remove the preview-build alerts.

Acceptance:
- Playwright E2E (Chromium, reopening E02's browser gap) runs
  `crates/fixture-server` scenarios end-to-end in the real app and saves real
  bytes.
- `cargo xtask test web`/`browser` include the wired worker path, not just
  modules.
- Proxy security matrix (no tile proxy, no credentials) still passes over the
  wired path.

### C6 — Live webapp port (dezoomify-web targets)

Port `migration-sources/dezoomify-web/tests/live-compat.spec.js` targets as a
live E2E suite: open the real webapp, paste the legacy URL, assert
auto-selected format and first real tile load (bounded, diagnostic). Cross-
reference L01–L35 in `docs/migration/live-inventory.csv`; add rs-only gaps from
C3.

Acceptance: all still-alive legacy targets pass against the new webapp; dead
targets documented; nothing hardcoded per-site in the suite beyond the legacy
input URL list.

### C7 — Honesty sweep and gate closure

Sweep for remaining "preview build", "stub", "not wired" claims reachable by
tests; ensure `cargo xtask test all` green means real behavior. Update
`docs/migration/exceptions.md` (close E01, E03; narrow E02) and this file's
gate table.

Acceptance: `grep` for stub markers in apps/cli, the webapp (repository root), dezoomify-native,
dezoomify-wasm, browser-runtime returns no test-relevant stubs; `cargo xtask
test all` passes; `cargo xtask test live --public` passes on all alive sites.

## Gate table

| phase | commands | result | exceptions closed |
|---|---|---|---|
| C1 | `cargo xtask test native` | done 2026-09-05 | E03 (partial) |
| C2 | `cargo xtask test native`, `cargo xtask test scenario` | done 2026-09-05 | — |
| C3 | pending | not started | E03 (full) |
| C4 | `cargo xtask test wasm --transcripts` | done 2026-09-05 | E01 |
| C5 | pending | not started | E02 (web) |
| C6 | pending | not started | — |
| C7 | pending | not started | E01, E02, E03 closed |

## Rollback boundary

Each phase is independently revertable; the deterministic suite must stay
green after every phase. Live diagnostics may fail without blocking rollback.
