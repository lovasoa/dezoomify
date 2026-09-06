# Testing

Testing centers on shared scenarios in `testdata/scenarios`. A scenario defines
resources, capabilities, commands, effect results, expected transitions,
protocol events, output properties, and errors. The same corpus runs against
pure Rust logic and host integrations.

## Validation policy

Results fall into four classes: deterministic blocking, deterministic
platform-specific, live diagnostic, and manual release check. Every parity
behavior has at least one deterministic blocking test; live checks are
diagnostic and never substitute for deterministic coverage. Deterministic
suites are reproducible: fixed fixture bytes, no public DNS or network, stable
ordering, explicit seeds, controlled time, and canonical snapshots.

## Harness maintenance

The deterministic harness is `crates/fixture-server` (loopback route server)
driven by `testdata/scenarios`. Add scenarios per `testdata/scenarios/README.md`;
review route/payload/hash changes with `cargo xtask fixtures verify`; serve
locally with `cargo xtask fixtures serve --port 0`; keep tests isolated with
ephemeral ports and allocated addresses (never fixed shared ports); update
expected transcripts/pixels only after reviewing the diff they record; keep
deterministic and live checks separate as defined above.

## Test commands

Run tests from the repository root:

```sh
cargo xtask test
cargo xtask test core --parity
cargo xtask test scenario
cargo xtask test all
```

Bare `cargo xtask test` is the fast deterministic suite. It runs static checks,
short unit and contract suites, and generated-artifact validation while omitting
packaging and browser end-to-end suites. `cargo xtask test all` runs every
deterministic target, including controlled loopback HTTP and isolated browser
profiles. Neither command contacts public source sites. Public compatibility
checks run only through the explicit `cargo xtask test live` target; a live
target that stops working must be removed from the target list in
`crates/xtask/src/live.rs` with the reason in the commit message, never
tolerated as a failing case.

Focused targets are:

| Target | Coverage |
|---|---|
| `core` | pure format discovery, catalogs, grids, and processing recipes |
| `protocol` | Rust/TypeScript schema, goldens, fingerprints, redaction, current/N-1 |
| `job` | commands, effects, retries, progress, cancellation, and cleanup |
| `wasm` | WASM portability, bindings, transcripts, and memory ownership |
| `browser` | workers, transports, decoding, canvases, caching, and browser harness |
| `ui` | shared UI components, controller, accessibility, and host-neutral behavior |
| `web` | website direct-first transport, metadata CORS proxy fallback, and cross-browser end-to-end behavior |
| `native` | native runtime, CLI, encoders, cache, and scenario parity |
| `desktop` | Tauri integration, integration registration, updater fixtures, and E2E |
| `extension` | manifests, scanning, browser-session fetch, permissions, and browser E2E |
| `native-messaging` | framing, handoff consent, cookie scope, registration, and cleanup |
| `scenario` | scenario-corpus gates: native pipeline scenarios over loopback plus CLI snapshots |
| `live` | explicit low-volume public-network compatibility checks |
| `all` | every deterministic focused target; excludes `live` |

Use the narrowest owning target first. Focus with supported flags such as
`--purity`, `--parity`, `--transcripts`, and `--browser <name>`. Targets that
accept no options (for example `native`, `extension`, `scenario`) reject unknown
flags instead of silently widening or skipping coverage.

## Test locations

`test/` (singular, repository root) is the canonical fast website unit suite:
10 `node:test` files (`test/*.test.mjs`). It runs via
`node --test test/*.test.mjs` and the `web`, `ui` (controller only), and
`build web` gates. It is tracked and always present.

`tests/` (plural, repository root) is not a suite and never runs in any
`cargo xtask test` or `cargo xtask ci` lane. It holds only untracked
Playwright residue: ignored `node_modules/` and
`test-results/.last-run.json` plus an empty `fixtures/remote/` directory
tree with no fixture bytes. It has no `package.json`, no specs, and no
Playwright config. Do not add files here; the canonical suites are `test/`
and `crates/fixture-server/tests/`. See `tests/README.md`. Real fixtures
live in `testdata/scenarios`.

`crates/fixture-server/tests/` is the canonical fixture-server gate:
`http_contract.rs` and `security.rs` (plus `common/mod.rs`) are Rust
integration tests over loopback and run via
`cargo test -p dezoomify-fixture-server` (also in bare `cargo xtask test`
via the `cargo-test` step); `webapp-e2e/` is the Playwright real-Chromium
job (`webapp.spec.js`, `playwright.config.js`, `package.json`) with its own
ignored `node_modules/`, `test-results/`, and `downloads/`, and runs via
`cargo xtask test web --e2e` and the `--browser` legs of `test browser` and
`test wasm`.

Other suites keep their own directories and never use root `tests/`:
`packages/browser-runtime/test/`, `packages/protocol-ts/test/`,
`apps/*/tests/`, `legacy/tests/`, `crates/*/tests/`, and the shared corpus
in `testdata/scenarios`.

## Test layers

- **Core fixtures** verify recognition, parsing, catalogs, tile plans, and
  recipes with supplied bytes and no I/O.
- **Job tests** replay commands and effect results for ordering, retries,
  cancellation, partial policy, and stale-result handling.
- **Protocol tests** compare Rust with generated TypeScript/schema artifacts and
  current/N-1 golden round trips.
- **Integration contracts** run scenarios against the native runtime, browser
  worker, Tauri app, extension, Native Messaging host, and CLI.
- **Output tests** compare decoded pixels, dimensions, placement, color,
  transparency, and metadata. Exact bytes are required only from a deterministic
  repository-owned encoder.
- **End-to-end tests** exercise the shared UI on the website, desktop app, and
  extension using controlled servers and isolated profiles.

## CI lanes

`cargo xtask ci <lane>` is the same fixed entry point used by CI. It rejects
unknown lane names and does not evaluate shell input.

| Lane | Scope |
|---|---|
| `rust` | core, protocol, job, and native Rust unit and contract tests |
| `wasm` | WASM adapter portability and transcript suites |
| `browser` | browser-runtime unit matrix |
| `web` | website integration suites (unit + Playwright E2E where browsers are installed) |
| `native` | native runtime and CLI suites |
| `desktop` | desktop shell suites |
| `extension` | extension unit, manifest, and Native Messaging API suites |
| `protocol` | protocol contract suites |
| `security` | parity inventory validation and protocol artifact checks |

`cargo xtask ci local` runs all lanes listed above; lanes that need installed
browsers or native runners report their narrowed scope in their output rather
than claiming full platform coverage. Required CI and `test all` remain
deterministic; scheduled/manual live CI invokes `test live` separately.

## Network coverage

`crates/fixture-server` provides hermetic HTTP fixtures for redirects, ranges,
compression, cache validation, CORS, cookies, authentication, throttling,
truncation, malformed responses, cancellation, and proxy security. It binds to
loopback on allocated ports and public-network fallback is forbidden.

Website transport scenarios assert the full policy matrix: direct browser
success makes no proxy request; only a classified CORS or network failure (or a
direct fetch that does not complete within the 250 ms metadata window) can
cause automatic metadata proxy fallback;
the fallback has no per-attempt consent prompt;
and the website reports direct browser fetch and metadata CORS proxy transport
states and transitions.
Authentication, authorization,
ordinary HTTP, parse, and decode failures do not activate the proxy, nor do
private, local, signed, token-bearing, or otherwise credential-requiring
metadata requests; tile requests never use the proxy at all. The proxy security
suites verify that the relay strips all inbound credential headers and forwards
only a narrow allowlist upstream (both browser-to-proxy and proxy-to-upstream
legs), and the deployed function fetches with `redirect: "manual"` so every
redirect hop is revalidated against the same policy.

Live checks use no private source-site credentials (public demo keys embedded in fixture URLs are allowed), bounded targets, low request rates,
and redacted reports. A live failure never replaces deterministic regression
coverage or blocks an ordinary pull request.

## Representative workflows

### Extension cookies and Native Messaging

```sh
cargo xtask test extension
cargo xtask test native-messaging
```

Verify manifests and permissions (narrow host grants, no remote code, strict
CSP with `wasm-unsafe-eval` for the page core), scanning state machines with
observer-before-reload ordering and bounded settle, browser-session fetch
scoping, and handoff envelope validation with replay/expiry/origin rejection
and zero side effects on rejection. These gates run the unit suites plus a
hermetic headless browser E2E in both engines: the real store-shaped package
(with an E2E-only loopback grant) opens a fixture page, runs the finite
reload scan, discovers through the wasm core, fetches the tiles, assembles
the image, saves it, and the test verifies the saved PNG bytes against the
fixture pyramid. Chromium runs under Playwright; Firefox under
Selenium/geckodriver (binary via `DEZOOMIFY_FIREFOX_BIN`, a system install,
or the Playwright cache; deps auto-install via npm on first run). Full
user-facing UI flows remain manual or CI-runner work.

### Browser tainted canvas

```sh
cargo xtask test browser
cargo xtask test web
```

The browser-runtime display suites verify that tainted display never enables
readable bytes: the image remains visible, `originClean` becomes false, and
pixel reads, `toBlob`, and `toDataURL` are guarded. The website suites verify
direct-first transport, metadata CORS proxy fallback classification, and the
automatic 250 ms direct-metadata timeout. Full cross-browser E2E runs under `test web` when browsers are
installed; otherwise the unit matrix reports the narrowed scope.

## Cross-runtime guarantees

Scenario traces are normalized across runtimes. Capability differences may
select different branches, but equivalent commands and effect results produce
equivalent job states, error codes, and recovery actions. Release candidates
pass the compatibility matrix in [Releases](releases.md); security-sensitive
scenarios follow [Security](security.md).
