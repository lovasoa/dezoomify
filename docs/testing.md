# Testing

`cargo xtask test` runs the Rust workspace and Node units once.
`cargo xtask test all` adds fresh WASM bindings, the website in Chromium, and
packaged extensions in Chromium and Firefox. `cargo xtask ci local` adds static
checks, WASM portability, and the dependency audit. Node 24.15.0 is the minimum.

## Shared product matrix

[`fixtures/`](../fixtures/README.md) contains ordinary files and relative symlinks.
Each `format/variant/input.txt` contains its relative input URL; no registration,
hash manifest, generated expectations, or route schema is needed. Every basic
input produces the same 512×512 picture from the four shared JPEGs.

Each product iterates the same discovered inputs and checks saved dimensions
and every pixel. JPEG decode differences have a two-value tolerance per channel.
The website drives its real UI; extensions use real packaged job tabs; CLI tests
invoke the binary. Desktop uses the real window in its explicit window lane.

```sh
cargo xtask test native
cargo xtask test web --e2e
cargo xtask test extension
cargo xtask test desktop --e2e-window
```

The desktop window lane needs a GUI session (Linux: `xvfb-run -a`) and stays outside
`test all` and `ci local`. Its workflow runs Linux, macOS, and Windows; fixture and
test changes trigger it. Windows checkouts enable Git symlinks before checkout.

## What remains focused

Pure parser tests cover malformed metadata and unusual geometry. Host tests
cover retries, cancellation, resource limits, codecs, file publication, cache
isolation, credentials, and cleanup. UI and product tests cover accessibility,
permissions, source navigation, queues, and recovery. These are behavior checks
where a normal successful save cannot exercise the relevant failure branch.
Boundary rules use standard Biome and Clippy checks.

Historical reproductions under `testdata/scenarios/` remain available to focused
regression tests. Provenance lives in their README; Git records content changes.

## HTTP fixtures

Node is the only runtime for repository-authored HTTP servers.
`test/fixture-server.mjs` serves files, symlinks, and fixture-local
`serve(Request): Response` functions, optionally asynchronous. The server knows
no image formats. Query protocols and signing belong in the fixture directory.
Native malformed-wire tests use `test/raw-server.mjs`; Rust supplies bytes over
stdio while Node owns sockets. Parent stdin closes and stops the subprocess.

The older corpus retains its URL-layout and exceptional `routes.json` mappings
while its regression fixtures migrate. Unknown URLs never reach the internet.
Ports are allocated on loopback. Third-party desktop WebDriver and unmodified
image servers used as test subjects are outside the authored-server rule.

`cargo xtask fixtures serve --port 0` starts the fixture server manually.
Live tests are separate: `cargo xtask test live --public` is opt-in and advisory.

## Coverage

Coverage is evidence for deleting redundant tests, not a percentage gate.
`cargo llvm-cov --workspace` measures Rust production line and function coverage;
the stable toolchain does not report branch coverage. Full browser saves supplement
that measurement and are required by the corresponding CI lanes.
Focused command grammar and CI ownership live in [xtask](../crates/xtask/README.md).
