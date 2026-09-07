# dezoomify documentation

dezoomify discovers zoomable images, lets a user choose an image and level, downloads tiles, processes them, and saves the result. The same job model and shared UI run on the website, desktop app, and extension; the CLI uses the same core and native runtime without the UI.

## Guides

- [User documentation](user/README.md): the plain-language guide for people
  using Dezoomify, published to `/help/`; the single source of truth for all
  user-facing copy.
- [Product](product.md): users, workflows, and product boundaries.
- [Architecture](architecture.md): monorepo components and dependency rules.
- [Job engine](job-engine.md): deterministic job state, effects, and policies.
- [Browser runtime](browser-runtime.md): browser fetching, processing, and saving.
- [Extension](extension.md): page discovery and browser-session fetching.
- [Native apps](native-apps.md): CLI and Tauri desktop capabilities.
- [Protocol](protocol.md): generated commands, events, handoff, and compatibility.
- [Errors](errors.md): typed failures and recovery actions.
- [Testing](testing.md): shared scenarios and runtime-specific coverage.
- [Security](security.md): trust boundaries, credentials, and proxy controls.
- [Development](development.md): workspace conventions and validation.
- [Contributing a format](CONTRIBUTING-format.md): capture, parser, scenario,
  and pull request checklist for a new site format.
- [Compatibility](compatibility.md): browsers, canvas limits, format support by
  app, and support reports.
- [Releases](releases.md): coordinated versions and compatibility checks.

## Single-source policy

Numbers and lists live once; every other page links:

- Transport policy (direct browser fetch first, automatic metadata CORS
  proxy fallback after a classified failure or a direct fetch that does not
  complete within the 1500 ms window) is canonical in
  [Browser runtime](browser-runtime.md). The millisecond constant is
  canonical in `crates/dezoomify-protocol/src/dto.rs` (`METADATA_WINDOW_MS`)
  with its generated TypeScript projection.
- Native output formats and encoder behavior are canonical in
  [Native apps](native-apps.md). Negotiated capability baselines are
  canonical in `crates/dezoomify-protocol/src/dto.rs` and the generated
  manifests under `generated/`.
- Canvas and save limits are canonical in
  [Compatibility](compatibility.md). User pages state the user-facing facts
  and link back instead of restating the table.
- [User documentation](user/README.md) is the single source of truth for
  everything users read; no other page restates it.
- Contract pages use present tense as invariants and carry no staleness
  markers. Open work lives in [`plans/`](../plans/), including the
  [legacy retirement](../plans/legacy-retirement.md) day-of-switch plan.
- Size budgets (`wasm_bg.wasm` 5 MB warn / 6 MB fail, extension ZIPs 3 MB
  warn / 4 MB fail, `dist/beta` JavaScript 750 kB warn / 1 MB fail,
  `theme.css` 2000-line warn / 2500-line fail) are enforced by
  `cargo xtask check`; missing build outputs skip with a rebuild note.

## System invariants

- [`crates/dezoomify-core`](architecture.md#cratesdezoomify-core) and [`crates/dezoomify-job`](job-engine.md) are pure Rust libraries with no network, filesystem, clock, UI, or image-codec access.
- [`crates/dezoomify-protocol`](protocol.md) is the Rust source for the generated TypeScript bindings and schema and is the only wire contract between the shared UI and a runtime.
- One shared [UI](architecture.md#packagesshared-ui) (vanilla TypeScript, no UI framework) serves the website, desktop app, and extension.
- Browser and native runtimes implement the same capabilities honestly; unsupported operations are reported before a job starts.
- The website tries credential-free direct browser fetch first, then automatically falls back to the metadata CORS proxy after a classified CORS or network failure (or a direct fetch that does not complete within the 1500 ms metadata window) for an eligible public, non-credential metadata request (never tiles); it shows the active transport.
- Cookies move only from the extension to native after explicit, scoped consent; ordinary handoffs contain no secrets.
- Every user-visible failure has a stable error code and zero or more typed [recovery actions](errors.md#recovery-actions).
- User-facing guidance and error messages lead with specific, plain-language facts and a next action; technical detail is progressively disclosed.
