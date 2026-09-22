# Testing

Tests are deterministic unless the command says `live`. Shared scenarios in `testdata/scenarios` describe resources, capabilities, commands, effect results, transitions, events, outputs, and errors. Parity behavior has blocking deterministic coverage; live diagnostics never substitute.

Deterministic suites use fixed fixture bytes, stable ordering, explicit seeds, controlled time, no public DNS or network. Platform-specific deterministic tests and manual release checks supplement that contract, never weaken it. Task grammar: [`crates/xtask/README.md`](../crates/xtask/README.md).

## Main commands

Run repository tests from the root through `cargo xtask`:

```sh
cargo xtask check
cargo xtask test
cargo xtask test web --e2e
cargo xtask test extension
cargo xtask test all
```

Node 24 is the minimum supported Node version. Direct Cargo and pnpm commands are valid for debugging an individual component, but `cargo xtask` remains the unified front door and defines repository coverage.

Bare `cargo xtask test` is the fast aggregate:

1. One `cargo test --workspace` run, quiet Cargo output, terse libtest format.
2. Help-page generation, then one Node dot-reporter process over website, browser runtime, desktop Node, and pure extension unit suites.

It never runs `check`, generates bindings, builds WXT packages, or launches a browser.

`cargo xtask test all` runs the fast aggregate once, then adds the fresh WASM Node harness, website Chromium Playwright E2E, and remaining extension tests needing generated WASM/WXT packages (Chromium plus Firefox headless E2E). It re-invokes no focused aliases, so it repeats neither the fast Rust nor the Node matrix. It excludes public-network tests and the desktop real-window test.

`cargo xtask ci local` combines `check`, `test all`, the protocol's no-default-features WASM portability check, and the JavaScript dependency audit. It runs the shared suites once instead of replaying the overlapping distributed CI lanes.

`cargo xtask test web --e2e` adds Chromium Playwright to the website suite. `cargo xtask test extension` is the full extension gate: current WASM bindings, Chromium plus Firefox WXT output, all extension units, both browsers headless. The extension package's own `pnpm test` / `pnpm test:unit` run pure units only, needing neither generated output nor browsers.

## Focused targets

Focused aliases remain available for iteration:

| Target | Coverage |
|---|---|
| `core [--purity\|--parity]` | core crate, with optional purity or format-parity focus |
| `protocol` | generated-artifact comparison, Rust and TypeScript contracts, and WASM portability |
| `job [--transcripts]` | job engine, with optional workflow/transcript focus |
| `wasm [--browser chromium]` | WASM adapter and generated Node harness; optional Chromium website E2E |
| `browser [--build-only\|--browser chromium\|--scenario <id>]` | browser-runtime Node contracts; a browser selection adds website Chromium E2E |
| `ui` | shared-UI snapshot presentation and product-agnostic view contract |
| `app-model` | host-neutral service, snapshot predicates, history, labels |
| `web [--e2e]` | website Node suite; `--e2e` adds Chromium Playwright |
| `native` | native runtime and CLI Rust suites |
| `desktop [--e2e-window]` | desktop Rust and Node suites; the option runs the explicit real-window gate instead |
| `extension` | generated WASM/WXT, all extension units, and Chromium plus Firefox headless E2E |
| `native-messaging` | framing, scope, registration, and cleanup contracts for the standalone host |
| `scenario` | CLI snapshots and native scenario/loopback integration tests |
| `perf [--smoke]` | native pipeline performance smoke and tracked benches |
| `live` | explicit, advisory public compatibility checks |
| `all` | fast aggregate plus build-dependent WASM, website, and extension integration |

Use the narrowest owning target first. Targets reject unknown options instead of silently changing coverage.

## Test locations

- `test/`: website and shared UI Node suite. Tests import `.ts` directly (Node strips types); the TSX loader transpiles `.tsx` React sources only; xtask generates ignored help pages before tests needing them.
- `packages/browser-runtime/test/`, `apps/desktop/tests/`, `apps/extension/tests/unit/`: package-owned Node suites.
- `packages/wasm-bindings`: TypeScript compiled against the tracked declaration; spelling is no runtime test subject.
- `packages/wasm-harness/`: fresh Node bindings, used in focused, `all`, and WASM CI lanes only.
- `crates/fixture-server/tests/webapp-e2e/`: Chromium Playwright website E2E; serves current website/WASM output over loopback.
- `apps/extension/tests/browser/`: store-shaped Chromium and Firefox packages over loopback.
- `crates/*/tests/`, `apps/*/tests/`: Rust and app integration tests; shared data stays under `testdata/scenarios`.
- `e2e-artifacts/`: untracked residue, never a suite, never run from xtask or CI.

## CI lanes

`cargo xtask ci <lane>` is the fixed CI entry point. The lanes have disjoint ownership:

| Lane | Scope |
|---|---|
| `check` | Rust formatting, Clippy, Biome, TypeScript compilation, architecture, generated artifacts, content, Cargo policy, and other static contracts |
| `rust` | one `cargo test --workspace` run |
| `wasm` | generated WASM Node harness |
| `browser` | browser-runtime Node suite |
| `ui` | shared-UI snapshot presentation and view contract |
| `app-model` | host-neutral model Node suite |
| `web` | website Node suite plus Chromium Playwright E2E |
| `desktop` | desktop Node suite; the path-gated desktop workflow owns desktop testing when applicable |
| `extension` | full generated-package extension unit and Chromium/Firefox E2E gate |
| `protocol` | binding drift, generated declaration, Rust contract, and WASM portability |
| `security` | JavaScript workspace audit; Cargo policy belongs to `check` |

There are no separate native or scenario CI lanes: the Rust workspace lane already owns those tests. Central CI runs applicable lanes in parallel groups; desktop JavaScript coverage stays with the path-gated desktop workflow. `cargo xtask ci local` runs every lane serially. Required CI and `test all` stay deterministic; scheduled or manual live CI is separate.

## Fixture harness

`crates/fixture-server` serves the scenario corpus on allocated loopback ports. A payload at `payloads/{host}{url-path}` maps to `{host}{url-path}`, content type inferred from extension. `routes.json` records only exceptions: non-`200` statuses, extra headers, redirects, query/wildcard matches, generators, non-mirrored payload names.

```sh
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0
```

Review payload, route, manifest, hash, transcript, and pixel changes before accepting them. Tests use ephemeral ports and allocated addresses, never fixed shared ports. See `testdata/scenarios/README.md` for scenario maintenance.

## Network and security

The fixture server covers redirects, ranges, compression, cache validation, CORS, cookies, auth, throttling, truncation, malformed responses, cancellation, and proxy security. Deterministic tests bind loopback only, never public network.

Website transport tests pin direct-first: success makes no proxy request. Only classified CORS/network failure or the 1500 ms window activates proxy fallback, with no per-attempt consent; transport states and transitions are pinned too. Auth, ordinary HTTP, parse, and decode failures never activate it. Private, local, signed, token-bearing, or credential-requiring metadata is ineligible; tiles never use the proxy. Proxy tests pin credential stripping and the narrow header allowlist on both legs, plus manual redirect handling revalidating every hop. Canonical policy: [Browser runtime](browser-runtime.md#request-order). Proxy controls: [Security](security.md#proxy-controls).

Extension tests pin narrow grants, no remote code, required CSP, explicit-action scans, finite capped operations, session fetch scope, and lifecycle cleanup. Chromium covers optional-host, authenticated fetch, and partial flows; both browsers run the packaged end-to-end job. Tainted-display tests keep `<img>` display visible while guarding pixel reads, hashing, `toBlob`, and `toDataURL` without readable bytes. Contract: [Extension](extension.md).

Live checks use no private credentials, bounded counts and rates, redacted reports. Memorix demo key: `DEZOOMIFY_MEMORIX_API_KEY`; fixture demo keys need `review:*` sensitivity. Public checks run only via `cargo xtask test live --public`; `cargo xtask test live --dry-run --fixtures` validates the inventory with no network. Quarantined targets stay visible in `crates/xtask/live-quarantine.json` and [Compatibility](compatibility.md), never silent failures or PR blockers. Failure-prone live shapes have deterministic recordings in the corpus. A target leaves only when the site is gone or the format is redesigned, reason in the commit.

## Desktop window

```sh
cargo xtask test desktop --e2e-window
```

This explicit lane builds current frontend, fixture server, and Tauri shell with its embedded W3C WebDriver server, then verifies real save, cancellation, confirmed handoff, and partial journeys. Excluded from bare `test`, `test all`, and `cargo xtask ci local`. Linux needs `xvfb-run -a`; macOS and Windows use GUI sessions. The path-gated desktop workflow runs it on all three OSes plus bundle smoke. Native mechanism: [Native apps](native-apps.md#real-window-e2e-hook).

## Cross-runtime guarantees

Scenario traces normalize runtime-specific details. Capabilities choose branches, but equal commands and effect results give equal job states, error codes, and recovery actions. Release candidates pass the matrix in [Releases](releases.md); security-sensitive scenarios follow [Security](security.md).
