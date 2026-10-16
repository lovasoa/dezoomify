One Rust algorithm powers the website, extension, desktop and CLI via injected
`Host` capabilities.
See [Architecture](docs/architecture.md), [Development](docs/development.md),
[Testing](docs/testing.md), [guides](docs/README.md) and
[shared UI rules](packages/shared-ui/AGENTS.md).

## Invariants

- Keep `legacy/` and the app at `/` pristine, byte for byte. Product changes
  belong to `/beta` and the other products.
- Keep parsers/geometry pure. Hosts own I/O, clocks, codecs, resources and tasks.
  Products never import each other; shared UI never accesses host globals.
  Browser transport/image modules receive callbacks.
- Define cross-language types in `crates/dezoomify/src/model.rs`; import generated
  bindings, never hand-edit. Run `cargo xtask bindings generate` after boundary
  changes. Branch on error `kind` and structured facts, not prose.
- Proxy only public image-download resources without credentials. Extension scans
  need explicit action; session access needs granted permissions. Declare only used
  permissions; see [Security](docs/security.md).
- Do not commit website output. Track generated files only in
  `packages/wasm-bindings` and `generated/*.json`.
- Use Node for authored HTTP servers, including Rust fixtures. Live tests are opt-in.
- Read before editing, use `apply_patch`, and preserve unrelated work. Keep exact
  URLs, settings, and error causes in bounded local diagnostics.

## Documentation

Keep Markdown short and durable, when useful: why reuse signed artifacts, not
what upload functions do. Link to source/help instead of copying API details or
inventories. One home per question; no change diaries. Code changes need not
change docs. User guides: `docs/user/`;
desktop help: `apps/desktop/desktop-app.md`; component setup: its README.
Apply this to nested instructions too.

## Tests and reviews

Use judgment: not every change needs a test. Prefer short, readable scenarios
covering real production behavior with little setup: one shared image fixture
over four product tests; retry yielding a download over assertions about helper
calls. Avoid copied constants, tautologies, tests of tests and redundant coverage.

Keep modules focused and code concise. A third copy of logic calls for a shared
abstraction; avoid speculative frameworks. Prioritize easy reviews: focused PRs,
brief descriptions of the problem, behavior and relevant validation; no file
inventories or implementation tours.

Choose validation by risk; see `cargo xtask --help` and Testing. Use focused checks;
`cargo xtask test all` and `cargo xtask ci local` cover shared product behavior.
