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
target that stops working is quarantined in
`crates/xtask/live-quarantine.json` with a reason and a last-pass date and
stays listed in the `docs/compatibility.md` dashboard, never tolerated as a
silent failure. Removal from `crates/xtask/src/live.rs` happens only when the
site is gone for good or the format is redesigned, with the reason in the
commit message. `cargo xtask test live --dry-run --fixtures` validates the
34-target list plus quarantine with no network; `cargo xtask test live
--public --quarantine --report-only` is the nightly advisory full-34 run that
never blocks pull requests.

Focused targets are:

| Target | Coverage |
|---|---|
| `core` | pure format discovery, catalogs, grids, and processing recipes |
| `protocol` | Rust/TypeScript schema, goldens, fingerprints, redaction, current/N-1 |
| `job` | commands, effects, retries, progress, cancellation, and cleanup |
| `wasm` | WASM portability, bindings, transcripts, and memory ownership |
| `browser` | workers, transports, decoding, canvases, caching, and browser harness |
| `ui` | shared UI controller, view rendering, accessibility gate, four-locale message dictionary, and mobile CSS parity |
| `web` | website direct-first transport, metadata CORS proxy fallback, and cross-browser end-to-end behavior |
| `native` | native runtime, CLI, encoders, cache, and scenario parity |
| `desktop` | Tauri integration, integration registration, disabled-updater fixtures, and E2E |
| `extension` | manifests, scanning, browser-session fetch, permissions, shared-UI vendoring with web-vs-extension job-card parity, store size gate, and browser E2E |
| `native-messaging` | framing, handoff consent, cookie scope, registration, and cleanup |
| `scenario` | scenario-corpus gates: native pipeline scenarios over loopback plus CLI snapshots |
| `perf [--smoke]` | native pool plus streaming plus backpressure benches (criterion `native_pipeline`: tile throughput, encode time, peak RSS on the 20k model) with CI tracking that fails beyond 20 percent regression |
| `live` | explicit low-volume public-network compatibility checks |
| `all` | every deterministic focused target; excludes `live` |

Use the narrowest owning target first. Focus with supported flags such as
`--purity`, `--parity`, `--transcripts`, and `--browser <name>`. Targets that
accept no options (for example `native`, `extension`, `scenario`) reject unknown
flags instead of silently widening or skipping coverage.

## Test locations

`test/` (singular, repository root) is the canonical fast website unit suite:
`node:test` files (`test/*.test.mjs`). It runs via
`node --test test/*.test.mjs` and the `web` and `build web` gates. The `ui`
gate runs the shared-UI subset plus its gates: `test/controller.test.mjs`,
`test/view-rendering.test.mjs`, `test/ui-a11y.test.mjs` (static
accessibility gate over rendered views, theme CSS, the extension page shell,
and the shared confirm dialog), `test/ui-i18n.test.mjs` (four-locale
dictionary coverage with per-key English fallback; the extension renders
through its vendored dictionary mirror with
no local replica), and `test/ui-mobile.test.mjs` (560/380px parity over the
canonical theme the extension page links, and 360px reachability). It is
tracked and always present.

`e2e-artifacts/` (repository root) is not a suite and never runs in any
`cargo xtask test` or `cargo xtask ci` lane. It holds only untracked
Playwright residue: ignored `node_modules/` and
`test-results/.last-run.json` plus an empty `fixtures/remote/` directory
tree with no fixture bytes. It has no `package.json`, no specs, and no
Playwright config. Do not add files here; the canonical suites are `test/`
and `crates/fixture-server/tests/`. See `e2e-artifacts/README.md`. Real fixtures
live in `testdata/scenarios`. The directory was renamed from `tests/`
(plural): root `test/` (singular) versus `tests/` (plural) was a permanent
footgun, so no root `tests/` directory may be recreated.

`crates/fixture-server/tests/` is the canonical fixture-server gate:
`http_contract.rs` and `security.rs` (plus `common/mod.rs`) are Rust
integration tests over loopback and run via
`cargo test -p dezoomify-fixture-server` (also in bare `cargo xtask test`
via the `cargo-test` step); `webapp-e2e/` is the Playwright cross-browser
job (`webapp.spec.js`, `playwright.config.js`, `package.json`, one project
per engine: `chromium`, `firefox`, `webkit`) with its own
ignored `node_modules/`, `test-results/`, and `downloads/`, and runs via
`cargo xtask test web --e2e [--browser <chromium|firefox|webkit|all>]`
(default `chromium`; `all` runs every engine in one fixture-server setup)
and the `--browser` legs of `test browser` and `test wasm`.

Other suites keep their own directories and never use a root residue
directory: `packages/browser-runtime/test/`, `packages/protocol-ts/test/`,
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
| `web` | website integration suites (unit + cross-browser Playwright E2E: chromium, firefox, and webkit) |
| `native` | native runtime and CLI suites |
| `desktop` | desktop shell suites |
| `extension` | extension unit, manifest, and Native Messaging API suites |
| `protocol` | protocol contract suites |
| `security` | protocol artifact checks plus the supply-chain gate (cargo deny over advisories/licenses/bans/sources and JS audits over the workspace and isolated E2E profiles) |

`cargo xtask ci local` runs all lanes listed above. Lanes that need
installed browsers fail closed when an engine binary is missing instead of
claiming full platform coverage on a narrowed run: the `web` lane runs the
E2E on every engine (`--browser all`) and CI installs chromium, firefox,
and webkit (see `.github/workflows/ci.yml`). Only GPU-dependent paths may
report a narrowed scope for a missing GPU; the deterministic canvas/worker
E2E uses software rendering and never narrows. Required CI and `test all` remain
deterministic; scheduled/manual live CI invokes `test live` separately.

## Network coverage

`crates/fixture-server` provides hermetic HTTP fixtures for redirects, ranges,
compression, cache validation, CORS, cookies, authentication, throttling,
truncation, malformed responses, cancellation, and proxy security. It binds to
loopback on allocated ports and public-network fallback is forbidden.

Website transport scenarios assert the full policy matrix: direct browser
success makes no proxy request; only a classified CORS or network failure (or a
direct fetch that does not complete within the 1500 ms metadata window) can
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

Live checks use no private source-site credentials (the Memorix demo key comes
from `DEZOOMIFY_MEMORIX_API_KEY` and stays `REDACTED` in source and logs;
public demo keys embedded in fixture URLs are allowed only inside
`testdata/scenarios` with `review:*` sensitivity), bounded targets, low request
rates, and redacted reports. The five most failure-prone live shapes carry
deterministic fixture-server recordings under `testdata/scenarios/web/live-*`
with core breadth in `testdata/scenarios/rs-core/formats`, so the
deterministic suite covers real shapes without network. A live failure never
replaces deterministic regression coverage; quarantined targets never block an
ordinary pull request (see [Compatibility](compatibility.md)).

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
automatic 1500 ms direct-metadata timeout. Cross-browser E2E runs under
`test web --e2e --browser all` (chromium, firefox, webkit in one
fixture-server setup; `cargo xtask ci web` runs the same legs); a missing
engine binary fails the run with its install hint, never a narrowed pass.

### Desktop real window

```sh
cargo xtask test desktop --e2e-window
```

The real-window gate launches the window shell under tauri-driver
and drives it with selenium-webdriver against hermetic loopback fixtures:
submit URL, destination grant through the fail-closed E2E fixed-destination
hook, byte-exact save versus the `native/cli-dzi` golden, cancel with output
cleanup, an existing-destination refusal with its stable code, and the
deep-link confirm gate (pending links perform no effect). Bare
`test desktop` stays lean and display-free; the window lane is opt-in.
Prerequisites fail closed with install hints: a display (`xvfb-run -a`
outside CI), tauri-driver 2.x (`cargo install tauri-driver --version "=2.0.6"`
or `TAURI_DRIVER_BIN`), WebKitWebDriver (`WEBKIT_DRIVER_BIN` override), and
the webview system packages. Ports are ephemeral except the loopback static
server for the built frontend, which the debug window shell loads from its
embedded devUrl address. Reports carry origins, hashes, and codes only.
See [Native apps](native-apps.md#desktop) for the hook contract.

CI runs the lane in `.github/workflows/desktop.yml` (matrix
ubuntu/macos/windows, `fail-fast: false`). Linux runs the lane for real
under Xvfb with the `webkit2gtk-driver` apt package and pinned tauri-driver
2.0.6, and uploads the lane log (redacted reports included) as the
`desktop-e2e-ubuntu-latest` artifact. macOS enables `safaridriver` and
Windows installs `msedgedriver` pinned to the runner's Edge (fail closed on
mismatch, both versions named), then each runs the lane as a block-evidence
gate: the lane and harness are Linux-only by code, so those legs pass on a
real lane pass or on that exact documented guard and fail closed on anything
else. The macOS/Windows wave must teach the lane preflight plus the harness
native-driver slot. The same workflow then bundle-smokes every leg (Linux
`dpkg -i` with sudo plus a timed stay-alive launch, macOS `dmg` mount plus
direct-binary exec with Gatekeeper/SIP untouched, Windows `nsis` `/S`
silent install or the documented direct-exe fallback) and uploads the
`desktop-bundle-smoke-<os>` logs; smokes never run before the E2E legs, so a
smoke failure cannot fail the E2E signal spuriously. The updater stays inert
in all of this (empty pubkey, plugin not registered): no update flow is
exercised.

## Cross-runtime guarantees

Scenario traces are normalized across runtimes. Capability differences may
select different branches, but equivalent commands and effect results produce
equivalent job states, error codes, and recovery actions. Release candidates
pass the compatibility matrix in [Releases](releases.md); security-sensitive
scenarios follow [Security](security.md).
