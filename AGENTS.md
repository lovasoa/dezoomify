Dezoomify downloads tiled zoomable images. The website, extension,
desktop app, and CLI share one Rust algorithm that takes a `Host` argument to interact with its environment.
 
## Where to look

- `crates/dezoomify/`: shared algorithm, zoomable image format parsers, geometry, and domain types. Start with [Architecture](docs/architecture.md) and [Algorithm](docs/algorithm.md).
- `crates/dezoomify-native/` and `crates/dezoomify-wasm/`: native Host and WASM bridge.
- `src/`, `legacy/`, and `apps/{extension,desktop,cli}/`: product integration.
  See [Browser runtime](docs/browser-runtime.md), [Extension](docs/extension.md),
  and [Native apps](docs/native-apps.md).
- `packages/shared-ui/`: host-neutral react app; follow its [AGENTS.md](packages/shared-ui/AGENTS.md).
  `packages/browser-runtime/` composes browser UI and Host capabilities.
  [Application](docs/application.md) defines invocation and history ownership.
- [Docs index](docs/README.md): detailed contracts.
  [User docs](docs/user/README.md): sources of all user-facing documentation,
  including [Desktop guide](apps/desktop/desktop-app.md), packaged in the DMG.
- `testdata/scenarios/`: deterministic fixtures, and transcripts.
  Read [Testing](docs/testing.md) before writing tests. [Acceptance matrix](docs/acceptance-matrix.md).
- `crates/xtask/`: development and release tooling.
  See [Development](docs/development.md) and [Command reference](crates/xtask/README.md).

## Invariants

- Keep the legacy app served at `/` pristine. Do not include changes to
  `legacy/` or alter its deployed files in PRs; website assembly must preserve
  those files byte for byte. Product changes belong to the beta app and other
  products, not the legacy app.
- Keep parsers and geometry pure. The shared algorithm calls only injected
  Host capabilities; Hosts own I/O, clocks, codecs, resources, and task ownership.
  Products never import each other. Shared UI never accesses host globals;
  browser transport and image modules receive callbacks rather than importing UI.
- Define cross-language types once in `crates/dezoomify/src/model.rs`.
  Import generated bindings; never redeclare or hand-edit them. Regenerate with
  `cargo xtask bindings generate`; see [Bindings](docs/bindings.md).
  Branch on error `kind` and structured fields, never display strings.
- the website's [metadata CORS proxy](functions/api/proxy.ts) allows fetching public metadata. Extension
  browser-session fetch requires granted permissions; scans require explicit
  user action. Declare only permissions shipped code uses.
  Follow [Security](docs/security.md).
- Do not commit generated website output. Only `packages/wasm-bindings` and
  `generated/*.json` are tracked generated trees. `scripts/build-site.mjs`
  builds the deployed website (legacy at `/`, new app at `/beta`).
- Use Node for repository-authored HTTP servers, including fixtures; Rust tests
  launch Node rather than bind listeners. Live website tests are opt-in.
- Read files before editing, use `apply_patch`, and preserve unrelated work.
  Update affected contracts alongside code; link to user docs instead of copying
  them. Preserve exact URLs, settings, and error causes in bounded diagnostics.

## Validation

Run from the repository root: `cargo xtask check` and `cargo xtask test`,
using `cargo xtask test <target>` for focused iteration. Finish code changes
with `cargo xtask test all` and `cargo xtask ci local`.
Use `cargo xtask --help` for the full command grammar.
