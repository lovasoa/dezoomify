# Dezoomify NG

Download high-resolution zoomable images (IIIF, Deep Zoom, Zoomify, krpano,
and more) via the **website**, **browser extension**, **desktop app**, or
**command line** — all powered by one shared engine.

- Website: paste an image URL at the live preview
  (`apps/web/`, deployed from this branch).
- Extension: finite active-tab scan with your browser session
  (`apps/extension/`).
- Desktop / CLI: native downloads, bulk mode, local files
  (`apps/desktop/`, `apps/cli/`).

## Quick start

```sh
cargo xtask setup     # verify pinned tools (Rust 1.98, Node 22)
cargo xtask check     # formatting, lint, artifact validation
cargo xtask test      # fast deterministic test suite
cargo xtask test all  # full deterministic suite (no public network)
```

`cargo xtask test live --public` is the only command that contacts real
websites (explicit opt-in). `cargo xtask --help` lists everything else,
including `build`, `dev`, `ci`, `release`, `protocol`, `fixtures`, `sources`,
and `parity`. See [Development](docs/development.md) and
[Testing](docs/testing.md).

## Layout

- [`apps/`](apps/) — the four user-facing programs.
- [`crates/`](crates/) — Rust engine: pure discovery core, job state machine,
  versioned protocol, native runtime, WASM adapter, plus test tooling.
- [`packages/`](packages/) — TypeScript: shared UI, browser runtime, generated
  protocol bindings.
- [`testdata/scenarios`](testdata/scenarios) — deterministic test fixtures.
- [`docs/`](docs/) — architecture, privacy, security, and release contracts.
- [`migration-sources/`](migration-sources/) — read-only imported history of
  the three legacy projects, kept for parity evidence. Do not edit.

## How fetching works

The website always tries a direct browser fetch first. Only after a classified
network/CORS failure does it automatically retry eligible public metadata
(never image tiles) through a same-origin metadata proxy — visible in the UI,
with an opt-out, and never carrying cookies or credentials. The extension uses
your browser session under permissions you grant; cookie handoff to the desktop
app is a separate, explicitly consented step.
