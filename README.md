# Dezoomify

High-resolution zoomable images (IIIF, Deep Zoom, Zoomify, krpano, and more).

- Website (repository root, deployed from this branch): worker-hosted wasm
  core discovery, direct-first transport with automatic eligible metadata
  proxy fallback, canvas assembly, and real save (Chromium E2E covered).
- Extension (`apps/extension/`): explicit-action scan with unit coverage;
  store listing submitted (pending review).
- Desktop (`apps/desktop/`): lean Tauri shell (logic + config only; window
  and installer not yet implemented).
- CLI (`apps/cli/`): real download pipeline through the native runtime,
  covering discovery, bounded tile download, assembly, and output writing.

## Quick start

```sh
cargo xtask setup     # verify pinned tools (Rust 1.98, Node 22)
cargo xtask check     # formatting, lint, artifact validation
cargo xtask test      # fast deterministic test suite
cargo xtask test all  # full deterministic suite (no public network)
```

`cargo xtask test live --public` is the only command that contacts real
websites (explicit opt-in). `cargo xtask --help` lists everything else,
including `build`, `dev`, `ci`, `release`, `protocol`, and `fixtures`. See
[Development](docs/development.md) and [Testing](docs/testing.md).

## Layout

- Repository root: the website, where you paste a URL and download the image.
- [`apps/`](apps/): the extension, desktop app, and CLI.
- [`crates/`](crates/): the Rust engine, with pure discovery core, job state
  machine, versioned protocol, native runtime, WASM adapter, and test tooling.
- [`packages/`](packages/): TypeScript shared UI, browser runtime, and generated
  protocol bindings.
- [`testdata/scenarios`](testdata/scenarios): deterministic test fixtures.
- [`docs/`](docs/): architecture, privacy, security, and release contracts.

## How fetching works

The website always tries a direct browser fetch first, with a short 250 ms
window. If the direct fetch does not complete in time, it automatically retries
eligible public metadata (never image tiles) through a same-origin metadata
proxy. This proxy is visible in the UI and never carries cookies or
credentials. The extension instead uses
your browser session under permissions you grant; cookie handoff to the desktop
app is a separate, explicitly consented step.
