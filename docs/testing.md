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
plus `crates/fixture-server/tests/legacy-web` (untouched-source oracle) driven
by `testdata/scenarios`. Add scenarios per `testdata/scenarios/README.md`;
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
cargo xtask test scenario --scenario website/tainted-display-canvas
cargo xtask test all
```

Bare `cargo xtask test` is the fast deterministic suite. It runs static checks,
short unit and contract suites, and generated-artifact validation while omitting
packaging and browser end-to-end suites. `cargo xtask test all` runs every
deterministic target, including controlled loopback HTTP and isolated browser
profiles. Neither command contacts public source sites. Public compatibility
checks run only through the explicit `cargo xtask test live` target; they are
advisory and non-blocking.

Focused targets are:

| Target | Coverage |
|---|---|
| `core` | pure format discovery, catalogs, grids, and processing recipes |
| `protocol` | Rust/TypeScript schema, goldens, fingerprints, redaction, current/N-1 |
| `job` | commands, effects, retries, progress, cancellation, and cleanup |
| `wasm` | WASM portability, bindings, transcripts, and memory ownership |
| `browser` | workers, transports, decoding, canvases, caching, and browser harness |
| `ui` | shared UI components, controller, accessibility, and host-neutral behavior |
| `web` | website direct-first transport, metadata CORS proxy fallback, opt-out, and cross-browser end-to-end behavior |
| `native` | native runtime, CLI, encoders, cache, and legacy parity |
| `desktop` | Tauri integration, integration registration, updater fixtures, and E2E |
| `extension` | manifests, scanning, browser-session fetch, permissions, and browser E2E |
| `native-messaging` | framing, handoff consent, cookie scope, registration, and cleanup |
| `scenario` | one or more named shared scenarios selected with `--scenario` |
| `live` | explicit low-volume public-network compatibility checks |
| `all` | every deterministic focused target; excludes `live` |

Use the narrowest owning target first. Focus with supported flags such as
`--purity`, `--parity`, `--transcripts`, `--scenario <id>`, `--host <name>`, and
`--browser <name>`. Unknown flags and filters fail instead of silently widening
or skipping coverage.

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
| `rust` | core, protocol, job, formatting, clippy, and Rust unit tests |
| `wasm-browser` | WASM and browser runtime |
| `ui-web-proxy` | shared UI, website, accessibility, and proxy security |
| `native` | native runtime and CLI on the Linux/macOS/Windows matrix |
| `desktop` | desktop tests and packaging on native OS runners |
| `extension` | extension unit, manifest, and package checks |
| `chromium-e2e` | website and extension Chromium workflows |
| `firefox-e2e` | website plus Firefox stable/ESR extension workflows |
| `native-messaging` | packaged host handoff and cleanup |
| `generated` | protocol generation, fixtures, source locks, parity, reproducibility |
| `security` | dependency, license, advisory, secret, and policy checks |

`cargo xtask ci local` runs every lane applicable to the current host and
reports platform-only lanes as unavailable, never as passed. Required CI and
`test all` remain deterministic; scheduled/manual live CI invokes `test live`
separately.

## Network coverage

`crates/fixture-server` provides hermetic HTTP fixtures for redirects, ranges,
compression, cache validation, CORS, cookies, authentication, throttling,
truncation, malformed responses, cancellation, and proxy security. It binds to
loopback on allocated ports and public-network fallback is forbidden.

Website transport scenarios assert the full policy matrix: direct browser
success makes no proxy request; only a classified CORS or network failure can
cause automatic metadata proxy fallback; the fallback has no per-attempt consent prompt;
and the website reports direct browser fetch and metadata CORS proxy transport
states and transitions.
Proxy opt-out must produce no new proxy request. Authentication, authorization,
ordinary HTTP, parse, and decode failures do not activate the proxy, nor do
private, local, signed, token-bearing, or otherwise credential-requiring
metadata requests; tile requests never use the proxy at all. Request
transcripts verify that both the browser-to-proxy and
proxy-to-upstream legs contain no cookies, `Authorization`, or browser
credentials, including across redirects.

Live checks use no source-site credentials, bounded targets, low request rates,
and redacted reports. A live failure never replaces deterministic regression
coverage or blocks an ordinary pull request.

## Representative workflows

### Extension cookies and Native Messaging

```sh
cargo xtask test extension --browser chromium --scenario authenticated-fetch
cargo xtask test native-messaging --scenario cookie-handoff
cargo xtask test scenario --scenario extension/cookie-scope-redirect
```

Verify exact-origin permission, explicit consent, path and expiry scope,
one-use handoff, no proxy request, no intentional persistence, redacted
artifacts, and process/profile/registration cleanup. Native Messaging scenarios also
verify that browser enforcement of allowed extension IDs accepts the configured
extension sender and rejects other IDs. Reused, expired, or cross-session
challenges or nonces are rejected as replay or session-binding failures; tests
never treat the challenge or nonce as identity proof.

### Browser tainted canvas

```sh
cargo xtask test browser --scenario cors-denied-display
cargo xtask test web --scenario tainted-display-canvas
```

Verify the image remains visible, `originClean` becomes false, browser save
guidance remains available, and app code performs no pixel read, processing,
hash, persistence, `toBlob`, `toDataURL`, or clean programmatic save. Only the
controlled assertion reads the canvas and expects `SecurityError`.

## Cross-runtime guarantees

Scenario traces are normalized across runtimes. Capability differences may
select different branches, but equivalent commands and effect results produce
equivalent job states, error codes, and recovery actions. Release candidates
pass the compatibility matrix in [Releases](releases.md); security-sensitive
scenarios follow [Security](security.md).
