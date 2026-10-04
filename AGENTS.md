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
  [Architecture](docs/architecture.md) explains invocation ownership.
- [Docs index](docs/README.md): user and contributor guides.
  [User docs](docs/user/README.md): source of all user-facing documentation.
- `testdata/scenarios/`: deterministic fixtures, and transcripts.
  Read [Testing](docs/testing.md) before writing tests.
- `crates/xtask/`: development and release tooling.
  See [Development](docs/development.md) and [Command reference](crates/xtask/README.md).

## Invariants

- Keep parsers and geometry pure. The shared algorithm calls only injected
  Host capabilities; Hosts own I/O, clocks, codecs, resources, and task ownership.
  Products never import each other. Shared UI never accesses host globals;
  browser transport and image modules receive callbacks rather than importing UI.
- Define cross-language types once in `crates/dezoomify/src/model.rs`.
  Import generated bindings; never redeclare or hand-edit them. Regenerate with
  `cargo xtask bindings generate`; see [Architecture](docs/architecture.md#bindings-and-errors).
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
  Preserve exact URLs, settings, and error causes in bounded diagnostics.

## Documentation

Keep documentation only when it helps a named reader complete a task, make a
decision, or understand a non-obvious constraint that prevents a costly mistake.
If you cannot name the reader and the question it answers, do not add it.

- Update an existing guide only when a change makes its advice wrong or leaves
  out a necessary step. Code changes do not automatically require doc changes.
- Prefer editing, shortening, or deleting over adding pages. A new page needs a
  distinct, recurring reader need that an existing guide cannot serve concisely.
- Keep user instructions in `docs/user/`, contributor guides in `docs/`, and
  component setup or fixture provenance in the owning README. Link to one home.
- Source code, generated types/manifests, tests, and command help own API shapes,
  constants, capability lists, and coverage. Link to them; do not mirror them in
  prose. Keep architectural rationale and operational pitfalls that they cannot
  explain on their own.
- Do not add implementation inventories, change diaries, completion reports,
  speculative guarantees, or a page per feature. Git history owns past changes;
  use `plans/` only for requested, actionable future work.
- Write for someone new to the task: lead with what they need to do or know,
  omit repeated background, and remove obsolete guidance. These rules also apply
  to nested agent instructions; do not add blanket requirements to grow docs.

## Validation

Run from the repository root: `cargo xtask check` and `cargo xtask test`,
using `cargo xtask test <target>` for focused iteration. Finish code changes
with `cargo xtask test all` and `cargo xtask ci local`.
Use `cargo xtask --help` for the full command grammar.
