# Implement the honest stubs (except the release pipeline)

Owner instruction (2026-09-05): implement every documented honest stub so no
"stub-ok" remains, except the release pipeline (`xtask release *`,
`release-publish.yml`, `release-sign.yml`), which another agent owns.

## Context

The repository uses explicit, documented stubs instead of TODO markers. Each
stub below is currently guarded by docs (`docs/development.md`, `README.md`),
gate ledgers, and unit tests that assert the stub behavior. Implementing a
stub must update those docs, gates, and tests in the same phase.

## Phases

### Phase 1 - Small correctness gaps

1. `crates/dezoomify-core/src/iiif/manifest_types.rs`: support IIIF
   `AnnotationBody` presented as an array (take the first painting image;
   keep the `EmptyOrUnsupported` catch-all).
2. `legacy/dezoomers/wmts.js`: implement WMTS metadata file URL extraction
   from capabilities documents that reference a separate metadata file.
3. `crates/dezoomify-protocol`/`dezoomify-job`: implement the core→DTO
   catalog projection and the wire projection tests that currently state
   "projection itself is not implemented yet" (tests/projection.rs). The
   projection lives where boundaries allow (job, which already depends on
   core + protocol); protocol DTOs stay core-free.

### Phase 2 - xtask real behavior

1. `build extension`: package real ZIPs for chromium and firefox by reusing
   `apps/extension/scripts/package-store.sh` (or equivalent Rust staging),
   writing under `target/extension/`; verify referenced files exist.
2. `test native-messaging`: real registration inspection on Linux/macOS
   (profile `NativeMessagingHosts` dirs) and Windows registry via `reg query`
   when available; `--cleanup-only` removes dezoomify registrations found;
   `--browser <name>` launches a real headless-browser handshake where the
   browser is installed (chromium), failing closed otherwise.
3. `test browser` / `test wasm --browser`: run the browser-runtime and wasm
   harness suites inside real headless Chromium via the installed Playwright
   browsers (new harness page under `packages/wasm-harness` +
   `crates/fixture-server/tests`), reusing the existing E2E npm setup.
4. `dev <target>`: start real dev servers - `web` (static server over a
   rebuild + fixture server), `ui`, `extension` (serve unpacked sources),
   `desktop` (runs the built shell binary in dev mode).

### Phase 3 - Desktop

1. Updater: real signature verification. Add a pure-Rust crypto dependency
   (ed25519) to `apps/desktop/src-tauri` for the validator; keep the
   allowlist/anti-rollback/staleness policy; update the placeholder tests.
2. Tauri window shell: vendor the Tauri SDK (network is available), join or
   keep standalone per what the SDK requires, wire `generate_context!`, the
   single local window, strict navigation policy, and the five commands in
   `commands.rs` to real IPC. Update `main.rs` (no longer a stub).
3. Native save dialog: `requestSaveDestination` in
   `apps/desktop/src/desktopIntegration.ts` routes through a real Tauri
   dialog command; the native runtime writes to the chosen path and reports
   completion after atomic finalization.
4. `build desktop`/`--unsigned-test`: produce a real bundle on the current
   OS (Linux: deb/appimage as available); keep deterministic validation too.
   Update `docs/development.md` build table and `README.md`.

### Phase 4 - Job engine format-aware planning

Replace the lean scope in `crates/dezoomify-job`: feed `ResourceBytes`
through `dezoomify-core` discovery, produce real catalogs/levels/tile plans
(fixed `img:0`/`lvl:0` selection becomes a deterministic selection rule over
real results). Update the module doc, `docs/job-engine.md` lean behavior
table, and all lean-scope tests.

## Non-goals

- The release pipeline (other agent owns `release plan/build/verify` and the
  sign/publish workflows).
- Store submission state (external review; standing authorization covers
  resubmission but no code stub exists).
- Firefox/WebKit headless coverage (browsers not installed in this
  environment; chromium keeps failing closed for other names).

## Verification per phase

`cargo xtask check` + `cargo xtask test` after each phase; focused lane per
change (`test core|job|wasm|browser|ui|web|native|desktop|extension`); finish
with `cargo xtask test all` and `cargo xtask ci local`. Docs updated in the
same change (`docs/development.md`, `docs/job-engine.md`, `README.md`,
AGENTS.md commands if the grammar changes).
