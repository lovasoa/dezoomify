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
packaging and browser end-to-end suites. `cargo xtask check` also runs the
workspace TypeScript compiler gate; every workspace package with a `typecheck`
script compiles from the locked root TypeScript dependency. `cargo xtask test all` runs every
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
| `wasm` | WASM portability, freshly generated Node bindings executed through dispatch/drain/buffer/dispose, transcripts, and memory ownership |
| `browser` | workers, transports, decoding, canvases, caching, and browser harness |
| `ui` | shared UI controller, view rendering, static accessibility contracts, four-locale message dictionary, and mobile CSS contracts |
| `web` | website direct-first transport, metadata CORS proxy fallback, and cross-browser end-to-end behavior |
| `native` | native runtime, CLI, encoders, cache, and scenario parity |
| `desktop` | Tauri integration, canonical command registration, disabled-updater fixtures, and a mounted production-frontend integration smoke; `--e2e-window` drives the real webview |
| `extension` | fresh generated-WASM worker contract, manifests, scanning, browser-session fetch, permissions, shared-UI vendoring with web-vs-extension job-card parity, store size gate, and browser E2E |
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
accessibility-contract checks over a minimal DOM, theme CSS, the extension page shell,
and the shared confirm dialog), `test/ui-i18n.test.mjs` (four-locale
dictionary coverage with per-key English fallback; the extension renders
through its vendored dictionary mirror with
no local replica), and `test/ui-mobile.test.mjs` (560/380px parity over the
canonical theme the extension page links, and static 360px CSS reachability invariants). It is
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
| `check` | project-wide static verification: formatting, clippy, TypeScript compilation, generated artifacts, architecture, content, and supply-chain checks |
| `rust` | core, protocol, job, native, desktop, task-runner, and fixture-server Rust unit and contract tests |
| `wasm` | WASM adapter portability and transcript suites |
| `browser` | browser-runtime unit matrix |
| `web` | website integration suites (unit + Chromium Playwright E2E) |
| `native` | native runtime and CLI suites |
| `desktop` | desktop shell suites |
| `extension` | extension unit, manifest, and Native Messaging API suites |
| `protocol` | protocol contract suites |
| `security` | protocol artifact checks plus JS supply-chain audits over the workspace and isolated E2E profiles; Rust cargo-deny policy runs once in the required `check` lane |

`cargo xtask ci local` runs all lanes listed above. Lanes that need
installed browsers fail closed when an engine binary is missing instead of
claiming full platform coverage on a narrowed run. Required CI and `test all`
execute the controlled website E2E in Chromium, the engine provisioned in
`.github/workflows/ci.yml`.
Only GPU-dependent paths may report a narrowed scope for a missing GPU; the
deterministic canvas/worker E2E uses software rendering and never narrows.
Required CI and `test all` remain deterministic; scheduled/manual live CI
invokes `test live` separately.

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
CSP with `wasm-unsafe-eval` for the page core), explicit-action job state with
finite source-operation dispatch (no reload, no persistent collector, stop on
second-click/close/navigate, worker restart fails closed), candidate caps and
windowing, browser-session fetch
scoping, and handoff envelope validation with replay/expiry/origin rejection
and zero side effects on rejection. These gates run the unit suites plus a
hermetic headless browser E2E in both engines. Chromium runs under
Playwright; Firefox under Selenium/geckodriver (binary via
`DEZOOMIFY_FIREFOX_BIN`, a system install, or the Playwright cache; deps
auto-install via npm on first run). Full user-facing UI flows remain manual
or CI-runner work.

Browser chrome cannot be clicked headlessly, so the toolbar lifecycle is
covered by unit harnesses driving the real background module with
production-faithful fakes through job readiness, finite snapshot/fetch
dispatch, stale-generation rejection, error-badge presentation, and every
disarm rule. The headless E2E runs the actual in-browser job flow in both
engines over the loopback fixture-server with an E2E-only exact-origin host
grant: the background snapshots the tab's retained performance timeline, the
job tab performs WASM discovery,
fetches tiles, assembles, and saves, with the saved PNG verified against the
fixture pyramid. A CORS-blocked fixture asserts tainted display-only with no
pixel reads (`originClean` false, `<img>` visible, no
`toBlob`/`toDataURL`/hashing), and a cookie/auth fixture asserts the pass
through tab-context fetch.

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

### Desktop development surface

The default desktop lane also runs a loopback-only development-surface smoke
test. It starts the real Vite command used by `cargo xtask dev desktop`, checks
that the HTML entrypoint is reachable, and follows the entrypoint's shared
theme import through Vite. This keeps the fast lane display-free while
catching the class of startup and asset-resolution failures that a lean
Tauri-driver stub cannot observe.

### Desktop real window

```sh
cargo xtask test desktop --e2e-window
```

The real-window lane drives the shipped window shell with tauri-driver against
hermetic loopback fixtures. It keeps only the user journeys that need a real
window: submit to a granted destination and byte-exact PNG output, cancellation
without an output, and a deep link that cannot start or save until confirmed.
The native pipeline and format matrix are covered by the Rust scenario and CLI
suites; duplicating them through the window adds time without covering a
distinct UI boundary.

The lane is Linux-only because it requires WebKitWebDriver. `cargo xtask test
desktop --e2e-window` explicitly asks Cargo to build both the window shell and
the fixture server, so it always uses current sources rather than an existing
executable. It runs one spec under a ten-minute ownership deadline. Bare `test
desktop` stays lean and display-free.

Desktop CI is path-gated. The Ubuntu `window-e2e` job installs WebKitWebDriver
and runs the real lane under Xvfb. The separate `bundle-smoke` matrix still
performs actual release build, install when the host provides the installer
tools, and launch smoke on Ubuntu, macOS, and Windows. Those platform smokes
are not presented as window E2E coverage and do not install browser drivers or
pass expected driver failures.

## Cross-runtime guarantees



Scenario traces are normalized across runtimes. Capability differences may
select different branches, but equivalent commands and effect results produce
equivalent job states, error codes, and recovery actions. Release candidates
pass the compatibility matrix in [Releases](releases.md); security-sensitive
scenarios follow [Security](security.md).
