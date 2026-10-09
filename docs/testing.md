# Testing

Test behavior that could regress. Prefer improving an existing test or adding a
fixture to the shared runner over adding many unit tests. A test should catch
future bugs without depending on implementation details; not every change needs
a new test. Do not assert source-file contents or invent architectural tests.

## Choose a test

- `cargo xtask test`: Rust workspace and Node unit tests.
- `cargo xtask test <target>`: focused iteration; use `cargo xtask --help` for targets.
- `cargo xtask test all`: also exercises current WASM bindings, the website in
  Chromium, and packaged extensions in Chromium and Firefox.
- `cargo xtask ci local`: static checks, tests, WASM portability, and dependency audit.
- `cargo xtask test desktop --e2e-window`: real desktop window; needs a display
  (headless Linux: `xvfb-run -a`) and stays outside `test all` and `ci local`.

Finish code changes with `test all` and `ci local`. Live source-site checks
(`cargo xtask test live --public`) are opt-in and advisory, never sole coverage.
Setup and prerequisites: [Development](development.md).

## Shared product matrix

Add a minimal fixture under [`fixtures/`](../fixtures/README.md) to exercise
viewer discovery and saving across products. The same inputs run through CLI,
website UI, packaged extensions, and the explicit desktop window lane. Tests
check dimensions and every saved pixel. The fixture README owns file layout and
tolerance rules; no per-product registration is needed.

Desktop fixture and test changes trigger its real-window CI matrix on Linux,
macOS, and Windows. Windows checkouts must enable Git symlinks before checkout.

## Unit tests

Use parser tests for malformed metadata and unusual geometry. Use Host tests
for retries, cancellation, resource limits, codecs, publication, cache isolation,
and credentials. UI/product tests cover accessibility, permissions, navigation,
and recovery. These tests exercise failures a successful save cannot reveal.
Normal Biome and Clippy checks enforce dependency boundaries.

Historical reproductions under [`testdata/scenarios/`](../testdata/scenarios/README.md)
remain available to focused tests; that README owns their provenance and replay
rules. Git records content changes.

## HTTP fixtures

Use Node for repository-authored HTTP servers. Rust tests launch Node and close
its stdin to stop it; they do not bind listeners. Use ordinary loopback URLs for
local fixtures and the replay helpers for captured remote URLs. Unknown requests
must never reach the internet.

[`fixture-server`](../crates/fixture-server/README.md) covers server entry points;
fixture-local protocol handlers and their authoring instructions belong beside
the fixture data. Native malformed-wire tests use `test/raw-server.mjs` with bytes
supplied over stdio. Unmodified third-party servers used as test subjects and the
desktop WebDriver are outside the authored-server rule.

## Coverage

Use coverage to find redundant tests, not as a percentage gate.
`cargo llvm-cov --workspace` measures Rust line/function coverage; exclude test
harnesses and tooling. Stable Rust does not report branch coverage. Full product
saves provide additional evidence that unit coverage cannot supply.
