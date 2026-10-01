# dezoomify documentation

dezoomify discovers zoomable images, lets a user choose an image and level, downloads tiles, processes them, and saves the result. The same job model and shared UI run on the website, desktop app, and extension; the CLI uses the same core and native runtime without the UI.

## Guides

- [User documentation](user/README.md): plain-language guide published to `/help/`; the single source of truth for user-facing copy.
- [Product](product.md): users, workflows, and product boundaries.
- [Architecture](architecture.md): monorepo components and dependency rules.
- [Algorithm](algorithm.md): async discovery, acquisition, selection, and retry policy.
- [Browser runtime](browser-runtime.md): browser fetching, processing, and saving.
- [Extension](extension.md): page discovery and browser-session fetching, including the source-binding and job-tab contract appendix.
- [Native apps](native-apps.md): CLI and Tauri desktop capabilities.
- [Bindings](bindings.md): generated Host calls, domain values, and handoff.
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
- **host**: injected platform capabilities (browser tab, desktop shell, CLI process).
- **runtime**: platform operations inside an app (browser or native code doing fetch, decode, save).
- **transport**: how bytes reach the app (direct fetch, proxy, browser session).
- **handoff**: moving a job to the desktop app through a `dezoomify://` link.
- **scenario**: a deterministic test unit under `testdata/scenarios`.

The full vocabulary rules live in the root `AGENTS.md`.

## Canonical homes

Each fact lives once; every other page links to it:

| Fact | Canonical home |
|---|---|
| Transport policy (direct browser fetch first, automatic metadata proxy fallback) | [Browser runtime](browser-runtime.md#request-order) |
| Metadata window constant (`DIRECT_METADATA_TIMEOUT_MS`) | `packages/browser-runtime/src/tile-policy.ts` |
| Native output formats and encoder behavior | [Native apps](native-apps.md#native-runtime) |
| Capability baselines | `crates/dezoomify/src/model.rs` and manifests under `generated/` |
| Canvas and save limits | [Compatibility](compatibility.md#canvas-and-save-limits) |
| User-facing copy | [User documentation](user/README.md) |
| Task grammar (`xtask`) | [`crates/xtask/README.md`](../crates/xtask/README.md) |
| Size budgets (wasm 5 MB warn / 6 MB fail, extension ZIPs 3 MB warn / 4 MB fail, `dist/beta` JS 750 kB warn / 1 MB fail, `theme.css` 2000-line warn / 2500-line fail) | enforced by `cargo xtask check` |

## System invariants

- [`crates/dezoomify`](architecture.md#rust-algorithm) is the shared Rust algorithm and pure parsers, with platform operations injected through Host.
- [`dezoomify::model`](bindings.md) is the Rust source for the generated TypeScript bindings used across the WASM boundary.
- One shared [UI](architecture.md#shared-ui-and-application) (React TSX) serves the website, desktop app, and extension.
- Browser and native runtimes implement the same capabilities honestly; unsupported operations are reported before a job starts.
- The extension never transfers browser cookies to another app. Desktop deep links are revalidated and confirmed before they start work.
- Every user-visible failure is one typed error whose `kind` names it and whose structured facts drive [recovery](errors.md#recovery-actions).
- Contract pages use present tense as invariants and carry no staleness markers. Open work lives in [`plans/`](../plans/), including the [legacy retirement](../plans/legacy-retirement.md) day-of-switch plan.
