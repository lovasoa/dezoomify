# Dezoomify NG

Dezoomify NG is currently a repository scaffold and migration workspace. The
planned product unifies the command-line, desktop, web, and browser-extension
experiences around a pure Rust discovery core, shared job and protocol layers,
host-specific native and WebAssembly runtimes, and a shared studio UI. Those
workspace crates and applications do not exist yet unless their directories
contain implementation in addition to scaffold documentation.

Read [`docs/`](docs/) for architecture and product contracts and [`plans/`](plans/)
for ordered migration work. A document describing a target is not evidence that
the target has been implemented.

The canonical target locations are:

- reusable Rust components in [`crates/`](crates/), including
  [`crates/dezoomify-job`](crates/dezoomify-job/),
  [`crates/fixture-server`](crates/fixture-server/), and
  [`crates/xtask`](crates/xtask/);
- browser-facing packages in [`packages/`](packages/), with the protocol
  generated from its single Rust source into
  [`packages/protocol-ts`](packages/protocol-ts/);
- deterministic integration cases in
  [`testdata/scenarios`](testdata/scenarios/); and
- product composition roots in [`apps/`](apps/).

## Browser transport policy

The planned website first tries a direct browser-readable fetch. After a
classified CORS or network failure, it automatically falls back to the
restricted proxy for an eligible public, non-credential resource when the user
setting permits proxy use. The UI always identifies the active transport and
offers a proxy opt-out; it does not interrupt each fallback with a consent
prompt.

The proxy never receives cookies, `Authorization`, or other browser credentials,
never accesses private or local destinations, and rejects requests outside its
method, scheme, port, content, size, time, redirect, concurrency, rate, and
session-budget limits. Ordinary cross-origin image loading remains available as
a display-only path: a tainted canvas stays visible, but script cannot read,
process, hash, persist, or programmatically export its pixels. Cookie handoff is
separate, native-only, origin-scoped, and explicitly consent-gated.

For Native Messaging, browser enforcement of the native host manifest's allowed
extension IDs authenticates the extension sender. A fresh challenge/nonce binds
one handoff and its consent and prevents replay; it does not prove identity.

## Imported history

[`migration-sources/`](migration-sources/) contains three source roots imported
by non-squashed subtree merges, with their source commits and histories reachable
in this repository:

- [`dezoomify-rs`](migration-sources/dezoomify-rs/) supplies the Rust core,
  native downloader, CLI, encoders, and fixtures.
- [`dezoomify-web`](migration-sources/dezoomify-web/) supplies the browser app,
  dezoomers, proxy, and browser fixtures.
- [`dezoomify-extension`](migration-sources/dezoomify-extension/) supplies the
  browser-extension request monitor and URL recognition.

The locked imported tips are `f7caa07` for `dezoomify-web`, `23c4639` for the
in-progress `dezoomify-rs` migration snapshot, and `d231dd0` for
`dezoomify-extension`. The root `main` history contains the corresponding three
subtree merge commits.

Treat these roots as migration evidence. Do not refactor or delete them while
building the new tree; move behavior into the scaffold in plan-sized steps and
retain tests that prove parity.

## Validation available now

There is currently no root `Cargo.toml` or JavaScript workspace. Run these
commands from the repository root against the imported projects. Dependency
installation is separate so repeated test runs remain fast.

```sh
cargo test --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace
cargo clippy --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path migration-sources/dezoomify-rs/Cargo.toml --all -- --check

npm ci --prefix migration-sources/dezoomify-web/tests
npm test --prefix migration-sources/dezoomify-web/tests

npm ci --prefix migration-sources/dezoomify-extension
npm test --prefix migration-sources/dezoomify-extension
```

`npm run test:live --prefix migration-sources/dezoomify-web/tests` is an
optional network-dependent compatibility check, not deterministic regression
coverage. Set `DEZOOMIFY_LIVE_TESTS=1` when running the Rust test command only if
the opt-in network compatibility cases are intended. The web test command also
requires a Playwright-compatible Chromium installation.

## Planned workspace commands

The canonical final-state interface is `cargo xtask <task> [target]`. It covers
`setup`, `check`, focused and aggregate `test`, `build`, `dev`, `ci`, `release`,
and protocol/fixture/source/parity maintenance. For example:

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask test web
cargo xtask build extension
cargo xtask dev desktop
cargo xtask ci local
```

Bare `cargo xtask test` is the fast deterministic suite; `cargo xtask test all`
is the full deterministic suite. Both exclude public live network checks. Live
compatibility is always explicit as `cargo xtask test live`.

This checkout is still a scaffold: the root workspace and `xtask` are not
implemented yet, so none of the commands above are currently available. Use the
migration-source commands in the previous section until the active plan creates
the root workspace. [Development](docs/development.md),
[Testing](docs/testing.md), and the [xtask README](crates/xtask/) describe the
canonical final-state grammar; they do not override current command availability.
