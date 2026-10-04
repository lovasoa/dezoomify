# Development

One monorepo: Rust crates, generated WASM bindings, shared UI, hosts, extension packaging, and release tooling change together.
Tests and the development server import TypeScript directly using Node's default type stripping, and the TSX test loader uses synchronous module hooks.

## Task grammar

The canonical form is `cargo xtask <task> [target] [options]`.

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask dev web
```

`setup` checks Rust, Node, WASM and wasm-bindgen tools, installs frozen workspace
dependencies and the pinned Firefox driver, and reports browser status. It does
not install browsers or Rust toolchains. It also installs the versioned hooks:
Rust formatting on commit and `cargo xtask ci check` on push.

The [command reference](../crates/xtask/README.md) owns task grammar and CI lanes.
Use direct Cargo or pnpm commands for component debugging.
See [Architecture](architecture.md) to choose where a change belongs and
[Testing](testing.md) to choose useful regression coverage.

## Builds

`favicon.svg` is the canonical blue-tile logo for the beta website,
help pages, and desktop icon generation. Native SVG UI markup mirrors that
artwork; the extension uses its blue PNG sizes and grey inactive variants.
The website builder copies these favicon assets only under `/beta/`. The legacy
app served at `/` retains its original files and artwork unchanged.

| Command | Output |
|---|---|
| `cargo xtask build web` | Assembled website in `dist/`: legacy at `/`, new app at `/beta`, WASM and generated help |
| `cargo xtask build cli` | `target/debug/dezoomify-cli` |
| `cargo xtask build extension` | Chromium and Firefox ZIPs in `target/extension/` |
| `cargo xtask build desktop` | Tauri app and matching-host installer; [prerequisites](native-apps.md#desktop-bundles) |
| `cargo xtask build wasm` | WASM under `target/wasm32-unknown-unknown/` |

WASM builds need `wasm-bindgen-cli` matching `Cargo.lock`. Browser products bundle
the same TypeScript/TSX sources directly. Never commit `dist/`, `wasm/`, or
`help/`; the deploy workflow builds them from source.

## Local servers

| Command | Environment |
|---|---|
| `cargo xtask dev web` | Full assembled site at `http://127.0.0.1:8080/`, including the proxy |
| `cargo xtask dev ui` | Beta UI at `http://127.0.0.1:8081/beta` |
| `cargo xtask dev desktop` | Tauri shell with Vite at `http://localhost:1420/`; requires platform webview packages |
| `cargo xtask dev extension --browser chromium` | Packaged extension in a throwaway browser profile; rerun after changes |

Dev commands print cleanup instructions and bind loopback. The web server uses
the deployed site's assembled tree and proxy implementation.
For standalone deterministic origins, run `cargo xtask fixtures serve --port 0`.

## Bindings and dependencies

Edit Rust boundary types, then run `cargo xtask bindings generate`.
`cargo xtask bindings check` compiles the contract, tests the generated package,
and checks WASM portability. Generated glue can differ across tool versions and
operating systems; inspect the change rather than hand-editing it.

The root pnpm lockfile owns active JavaScript dependencies. Playwright is pinned
repo-wide through `pnpm.overrides`; move the override and workspace specs together
when upgrading. Browser binaries are installed separately.

## Validation

During iteration, use `cargo xtask check`, `cargo xtask test`, and focused
`cargo xtask test <target>` commands. Finish code changes with
`cargo xtask test all` and `cargo xtask ci local`. The desktop real-window lane
is explicit: `cargo xtask test desktop --e2e-window`.
Live source-site checks are opt-in, advisory, and never substitute for fixtures.

For a new site format, follow [Contributing a format](CONTRIBUTING-format.md).
For releases and deployment, follow [Operations](operations.md).
