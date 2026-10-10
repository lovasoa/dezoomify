# Development

Install Rust and the Node.js version in [`.node-version`](../.node-version), then
run these commands from the repository root:

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask dev web
```

`setup` installs frozen JavaScript dependencies and the pinned Firefox driver,
checks WASM tools, and installs the versioned Git hooks. It does not install
Rust toolchains or browsers. WASM builds need `wasm-bindgen-cli` matching
`Cargo.lock`; setup reports mismatches.

Read [Architecture](architecture.md) to choose where a change belongs and
[Testing](testing.md) to choose regression coverage. For new site support, use
[Contributing a format](CONTRIBUTING-format.md).

## Builds

| Command | Output |
|---|---|
| `cargo xtask build web` | `dist/`: legacy at `/`, new app at `/beta`, WASM and help |
| `cargo xtask build cli` | `target/debug/dezoomify-cli` |
| `cargo xtask build extension` | Chromium and Firefox ZIPs in `target/extension/` |
| `cargo xtask build desktop` | Matching-host installer; [prerequisites](../apps/desktop/README.md#bundles) |
| `cargo xtask build wasm` | WASM under `target/wasm32-unknown-unknown/` |

Do not commit `dist/`, `wasm/`, or `help/`. Website assembly must preserve
`legacy/` byte for byte. [Operations](operations.md) covers deployment and releases.

## Local servers

| Command | Environment |
|---|---|
| `cargo xtask dev web` | Full site and proxy at `http://127.0.0.1:8080/` |
| `cargo xtask dev ui` | Beta UI at `http://127.0.0.1:8081/beta` |
| `cargo xtask dev desktop` | Tauri with Vite at `http://localhost:1420/`; needs platform webview packages |
| `cargo xtask dev extension --browser chromium` | Packaged extension in a temporary browser profile; rerun after changes |

Dev commands bind loopback and print cleanup instructions. The web server uses
the deployed site's assembled tree and proxy implementation. For a deterministic
fixture origin, run `cargo xtask fixtures serve --port 0`.

## Bindings and dependencies

After changing Rust boundary types, run `cargo xtask bindings generate` and
inspect the generated diff. `cargo xtask bindings check` verifies the contract
and WASM portability. Do not hand-edit generated declarations.

The root pnpm lockfile owns active JavaScript dependencies. Playwright is pinned
through `pnpm.overrides`; update the override and workspace specs together.
Install browser binaries separately. Direct Cargo and pnpm commands are useful
for component debugging; `cargo xtask --help` is the command reference.

## Validation

Use `cargo xtask check`, `cargo xtask test`, and focused `test <target>` commands
while iterating. Finish code changes with `cargo xtask test all` and
`cargo xtask ci local`; [Testing](testing.md) explains additional browser and
desktop coverage. Live source-site checks are opt-in and advisory.

For native output performance comparisons, build release CLIs in separate
checkouts and Cargo target directories with
`cargo build --release --locked -p dezoomify-cli`, then run
[`bench-native-output.mjs`](../scripts/bench-native-output.mjs) with the old and
new executable paths. It measures timing, peak RSS, request counts, and output
size using fresh tile caches.
