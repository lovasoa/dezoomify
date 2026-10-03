All tests MUST be designed to have a high chance to catch future bugs and a low chance of churn.
It's better not to write a test than to write a fragile test.
Not all code changes require a new test. It's often better to improve existing tests than to add new ones.
A single added test fixture that fits the existing test runner is preferable to many unit tests.
"Architectural" tests or tests that try to make assertions on source file contents are forbidden.

`cargo xtask test` runs the Rust workspace and Node units once.
`cargo xtask test all` adds fresh WASM bindings, the website in Chromium, and
packaged extensions in Chromium and Firefox. `cargo xtask ci local` adds static
checks, WASM portability, and the dependency audit.

## Shared product matrix

[`fixtures/`](../fixtures/README.md) contains ordinary files and relative symlinks.
Each `format/variant/viewer.html` is discovered automatically; an optional `input.txt`
overrides the default viewer URL. No registration, hash manifest, generated
expectations, or route schema is needed. Every basic
input produces the same 512×512 picture from shared PNG or JPEG tiles.

Each product iterates the same discovered inputs and checks saved dimensions
and every pixel. Pixel comparisons are exact by default. A variant directory prefixed with
`approximate-` permits a two-value RGB tolerance for JPEG decode differences;
dimensions and alpha remain exact. Discovery derives the tolerance from the
directory name, without fixture-specific test rules.
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
test changes trigger it. The test build embeds its frontend, like the packaged
app, and needs no development server. Windows checkouts enable Git symlinks
before checkout.

## Unit tests

Pure parser tests cover malformed metadata and unusual geometry. Host tests
cover retries, cancellation, resource limits, codecs, file publication, cache
isolation, credentials, and cleanup. UI and product tests cover accessibility,
permissions, source navigation, and recovery. These are behavior checks
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
`cargo llvm-cov --workspace` measures Rust source line and function coverage
(including inline unit tests; exclude integration harnesses and test tooling);
the stable toolchain does not report branch coverage. Full browser saves supplement
that measurement and are required by the corresponding CI lanes.
Focused command grammar and CI ownership live in [xtask](../crates/xtask/README.md).
