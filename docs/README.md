# dezoomify-ng documentation

dezoomify-ng discovers zoomable images, lets a user choose an image and level, downloads tiles, processes them, and saves the result. The same job model and shared UI run on the website, desktop app, and extension; the CLI uses the same core and native runtime without the UI.

## Guides

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
- [Releases](releases.md): coordinated versions and compatibility checks.

## System invariants

- [`crates/dezoomify-core`](architecture.md#cratesdezoomify-core) and [`crates/dezoomify-job`](job-engine.md) are pure Rust libraries with no network, filesystem, clock, UI, or image-codec access.
- [`crates/dezoomify-protocol`](protocol.md) is the Rust source for the generated TypeScript bindings and schema and is the only wire contract between the shared UI and a runtime.
- One shared React [UI](architecture.md#packagesshared-ui) serves the website, desktop app, and extension.
- Browser and native runtimes implement the same capabilities honestly; unsupported operations are reported before a job starts.
- The website tries credential-free direct browser fetch first, then automatically falls back to the metadata CORS proxy only after a classified CORS or network failure for an eligible public, non-credential metadata request (never tiles); it shows the active transport and honors proxy opt-out.
- Cookies move only from the extension to native after explicit, scoped consent; ordinary handoffs contain no secrets.
- Every user-visible failure has a stable error code and zero or more typed [recovery actions](errors.md#recovery-actions).
- User-facing guidance and error messages lead with specific, plain-language facts and a next action; technical detail is progressively disclosed.
