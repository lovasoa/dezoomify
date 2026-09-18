# dezoomify documentation

dezoomify discovers zoomable images, lets a user choose an image and level, downloads tiles, processes them, and saves the result. The same job model and shared UI run on the website, desktop app, and extension; the CLI uses the same core and native runtime without the UI.

## Guides

- [User documentation](user/README.md): plain-language guide published to `/help/`; the single source of truth for user-facing copy.
- [Product](product.md): users, workflows, and product boundaries.
- [Architecture](architecture.md): monorepo components and dependency rules.
- [Job engine](job-engine.md): deterministic job state, effects, and policies.
- [Browser runtime](browser-runtime.md): browser fetching, processing, and saving.
- [Extension](extension.md): page discovery and browser-session fetching, including the source-binding and job-tab contract appendix.
- [Native apps](native-apps.md): CLI and Tauri desktop capabilities.
- [Protocol](protocol.md): generated commands, events, handoff, and compatibility.
- [Errors](errors.md): typed failures and recovery actions.
- [Testing](testing.md): shared scenarios and runtime-specific coverage.
- [Security](security.md): trust boundaries, credentials, and proxy controls.
- [Development](development.md): workspace conventions and validation.
- [Contributing a format](CONTRIBUTING-format.md): capture, parser, scenario, and pull request checklist for a new site format.
- [Compatibility](compatibility.md): browsers, canvas limits, and support reports.
- [Releases](releases.md): coordinated versions and compatibility checks.
- [Operations](operations.md): release and rollback runbooks, including incident response.

## Words used across these pages

- **job**: one user request, from pasted address to saved file.
- **host**: whatever runs a job's side effects (browser tab, desktop shell, CLI process).
- **runtime**: the effect layer inside an app (browser or native code doing fetch, decode, save).
- **transport**: how bytes reach the app (direct fetch, proxy, browser session).
- **handoff**: moving a job to another app through a `dezoomify://` link or Native Messaging.
- **scenario**: a deterministic test unit under `testdata/scenarios`.

The full vocabulary rules live in the root `AGENTS.md`.

## Canonical homes

Each fact lives once; every other page links to it:

| Fact | Canonical home |
|---|---|
| Transport policy (direct browser fetch first, automatic metadata proxy fallback) | [Browser runtime](browser-runtime.md#request-order) |
| Metadata window constant (`METADATA_WINDOW_MS`) | `crates/dezoomify-protocol/src/dto.rs` and its generated TypeScript projection |
| Native output formats and encoder behavior | [Native apps](native-apps.md#native-runtime) |
| Capability baselines | `crates/dezoomify-protocol/src/dto.rs` and manifests under `generated/` |
| Canvas and save limits | [Compatibility](compatibility.md#canvas-and-save-limits) |
| User-facing copy | [User documentation](user/README.md) |
| Task grammar (`xtask`) | [`crates/xtask/README.md`](../crates/xtask/README.md) |
| Size budgets (wasm 5 MB warn / 6 MB fail, extension ZIPs 3 MB warn / 4 MB fail, `dist/beta` JS 750 kB warn / 1 MB fail, `theme.css` 2000-line warn / 2500-line fail) | enforced by `cargo xtask check` |

## System invariants

- [`crates/dezoomify-core`](architecture.md#cratesdezoomify-core) and [`crates/dezoomify-engine`](job-engine.md) are pure Rust libraries with no network, filesystem, clock, UI, or image-codec access.
- [`crates/dezoomify-protocol`](protocol.md) is the Rust source for the generated TypeScript bindings used across the WASM boundary.
- One shared [UI](architecture.md#packagesshared-ui) (React TSX) serves the website, desktop app, and extension.
- Browser and native runtimes implement the same capabilities honestly; unsupported operations are reported before a job starts.
- Cookies move only from the extension to native after explicit, scoped consent; ordinary handoffs contain no secrets.
- Every user-visible failure has a stable error code and zero or more typed [recovery actions](errors.md#recovery-actions).
- Contract pages use present tense as invariants and carry no staleness markers. Open work lives in [`plans/`](../plans/), including the [legacy retirement](../plans/legacy-retirement.md) day-of-switch plan.
