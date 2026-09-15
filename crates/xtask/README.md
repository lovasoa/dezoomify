# xtask

`xtask` is the repository's canonical task runner. Run it from the repository
root as `cargo xtask <task> [target] [options]`. It invokes component tools
through argument arrays, propagates failures, and owns cleanup for child
processes, temporary profiles, servers, and integration registrations.

## Commands

```text
cargo xtask setup
cargo xtask check
cargo xtask test [core|protocol|job|wasm|browser|ui|web|native|scenario|desktop|extension|perf|native-messaging|live|all] [options]
cargo xtask build <wasm|web|cli|desktop|extension> [options]
cargo xtask dev <ui|web|desktop|extension> [options]
cargo xtask ci <check|rust|wasm|browser|web|desktop|extension|protocol|security|local|digest> [--check <hex>]
cargo xtask release version
cargo xtask release plan [--numbered]
cargo xtask release build --plan <path> --target <target>
cargo xtask release verify --plan <path> --artifacts <path>
cargo xtask release publish --plan <path> --artifacts <path>
cargo xtask protocol <generate|check> [options]
cargo xtask fixtures <verify|serve|capture> [options]
```

With no target, `test` runs `cargo test --workspace` exactly once with terse
output, generates help pages, then runs one Node dot-reporter process over the
website, browser runtime, protocol TypeScript, desktop Node, and pure extension
unit suites. It does not run `check`, generated WASM bindings, WXT packaging, or
browsers. `test all` runs that aggregate once, then adds the generated WASM Node
harness, website Chromium E2E, and build-dependent extension units plus
Chromium/Firefox headless E2E. The desktop real-window test stays explicit and
outside `all`. `test live` is the only target allowed to contact public source
sites and is never part of `all`, required CI, or release gates.

Node 24 is the minimum supported Node version. Direct Cargo and pnpm commands
are valid for focused debugging, but xtask remains the unified front door.

`check`, all maintenance `check`/`verify` commands, and protocol golden checks
are read-only. `protocol generate` is the explicit generated-source update;
golden candidates require its explicit maintenance option. Builds write only to
declared generated paths, `target/`, `dist/`, or `artifacts/` as appropriate.
Release verification checks the frozen plan and expected artifacts.

## Examples

```sh
cargo xtask setup
cargo xtask check
cargo xtask test scenario
cargo xtask build desktop --unsigned-test
cargo xtask dev extension --browser chromium
cargo xtask ci local
cargo xtask protocol generate --check
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
```

## Stable CLI surface

The task, target, lane, and flag vocabulary above is stable: scripts and
workflows may rely on it. Unknown tasks, targets, lanes, and flags always
fail with a usage error instead of succeeding as no-ops or silently
widening coverage (for example `cargo xtask build bogus`,
`cargo xtask test core --bogus`, and `cargo xtask ci bogus` all fail).
`crates/xtask/tests/cli_surface.rs` pins this contract end to end against
the built binary; unit tests in `src/main.rs` pin the dispatcher.

## Package managers

The Node 24 pnpm workspace (`packageManager` in the root `package.json`,
`pnpm-workspace.yaml`) owns every active JavaScript package, including the
webapp, extension, and desktop E2E harnesses. The root `pnpm-lock.yaml` is the
only active JavaScript lockfile. Playwright browser binaries remain separate
from package installation and are installed explicitly by the E2E workflows.
The supply-chain gate audits the complete workspace lockfile. Legacy package
managers remain only in the historical `legacy/` tree. `wasm-bindgen-cli` is
version-coupled to `Cargo.lock` in every workflow via
`.github/actions/setup-wasm-bindgen`, and `cargo xtask setup` verifies the
installed version matches.

## Boundaries

- Depend on workspace metadata, protocol/schema generators, and tooling
  libraries; invoke app tools without linking app internals when a
  process boundary suffices.
- Do not contain runtime app behavior, hide mutation in checks, contact the
  public network from deterministic tasks, or duplicate policy in CI scripts.
- Test argument parsing, fixed target/lane allowlists, deterministic and
  idempotent generation, check-mode clean diffs, cleanup, and failure
  propagation.

## CI ownership

CI lanes are disjoint: `check` owns static contracts, `rust` owns one workspace
Cargo test run, `wasm` owns the generated Node harness, `browser` owns
browser-runtime Node tests, `web` owns website Node tests plus Chromium E2E,
`desktop` owns desktop Node tests, `extension` owns generated-package units and
Chromium/Firefox E2E, `protocol` owns protocol TypeScript tests, and `security`
owns the JavaScript audit. Cargo policy stays in `check`. Native and scenario
tests have no separate CI rerun because the Rust workspace lane includes them;
the path-gated desktop workflow owns desktop coverage when applicable.
