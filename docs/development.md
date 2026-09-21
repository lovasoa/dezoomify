# Development

One monorepo: Rust crates, generated WASM bindings, shared UI, hosts, extension packaging, and release tooling change together. Run tasks from the root through `cargo xtask`; direct Cargo/pnpm commands serve component debugging only. Node 24 minimum.

## Working areas

- `crates/dezoomify-core`: pure discovery, catalogs, tile plans, processing recipes.
- `crates/dezoomify-engine`: pure state machine through finalization and cleanup.
- `crates/dezoomify-protocol`: contract source; `packages/wasm-bindings` tracks the emitted declaration.
- `crates/dezoomify-native`: native effects for CLI and Tauri.
- `crates/dezoomify-wasm`: core and job behavior for browser hosts.
- `packages/shared-ui`: shared React UI; `packages/browser-runtime`: browser workers, decoding, canvases, and saving.
- `crates/fixture-server`: controlled origins; `testdata/scenarios`: shared scenarios; `crates/xtask`: repository tasks.

Dependency direction: [Architecture](architecture.md). Task grammar: [`crates/xtask/README.md`](../crates/xtask/README.md). Test matrix: [Testing](testing.md).

## Task grammar

The canonical form is `cargo xtask <task> [target] [options]`.

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask test core
cargo xtask build web
cargo xtask dev web
```

`setup` checks Rust, Node, WASM, and wasm-bindgen tools, bootstraps pinned pnpm when needed, installs frozen workspace dependencies, and reports browser status. It installs no browser binaries or Rust toolchains. `check` runs format, lint, type checking, boundaries, generated-file checks, and manifest validation without rewriting sources.

Bare `test` is the fast aggregate (one Rust workspace run plus one combined Node unit run; no `check`, no generated bindings, no WXT output, no browsers). `test all` adds the generated WASM Node harness, website Chromium E2E, and build-dependent Chromium/Firefox extension integration. The desktop real-window test stays explicit, outside `all`. Only `test live` touches public sites.

`setup` also installs the versioned hooks: pre-commit checks Rust formatting; pre-push runs `cargo xtask ci check`, printing its log only on failure.

## Builds

`cargo xtask build <target>` output:

| Target | Output |
|---|---|
| `wasm` | real WASM artifact under `target/wasm32-unknown-unknown/` |
| `web` | full site via `scripts/build-site.mjs`: wasm adapter plus browser glue under `wasm/`, Vite bundle, help pages, deployable `dist/` tree (needs `wasm-bindgen-cli` matching `Cargo.lock`) |
| `cli` | real `dezoomify-cli` binary under `target/debug/` |
| `desktop` | lean shell always compiles; Tauri window shell (feature `tauri`) compiles with platform webview packages present; with bundler prerequisites and without `--unsigned-test`, a real bundle for the matching host (Linux `deb`, Windows `msi`/`nsis`, macOS `dmg`; see [Native apps](native-apps.md#desktop-bundles)) |
| `extension` | store-shaped Chromium and Firefox ZIPs under `target/extension/`, packed by the store-submission script |

Examples:

```sh
cargo xtask build desktop --unsigned-test
cargo xtask build extension
cargo xtask build cli
```

The browser-runtime build is `cargo xtask test browser --build-only`. Shared UI artifacts come from `build web`, `build desktop`, `build extension`; no `build browser`, `build ui`, `build native`, or `build all` aliases exist.

The TypeScript/TSX sources (`src/*.ts` plus imported shared-UI and browser-runtime sources) are the single source of truth: type-checked, unit-tested, bundled by Vite (`base: "/beta/"`). Wasm glue (`wasm/`), Vite output (`dist/`), and help pages (`help/`) are generated, never committed: `website-deploy` builds them on every `master` push (see [Operations](operations.md#website-deployment-contract)); `cargo xtask build web` builds them locally.

## Development servers

`cargo xtask dev <target>` prints URLs and cleanup instructions:

| Target | Environment |
|---|---|
| `ui` | beta app at `/beta` on `http://127.0.0.1:8081/`, for shared-UI iteration |
| `web` | full site on `http://127.0.0.1:8080/`, exactly as deployed |
| `desktop` | real Tauri dev app; fails closed naming missing webview packages |
| `extension` | WXT live reload plus Playwright Chromium with a throwaway profile; chromium only |

Both serve the assembled `dist/` tree through `scripts/dev-server.mjs` (loopback static server plus the same `POST`/`OPTIONS /api/proxy` relay Cloudflare runs; relay core lives once in `src/server/proxy.ts`). `dev web` mirrors the deployed site; `dev ui` opens the beta surface. Nothing extra installs; `cargo xtask dev web` alone gives a working app.

`dev desktop` starts the Vite server on `http://localhost:1420/`, waits for it, then launches the Tauri shell. The server is non-interactive; its whole process tree stops with the shell, including second launches forwarded to a running app.

Example: `cargo xtask dev extension --browser chromium`. Standalone deterministic origins: `cargo xtask fixtures serve --port 0`. Dev commands bind loopback only, never public resources.

## Maintenance

Protocol files derive from Rust; never hand-edit. Fixture and protocol commands are deterministic unless named `live`.

```sh
cargo xtask protocol generate
cargo xtask protocol generate --check
cargo xtask protocol check
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
```

`protocol generate` refreshes the checked-in bindings. `--check` compares against a declaration from a real WASM build in a temp dir; `protocol check` compiles the Rust contract, runs generated-package tests, and checks WASM portability. `fixtures verify` validates manifests, provenance, licenses, routes, and hashes.

One Playwright version rules repo-wide via the `pnpm.overrides` pin in root `package.json`; website E2E and the extension gate share the engine. A Playwright bump moves override plus workspace specs together.

## Releases

Release tasks consume an immutable plan; building signs and publishes nothing, verification uses public keys only. Operator steps: [Operations](operations.md#release-runbook). Versioning and gates: [Releases](releases.md).

```sh
export DEZOOMIFY_VERSION="$(cargo xtask release version)"
cargo xtask release plan [--numbered]
cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>
cargo xtask release verify --plan target/release-dist/<version>/plan.json --artifacts target/release-dist/<version>
```

Signing, notarization, deployment, store submission, and publication run as separate protected CI operations against the verified artifact digests.

## Common workflows

### Add or change a format

Follow [Contributing a format](CONTRIBUTING-format.md). In short:

1. Add core parser/plan coverage plus scenario-local payloads.
2. Run `cargo xtask fixtures verify` and `cargo xtask test core --parity`.
3. Run `cargo xtask test scenario`.

### Change the shared UI

1. Iterate under `cargo xtask dev ui`.
2. Run `cargo xtask test ui` and `cargo xtask test app-model`, then `cargo xtask test web` plus affected `test desktop` / `test extension`.
3. Run `cargo xtask build web` to catch integration and bundle-policy failures.

### Change the protocol

1. Edit Rust source and protocol fixtures only.
2. Run `cargo xtask protocol generate` and `cargo xtask test protocol`.
3. Run `cargo xtask protocol check` plus affected host targets.

### Before a pull request

`cargo xtask check` plus fast `cargo xtask test` during development, then `cargo xtask test all` and `cargo xtask ci local`. `cargo xtask test live` only for an explicit advisory compatibility sample.

## Change rules

- Domain decisions live in core/job code, never in UI or transport code.
- Effect code implements protocol effects; it never replays job policy.
- Runtime differences travel as capabilities and shared error codes.
- Behavior exercised by more than one runtime gets a shared scenario.
- Lifecycle, retry, and transport-effect policy stay in the job engine; the website's direct-first proxy eligibility stays in the web app at the root. Integrations execute supplied transport effects and report results; no hidden fallbacks, no per-attempt proxy consent flows.
- Redact credentials and sensitive URLs at every diagnostic boundary.
