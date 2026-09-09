# Dezoomify

High-resolution zoomable images (IIIF, Deep Zoom, Zoomify, krpano, and more).

- Website (repository root, deployed from this branch): worker-hosted wasm
  core discovery, direct-first transport with automatic eligible metadata
  proxy fallback, canvas assembly, and real save (Chromium E2E covered).
- Extension (`apps/extension/`): explicit-action scan with unit coverage;
  store listing submitted (pending review).
- Desktop (`apps/desktop/`): real Tauri window with the five capability
  commands, native save dialog, and installer bundling
  (`cargo xtask build desktop` produces an unsigned Linux `.deb`; no paid
  signing; automatic updates are disabled, check GitHub Releases manually).
- CLI (`apps/cli/`): real save pipeline through the native runtime,
  covering discovery, bounded tile acquisition, assembly, and output writing.

## Quick start

```sh
cargo xtask setup     # verify tools and install the pnpm workspace
cargo xtask check     # formatting, lint, artifact validation
cargo xtask test      # fast deterministic test suite
cargo xtask test all  # full deterministic suite (no public network)
```

`cargo xtask test live --public` is the only command that contacts real
websites (explicit opt-in). `cargo xtask --help` lists everything else,
including `build`, `dev`, `ci`, `release`, `protocol`, and `fixtures`. See
[Development](docs/development.md) and [Testing](docs/testing.md).

## Layout

- Repository root: the website, where you paste a URL and save the image.
- [`apps/`](apps/): the extension, desktop app, and CLI.
- [`crates/`](crates/): the Rust engine, with pure discovery core, job state
  machine, versioned protocol, native runtime, WASM adapter, and test tooling.
- [`packages/`](packages/): TypeScript shared UI, browser runtime, and generated
  protocol bindings.
- [`testdata/scenarios`](testdata/scenarios): deterministic test fixtures.
- [`docs/`](docs/): architecture, privacy, security, and release contracts.

## How fetching works

The website always tries a direct browser fetch first, with a short 1500 ms
window. If the direct fetch does not complete in time, it automatically retries
eligible public metadata (never image tiles) through a same-origin metadata
proxy. This proxy is visible in the UI and never carries cookies or
credentials. The extension instead uses
your browser session under permissions you grant; cookie handoff to the desktop
app is a separate, explicitly consented step.
