Dezoomify's website, extension, desktop app, and CLI share one Rust algorithm
with injected `Host` capabilities.

## Where to look

- [Architecture](docs/architecture.md): ownership and dependency boundaries.
- [Development](docs/development.md) and [Testing](docs/testing.md): setup and validation.
- [Docs index](docs/README.md): contributor and user guides.
- `packages/shared-ui/`: follow its [instructions](packages/shared-ui/AGENTS.md).

## Invariants

- Keep `legacy/` and the app deployed at `/` pristine, byte for byte. Product
  changes belong to `/beta` and the other products.
- Keep parsers and geometry pure. The algorithm uses only injected Hosts for
  I/O, clocks, codecs, resources, and task ownership. Products never import
  each other; shared UI never accesses host globals. Browser transport and
  image modules receive callbacks rather than importing UI.
- Define cross-language types in `crates/dezoomify/src/model.rs`; import generated
  bindings, never redeclare or hand-edit them. Run `cargo xtask bindings generate`
  after boundary changes. Branch on error `kind` and structured facts, not prose.
- The metadata proxy fetches public metadata only. Extension scans require
  explicit user action and session access requires granted permissions.
  Declare only permissions shipped code uses; follow [Security](docs/security.md).
- Do not commit generated website output. Only `packages/wasm-bindings` and
  `generated/*.json` are tracked generated trees.
- Use Node for repository-authored HTTP servers, including Rust test fixtures.
  Live website tests are opt-in.
- Read files before editing, use `apply_patch`, and preserve unrelated work.
  Preserve exact URLs, settings, and error causes in bounded local diagnostics.

## Documentation

Keep one home for each useful reader question. Prefer shortening or deleting
over adding pages; change guides when their advice becomes wrong or incomplete.
Code changes do not automatically require documentation. Explain rationale and
costly pitfalls; link to code and command help for API shapes, constants, and
coverage. Keep user guides in `docs/user/`, the packaged desktop guide in
`apps/desktop/desktop-app.md`, and component setup or provenance in its README.
Do not add implementation inventories or change diaries. This applies to nested
instructions too.

## Validation

Run `cargo xtask check` and `cargo xtask test` from the repository root; use
`cargo xtask test <target>` for focused iteration. Finish code changes with
`cargo xtask test all` and `cargo xtask ci local`. See `cargo xtask --help`.
