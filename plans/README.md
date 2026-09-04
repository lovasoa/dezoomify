# Dezoomify-NG Migration Plans

This directory is the execution index for migrating the legacy website, Rust
application, and browser extension into one repository. Execute phases in
numeric order. A later phase may begin only when every completion item and
stop-condition check in the preceding phase is resolved.

## Source Snapshots

Web and extension sources are immutable snapshots. The Rust source floats on
the latest stable dezoomify-rs release per the Rust baseline rule in
[`00-program-rules-and-gates.md`](00-program-rules-and-gates.md): resolve the
newest stable tag at implementation time, sync the prefix to it, and record
the tag and SHA.

| Source | Required snapshot | Role |
|---|---:|---|
| `migration-sources/dezoomify-web/` | `f7caa07e1ebd3e7d600075ca54a152cee30d8602` | Legacy browser behavior, deterministic browser fixtures, proxy, and UI reference |
| Git object `cb13f0b` | `cb13f0b` | Fixed upstream Rust reference against which migration deltas are reviewed |
| `migration-sources/dezoomify-rs/` | Resolved Rust tip (latest stable at implementation time) | Working Rust snapshot: core, native downloader, CLI, encoders, and fixtures |
| `migration-sources/dezoomify-extension/` | `d231dd0bef310a46604140baa50ef29702aef53e` | Legacy extension behavior and URL-recognition reference |

The source directories are read-only migration evidence between syncs. Do not
implement new behavior in them. Preserve them until phase 15 is complete. The
floating Rust snapshot is not a replacement definition of upstream
behavior: every change in `cb13f0b..<resolved-rust-tip>` must be classified and backed by
the parity inventory before it enters the new workspace.

## Current State

Phase 00-03 are complete and recorded in `docs/migration/gates.md`. Phase 04 is
the current pending phase; phases 05-15 are blocked until their preceding gate
records are complete. The root Cargo and JavaScript workspaces, `docs/migration/gates.md`,
and all `cargo xtask` commands remain unavailable until the phase that creates each one.

## Command Labels

Every plan separates two command classes:

| Label | Meaning |
|---|---|
| **Available now** | The command can be run against the checked-in `migration-sources` or ordinary tools before any new workspace code exists. |
| **Added in phase N** | This is an intended `cargo xtask` interface. It does not exist before the named phase creates and tests it. Do not use its absence as a migration failure in earlier phases. |

Never document an intended command as if it already works. When a phase adds an
`xtask` command, its own tests and help output are part of that phase's gate.

The canonical public grammar is reserved as follows. Reserving a spelling does
not make it available: phase 03 help lists only the phase-03 subset, and each
later target must be absent until its owner phase implements and tests it.

| First available | Canonical command surface |
|---:|---|
| 03 | `cargo xtask setup`; `cargo xtask check`; `cargo xtask sources verify`; `cargo xtask fixtures verify`; `cargo xtask fixtures serve`; `cargo xtask parity validate`; `cargo xtask parity report`; `cargo xtask test` |
| 04 | `cargo xtask test core`, with focused `--purity` and `--parity` flags |
| 05 | `cargo xtask protocol generate`; `cargo xtask protocol check`; `cargo xtask test protocol` |
| 06 | `cargo xtask test job`, with a focused `--transcripts` flag |
| 07 | `cargo xtask build wasm`; `cargo xtask test wasm`, with focused `--transcripts` and `--browser <name>` flags |
| 08 | `cargo xtask test browser`, with focused `--build-only`, `--browser <name>`, and `--scenario <id>` flags |
| 09 | `cargo xtask test ui`; `cargo xtask test web`; `cargo xtask build web`; `cargo xtask dev ui`; `cargo xtask dev web` |
| 10 | `cargo xtask test native`; `cargo xtask test scenario`; `cargo xtask build cli` |
| 11 | `cargo xtask test desktop`; `cargo xtask build desktop`; `cargo xtask dev desktop` |
| 12 | `cargo xtask test extension`; `cargo xtask test native-messaging`; `cargo xtask build extension`; `cargo xtask dev extension` |
| 13 | `cargo xtask test all`; `cargo xtask test live`; `cargo xtask ci <lane>`; `cargo xtask release plan`; `cargo xtask release build`; `cargo xtask release verify --plan <path> --artifacts <path>` |

Use focused flags such as `--check`, `--app`, `--purity`, `--parity`,
`--transcripts`, `--scenario`, `--host`, and `--browser` only where the owning
plan requires them. Do not create hyphenated aliases or component-specific
top-level commands.

## Phase Index

| Phase | Plan | Primary gate |
|---:|---|---|
| 00 | [`00-program-rules-and-gates.md`](00-program-rules-and-gates.md) | Governance, source immutability, validation policy, and stop rules are explicit. |
| 01 | [`01-baseline-and-history-imports.md`](01-baseline-and-history-imports.md) | All three histories and the fixed-baseline/floating-tip Rust relationship are proven; the working tip is resolved and recorded. |
| 02 | [`02-legacy-audit-and-parity-inventory.md`](02-legacy-audit-and-parity-inventory.md) | Every retained, changed, and retired legacy behavior has a matrix row and evidence. |
| 03 | [`03-shared-fixtures-and-test-harness.md`](03-shared-fixtures-and-test-harness.md) | One deterministic fixture corpus and runner can test legacy and new apps without the public network. |
| 04 | [`04-core-parity-and-stabilization.md`](04-core-parity-and-stabilization.md) | The pure Rust discovery core passes the parity corpus and purity checks. |
| 05 | [`05-protocol-contract.md`](05-protocol-contract.md) | A versioned, canonical host/core protocol has compatibility and golden-vector tests. |
| 06 | [`06-job-engine.md`](06-job-engine.md) | A host-independent job state machine passes deterministic workflow transcripts. |
| 07 | [`07-wasm-adapter.md`](07-wasm-adapter.md) | WASM exposes the protocol without owning browser I/O and matches native transcripts. |
| 08 | [`08-browser-runtime.md`](08-browser-runtime.md) | Browser fetch, decode, assembly, cancellation, and save behavior passes offline workflows. |
| 09 | [`09-shared-ui-and-website.md`](09-shared-ui-and-website.md) | The shared UI and website preserve legacy user workflows and accessibility. |
| 10 | [`10-native-runtime-and-cli.md`](10-native-runtime-and-cli.md) | Native I/O, encoders, cache, bulk mode, and CLI compatibility pass parity tests. |
| 11 | [`11-desktop-app.md`](11-desktop-app.md) | Desktop shell uses the shared UI/protocol and passes packaged offline workflows. |
| 12 | [`12-browser-extension-and-handoffs.md`](12-browser-extension-and-handoffs.md) | Extension recognition, permissions, state, and handoffs work with website and desktop targets. |
| 13 | [`13-ci-security-and-release.md`](13-ci-security-and-release.md) | CI, dependency policy, artifact signing, provenance, and staged releases are reproducible. |
| 14 | [`14-cutover-and-legacy-removal.md`](14-cutover-and-legacy-removal.md) | Traffic and distribution cut over only after all parity gates pass; approved legacy code is then removed. |
| 15 | [`15-post-cutover-validation.md`](15-post-cutover-validation.md) | Production telemetry, rollback drills, compatibility checks, and source-archive retention are verified. |

## Global Sequencing Rules

1. Treat phases 00-03 as evidence-building work. Do not redesign behavior while creating the baseline, inventory, or fixture harness.
2. Phase 03 creates the root Cargo workspace, `crates/xtask`, `crates/fixture-server`, and the canonical `testdata/scenarios` corpus. No earlier phase may present their commands as available.
3. Stabilize `crates/dezoomify-core` in phase 04 before defining cross-runtime DTOs around it in phase 05.
4. Freeze protocol version 1 before implementing `crates/dezoomify-job`. Protocol changes after phase 05 require regenerated Rust/TypeScript artifacts, golden updates, and an explicit compatibility decision.
5. Keep the job state machine host-independent. Browser, native, desktop, and extension hosts perform fetch, decode, write, encode, publication, storage, and UI effects in phases 08, 10, 11, and 12.
6. Build the WASM adapter before the browser runtime so browser code consumes tested core/job and pure-processing exports rather than reaching into Rust internals. WASM owns no worker, fetch, storage, canvas, or UI behavior.
7. Preserve `dezoomify-core` and `dezoomify-job` purity throughout: no HTTP client, async runtime, filesystem, image decoder, UI, clock, randomness, or environment access in their normal dependency graphs.
8. Store canonical route definitions, payload bytes, expected transcripts, and expected pixels only under `testdata/scenarios`; harness implementation may live in its owning crate or package.
9. Do not remove legacy code, fixtures, routes, release jobs, or compatibility behavior before the corresponding parity row is green on its replacement and phase 14 explicitly approves removal.
10. Deterministic tests are release-blocking. Live-network checks are diagnostic and cannot be the only evidence for a behavior.
11. A dirty worktree is not permission to discard work. Record pre-existing changes, touch only phase-owned paths, and use path-scoped restoration from a known checkpoint only for changes made by the current phase.
12. Stop rather than guess when source SHAs, licensing, fixture provenance, expected behavior, or protocol compatibility cannot be proven.
13. The website always attempts a direct browser fetch first.
    Only a classified CORS/network failure may automatically fall back to the
    metadata CORS proxy, and only for an eligible public non-credential metadata
    request (never tiles) while the user's proxy opt-out is disabled. Direct and
    proxy fetches omit
    browser credentials; proxy requests and upstream requests never carry
    cookies, `Authorization`, or user-supplied credential headers. The UI always
    identifies the active transport. Proxy fallback has an opt-out rather than
    an approval transition; extension-to-native cookie handoff remains
    separately and explicitly consent-gated. The extension itself never uses
    the metadata CORS proxy.

## Cross-Phase Artifacts

The creating phase owns the initial artifact and its validation. Consuming
phases may extend an artifact only where their plan says so; they must preserve
its canonical path and compatibility rules.

| Artifact | Canonical path | Created | Consumed or extended |
|---|---|---:|---|
| Source and gate evidence | `docs/migration/source-lock.json`, `docs/migration/gates.md`, `docs/migration/exceptions.md` | 00 | 01-15 |
| Architecture and test boundaries | `docs/architecture.md`, `docs/testing.md` | Existing; normalized in 00 | 03-15 |
| Import history evidence | `docs/migration/history-imports.md` | 01 | 02-15 |
| Parity inventory and decisions | `docs/migration/parity-matrix.csv`, `docs/migration/*-inventory.csv`, `docs/migration/parity-decisions.md` | 02 | 03-15 |
| Cargo workspace and phase-gated command parser/task runner | Root `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `crates/xtask` | 03 | 04-15 |
| Hermetic route server | `crates/fixture-server` | 03 | 03-15 |
| Canonical scenario corpus | `testdata/scenarios` | 03 | 03-15 |
| Pure discovery core | `crates/dezoomify-core` | 04 | 05-15 |
| Canonical Rust protocol DTOs | `crates/dezoomify-protocol/src/dto.rs` | 05 | 05-15 |
| Generated TypeScript protocol package, schemas, and capabilities | `packages/protocol-ts` | 05 | 05-15 |
| JavaScript workspace | Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | 05 | 05-15 |
| Pure lifecycle state machine | `crates/dezoomify-job` | 06 | 07-15 |
| WASM core/job and pure-processing adapter | `crates/dezoomify-wasm` | 07 | 08-09, 11-12 |
| Browser effect runner and rendering surfaces | `packages/browser-runtime` | 08 | 09, 11-12 |
| Shared UI and website | `packages/shared-ui`, `apps/web` | 09 | 11-15 |
| Native runtime and CLI | `crates/dezoomify-native`, `apps/cli` | 10 | 11-15 |
| Tauri desktop application and native bridge | `apps/desktop` | 11 | 12-15 |
| Browser extension and handoff implementation | `apps/extension` | 12 | 13-15 |
| CI and release inventory | `.github/workflows`, `release/` | 13 | 14-15 |
| Cutover records and deletion evidence | `release/cutover.toml`, `docs/cutover-runbook.md`, `docs/rollback-runbook.md`, `docs/migration.md`, `artifacts/phase-14/deletion-inventory.json` | 14 | 15 |
| Post-cutover reports and retained archives | `artifacts/phase-15/final-report.md`, `artifacts/phase-15/cleanup-inventory.json`, retained signed artifacts and source archives | 15 | Long-term maintenance |

## Cross-Phase Gate Record

Each phase updates `docs/migration/gates.md` with:

| Field | Required value |
|---|---|
| `phase` | Two-digit phase number |
| `source_shas` | Exact source SHAs used by the phase |
| `commands` | Exact deterministic commands run |
| `result` | Pass, fail, or explicitly approved exception |
| `artifacts` | Paths to reports, transcripts, or snapshots |
| `exceptions` | Owner, rationale, expiry phase, and replacement test |
| `reviewer` | Human approval identity when a stop condition required a decision |

A phase is incomplete if its implementation passes but its gate record is
missing or refers only to live-network results.

## Final Invariants

- One pure discovery core defines site-format interpretation; one canonical Rust
  DTO source defines the generated protocol contract.
- One versioned protocol connects core/job logic to all runtimes, with generated
  TypeScript declarations and schemas rather than hand-maintained duplicates.
- One shared deterministic corpus drives Rust, WASM, browser, native, desktop,
  and extension workflow tests where applicable.
- User-supplied headers override format-generated request headers.
- User-facing guidance and error messages lead with specific, plain-language
  facts and a next action; technical detail is progressively disclosed; and
  structured failure context is gathered at error time so support reports are
  specific.
- Automatic detection precedence, request deduplication, discovery limits,
  adaptive probing, cancellation, retries, and output correctness are tested.
- Website transport order is direct browser fetch, then automatic
  metadata CORS proxy fallback only after classified CORS/network failure for an
  eligible public non-credential metadata request (never tiles) unless the user
  opted out. Active
  transport is visible, both transports omit browser credentials, and the proxy
  receives or forwards no cookie, `Authorization`, or credential header.
- Extension fetch is browser-session fetch and never uses the metadata CORS proxy; only cookie
  handoff from extension to native requires separate explicit consent.
- Legacy deletion occurs only after replacement parity, release rollback, and
  archive retention are proven.
