# Development

The repository is one monorepo. Rust crates, generated protocol artifacts,
The shared UI, hosts, extension packaging, and release tooling change together.
Run repository tasks from the root through `cargo xtask`; use direct Cargo or
pnpm commands only when debugging the task runner or a component-specific test.

## Working areas

- `crates/dezoomify-core` contains pure discovery, catalogs, tile plans, and
  processing recipes.
- `crates/dezoomify-job` contains the pure effect/state machine through output
  finalization and cleanup.
- `crates/dezoomify-protocol` is the Rust protocol source for the schema and
  `packages/protocol-ts`.
- `crates/dezoomify-native` contains native effects used by CLI and Tauri.
- `crates/dezoomify-wasm` adapts core and job behavior for browser hosts.
- `packages/shared-ui` is the shared UI; `packages/browser-runtime` owns
  browser workers, decoding, canvases, and bounded caching.
- `crates/fixture-server` serves controlled origins, `testdata/scenarios`
  contains shared scenarios, and `crates/xtask` owns repository tasks.

The exact dependency direction is in [Architecture](architecture.md).

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

`setup` installs pinned repository-managed Rust, pnpm, WASM, and browser test
dependencies and is safe to rerun. `check` runs formatting, lint, type checking,
dependency boundaries, generated-file checks, and manifest validation without
rewriting source files.

Bare `test` is the fast deterministic unit and contract loop. `test all` runs
the full deterministic suite. Focused targets are documented in
[Testing](testing.md). No test other than `test live` contacts public source
sites.

## Builds

`cargo xtask build <target>` scope (honest scaffold):

| Target | Output |
|---|---|
| `wasm` | real WASM artifact under `target/wasm32-unknown-unknown/` |
| `web` | real WASM artifact plus browser glue under `wasm/` (requires `wasm-bindgen-cli` matching the crate version), plus regenerated browser JS mirrors (see below) |
| `cli` | real `dezoomify-cli` binary under `target/debug/` |
| `desktop` | stub validation only (logic + config); no installer or bundle produced, including with `--unsigned-test` |
| `extension` | stub validation only (manifests); no ZIP packaged (use `apps/extension/scripts/package-store.sh` for a real package) |

Examples:

```sh
cargo xtask build desktop --unsigned-test
cargo xtask build extension
cargo xtask build cli
```

The browser-runtime build is `cargo xtask test browser --build-only`. Shared UI
artifacts are built by `build web`, `build desktop`, and `build extension`; there
are no separate `build browser`, `build ui`, `build native`, or `build all`
aliases.

The website ships static ES modules with no bundler, so browsers need plain
`.js`. The TypeScript sources (`src/*.ts`, the shared-UI and browser-runtime
sources they import) are the single source of truth: type-checked and
unit-tested. `node scripts/sync-web-js.mjs` regenerates the served `.js`
mirrors from them; never hand-edit a generated mirror. `cargo xtask build web`
regenerates the mirrors and `cargo xtask check` fails when they drift.

## Development servers

`cargo xtask dev <target>` starts one watch-mode environment and prints its
allocated URLs and cleanup instructions:

| Target | Environment |
|---|---|
| `ui` | isolated shared UI |
| `web` | website with deterministic local services |
| `desktop` | Tauri development application |
| `extension` | extension watch build and isolated test profile |

For example, use `cargo xtask dev extension --browser firefox` or
`cargo xtask dev web`. Start standalone deterministic origins with
`cargo xtask fixtures serve --port 0`. Development commands bind local services
to loopback and never fall back to public resources.

## Maintenance

Generated protocol files are derived from Rust and are never edited by hand.
Fixture, source, and parity commands are deterministic unless their name
explicitly says `live`.

```sh
cargo xtask protocol generate
cargo xtask protocol generate --check
cargo xtask protocol check
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
cargo xtask sources verify
cargo xtask parity validate
cargo xtask parity report
```

`protocol generate` refreshes checked-in TypeScript, schema, and capability
artifacts. Its `--check` form compares against a temporary generation, while
`protocol check` runs cross-language goldens, fingerprints, portability, and
generated-marker checks. Golden candidates change only through the explicit
maintenance option reported by `protocol generate --help`. `fixtures verify`
validates manifests, provenance, licenses, routes, and hashes. `sources verify`
checks imported source locks and trees. `parity validate` checks the parity
inventory; `parity report` writes the current report under `artifacts/`.

## Releases

Release tasks consume an immutable plan. Building does not sign or publish, and
verification uses public keys only.

```sh
cargo xtask release plan 1.8.0 beta
cargo xtask release build --plan artifacts/release/1.8.0-beta.json
cargo xtask release verify --plan artifacts/release/1.8.0-beta.json --artifacts dist/
```

Signing, notarization, deployment, store submission, and publication run as
separate protected CI operations against the verified artifact digests.

## Common workflows

### Add or change a format

1. Add core parser/plan coverage and scenario-local payloads.
2. Run `cargo xtask fixtures verify` and `cargo xtask test core --parity`.
3. Run `cargo xtask test scenario --scenario <scenario-id>`.
4. Run `cargo xtask parity validate` and inspect `cargo xtask parity report`.

### Change the shared UI

1. Run `cargo xtask dev ui` while changing host-neutral components.
2. Run `cargo xtask test ui`, then the affected `test web`, `test desktop`, or
   `test extension` integration target.
3. Run `cargo xtask build web` to catch integration and bundle-policy failures.

### Change the protocol

1. Edit only the Rust source and protocol fixtures.
2. Run `cargo xtask protocol generate` and `cargo xtask test protocol`.
3. Run `cargo xtask protocol check` and the affected host test targets.

### Before a pull request

Run `cargo xtask check` and the fast `cargo xtask test` during development, then
`cargo xtask test all` and `cargo xtask ci local`. Run `cargo xtask test live`
only when the change needs an explicit advisory compatibility sample.

## Change rules

- Domain decisions belong in core or job code, not UI and transport code.
- Effectful code implements protocol effects; it does not reproduce job policy.
- Runtime differences use capabilities and shared error codes.
- Add a shared scenario whenever more than one runtime exercises behavior.
- Keep generic lifecycle, retry, and transport-effect policy in the job engine;
  keep the website's direct-first, classified automatic metadata proxy
  eligibility policy in the web app at the repository root. App integrations execute supplied
  transport effects and report results; they never invent a hidden fallback or
  per-attempt proxy consent flow.
- Redact credentials and sensitive URLs at every diagnostic boundary.
