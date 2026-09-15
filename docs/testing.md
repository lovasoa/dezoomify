# Testing

Tests are deterministic unless their command explicitly says `live`. Shared
scenarios in `testdata/scenarios` describe resources, capabilities, commands,
effect results, expected transitions, protocol events, outputs, and errors.
Every parity behavior has deterministic blocking coverage; live diagnostics
never substitute for it.

Deterministic suites use fixed fixture bytes, stable ordering, explicit seeds,
controlled time, and no public DNS or network. Platform-specific deterministic
tests and manual release checks supplement, but do not weaken, that contract.

## Main commands

Run repository tests from the root through `cargo xtask`:

```sh
cargo xtask check
cargo xtask test
cargo xtask test web --e2e
cargo xtask test extension
cargo xtask test all
```

Node 24 is the minimum supported Node version. Direct Cargo and pnpm commands
are valid for debugging an individual component, but `cargo xtask` remains the
unified front door and defines repository coverage.

Bare `cargo xtask test` is the fast aggregate. It performs exactly:

1. One `cargo test --workspace` invocation, using quiet Cargo output and
   libtest's terse format.
2. Help-page generation followed by one Node test process, using the dot
   reporter, over the website, browser runtime, generated protocol TypeScript,
   desktop Node, and pure extension unit suites.

The native Rust and Node runners keep successful output compact and print
detailed failing tests. The fast aggregate never runs `cargo xtask check`,
generates WASM bindings, builds WXT packages, or launches a browser.

`cargo xtask test all` runs the fast aggregate once, then adds the freshly
generated WASM Node harness, website Chromium Playwright E2E, and the remaining
extension tests that require generated WASM/WXT packages, including Chromium
and Firefox headless E2E. It does not invoke focused aliases again, so it does
not repeat the fast Rust or Node matrix. It excludes public-network tests and
the desktop real-window test.

`cargo xtask test web --e2e` runs the website Node suite and its Chromium
Playwright E2E. `cargo xtask test extension` is the full extension integration
gate: it generates current WASM bindings, builds WXT output for Chromium and
Firefox, runs all extension units, and drives both browsers headlessly. By
contrast, the extension package's `pnpm test` and `pnpm test:unit` scripts run
only pure unit tests and require neither generated output nor browsers.

## Focused targets

Focused aliases remain available for iteration:

| Target | Coverage |
|---|---|
| `core [--purity\|--parity]` | core crate, with optional purity or format-parity focus |
| `protocol` | generated-artifact comparison, Rust and TypeScript contracts, and WASM portability |
| `job [--transcripts]` | job engine, with optional workflow/transcript focus |
| `wasm [--transcripts\|--browser chromium]` | WASM adapter and generated Node harness; optional Chromium website E2E |
| `browser [--build-only\|--browser chromium\|--scenario <id>]` | browser-runtime Node contracts; a browser selection adds website Chromium E2E |
| `ui` | shared UI controller, rendering, accessibility, localization, and mobile contracts |
| `web [--e2e]` | website Node suite; `--e2e` adds Chromium Playwright |
| `native` | native runtime and CLI Rust suites |
| `desktop [--e2e-window]` | desktop Rust and Node suites; the option runs the explicit real-window gate instead |
| `extension` | generated WASM/WXT, all extension units, and Chromium plus Firefox headless E2E |
| `native-messaging` | framing, consent, scope, registration, and cleanup contracts |
| `scenario` | CLI snapshots and native scenario/loopback integration tests |
| `perf [--smoke]` | native pipeline performance smoke and tracked benches |
| `live` | explicit, advisory public compatibility checks |
| `all` | fast aggregate plus build-dependent WASM, website, and extension integration |

Use the narrowest owning target first. Targets reject unknown options instead
of silently changing coverage.

## Test locations

- `test/` is the website and shared UI Node suite. The TSX loader imports React
  sources directly, and xtask generates ignored help pages before tests that
  consume them.
- `packages/browser-runtime/test/`, `packages/protocol-ts/test/`,
  `apps/desktop/tests/`, and `apps/extension/tests/unit/` are package-owned Node
  suites.
- `packages/wasm-harness/` consumes freshly generated Node bindings only in its
  focused, `all`, and WASM CI lanes.
- `crates/fixture-server/tests/webapp-e2e/` is the Chromium Playwright website
  E2E harness. It builds and serves current website/WASM output over loopback.
- `apps/extension/tests/browser/` drives store-shaped Chromium and Firefox
  packages over loopback.
- `crates/*/tests/` and `apps/*/tests/` contain Rust and app integration tests;
  shared fixture data remains under `testdata/scenarios`.
- `e2e-artifacts/` is untracked residue, not a suite, and never runs from xtask
  or CI. Do not add canonical tests or fixture bytes there.

## CI lanes

`cargo xtask ci <lane>` is the fixed CI entry point. The lanes have disjoint
ownership:

| Lane | Scope |
|---|---|
| `check` | formatting, clippy, TypeScript compilation, architecture, generated artifacts, content, Cargo policy, and other static contracts |
| `rust` | one `cargo test --workspace` run |
| `wasm` | generated WASM Node harness |
| `browser` | browser-runtime Node suite |
| `web` | website Node suite plus Chromium Playwright E2E |
| `desktop` | desktop Node suite; the path-gated desktop workflow owns desktop testing when applicable |
| `extension` | full generated-package extension unit and Chromium/Firefox E2E gate |
| `protocol` | protocol TypeScript suite |
| `security` | JavaScript workspace audit; Cargo policy belongs to `check` |

There are no separate native or scenario CI lanes: the Rust workspace lane
already owns those tests. The central CI workflow runs the applicable lanes in
parallel groups; desktop JavaScript coverage stays with the path-gated desktop
workflow. `cargo xtask ci local` runs every xtask CI lane serially. Required CI
and `test all` remain deterministic; scheduled or manual live CI is separate.

## Fixture harness

`crates/fixture-server` serves the scenario corpus on allocated loopback ports.
A payload at `payloads/{host}{url-path}` maps to `{host}{url-path}` with its
content type inferred from the extension. `routes.json` records only exceptions
such as non-`200` statuses, extra headers, redirects, query or wildcard matches,
generators, and non-mirrored payload names.

```sh
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0
```

Review payload, route, manifest, hash, transcript, and pixel changes before
accepting them. Tests use ephemeral ports and allocated addresses, never fixed
shared ports. See `testdata/scenarios/README.md` for scenario maintenance.

## Network and security

The fixture server covers redirects, ranges, compression, cache validation,
CORS, cookies, authentication, throttling, truncation, malformed responses,
cancellation, and proxy security. Deterministic tests bind only to loopback and
never fall back to the public network.

Website transport tests enforce direct browser fetch first: success makes no
proxy request. Only classified CORS/network failure or the 1500 ms metadata
window can activate automatic metadata CORS proxy fallback, with no per-attempt
consent prompt; tests also pin the reported transport states and transitions.
Authentication, authorization, ordinary HTTP, parse, and decode failures do not
activate it. Private, local, signed, token-bearing, or otherwise
credential-requiring metadata is ineligible, and tiles never use the proxy.
Proxy tests verify credential stripping and the narrow header allowlist on both
legs, plus manual redirect handling that revalidates every hop.

Extension tests enforce narrow grants, no remote code, the required CSP,
explicit-action scans, finite and capped source operations, browser-session
fetch scope, lifecycle cleanup, and zero side effects after handoff
replay/expiry/origin rejection. Chromium covers optional-host, authenticated
fetch, and partial-output flows; Chromium and Firefox both run the packaged
end-to-end job flow. Tainted-display tests keep ordinary image display visible
while guarding pixel reads, hashing, `toBlob`, and `toDataURL` when readable
bytes are absent.

Live checks use no private source credentials, bound request counts and rates,
and redact reports. The Memorix demo key comes from
`DEZOOMIFY_MEMORIX_API_KEY`; fixture demo keys require `review:*` sensitivity.
Run public checks only through `cargo xtask test live --public`. The no-network
`cargo xtask test live --dry-run --fixtures` validates the target inventory.
Quarantined targets remain visible in `crates/xtask/live-quarantine.json` and
[Compatibility](compatibility.md), never as silent failures or pull-request
blockers. Failure-prone live shapes have deterministic recordings in the
scenario corpus. A target leaves the inventory only when the site is gone or
the format is redesigned, with the reason recorded in the commit.

## Desktop window

```sh
cargo xtask test desktop --e2e-window
```

This explicit lane builds the current frontend, fixture server, and Tauri shell
with its embedded W3C WebDriver server, then verifies real save, cancellation,
confirmed handoff, and partial-output journeys. It is excluded from bare
`test`, `test all`, and `cargo xtask ci local`. Linux requires
`xvfb-run -a`; macOS and Windows use their GUI sessions. The path-gated desktop
workflow runs it on all three operating systems and separately performs bundle
install/launch smoke tests.

## Cross-runtime guarantees

Scenario traces normalize runtime-specific details. Capabilities may choose
different branches, but equivalent commands and effect results produce
equivalent job states, error codes, and recovery actions. Release candidates
pass the matrix in [Releases](releases.md), and security-sensitive scenarios
follow [Security](security.md).
