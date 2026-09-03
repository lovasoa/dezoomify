# xtask

`xtask` is the repository's canonical task runner. Run it from the repository
root as `cargo xtask <task> [target] [options]`. It invokes component tools
through argument arrays, propagates failures, and owns cleanup for child
processes, temporary profiles, servers, and integration registrations.

## Commands

```text
cargo xtask setup
cargo xtask check
cargo xtask test [core|protocol|job|wasm|browser|ui|web|native|desktop|extension|native-messaging|scenario|live|all] [options]
cargo xtask build <wasm|web|cli|desktop|extension> [options]
cargo xtask dev <ui|web|desktop|extension> [options]
cargo xtask ci <rust|wasm-browser|ui-web-proxy|native|desktop|extension|chromium-e2e|firefox-e2e|native-messaging|generated|security|local>
cargo xtask release plan <version> <channel>
cargo xtask release build --plan <path>
cargo xtask release verify --plan <path> [--artifacts <path>]
cargo xtask protocol <generate|check> [options]
cargo xtask fixtures <verify|serve> [options]
cargo xtask sources verify
cargo xtask parity <validate|report>
```

With no target, `test` is the fast deterministic development loop. `test all`
runs every deterministic focused suite, including controlled loopback network
tests, but no public network. `test live` is the only test target allowed to
contact public source sites and is never part of `all`, required CI, or release
gates.

`check`, all maintenance `check`/`verify` commands, and protocol golden checks
are read-only. `protocol generate` is the explicit generated-source update;
golden candidates require its explicit maintenance option. Builds write only to
declared generated paths, `target/`, `dist/`, or `artifacts/` as appropriate.
Release build does not sign or publish, and release verification uses public
keys only.

## Examples

```sh
cargo xtask setup
cargo xtask check
cargo xtask test scenario --scenario native/cache-resume
cargo xtask build desktop --unsigned-test
cargo xtask dev extension --browser chromium
cargo xtask ci local
cargo xtask protocol generate --check
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
cargo xtask parity report
```

## Boundaries

- Depend on workspace metadata, protocol/schema generators, and tooling
  libraries; invoke product tools without linking product internals when a
  process boundary suffices.
- Do not contain runtime product behavior, hide mutation in checks, contact the
  public network from deterministic tasks, or duplicate policy in CI scripts.
- Test argument parsing, fixed target/lane allowlists, deterministic and
  idempotent generation, check-mode clean diffs, cleanup, and failure
  propagation.
- Preserve the three `migration-sources` trees. Source and parity tasks verify
  or compare them; they never rewrite them.
