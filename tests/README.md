# tests/ -- untracked Playwright residue, not a suite

This directory is not canonical and never runs in any `cargo xtask test` or
`cargo xtask ci` lane. It holds only ignored output (`node_modules/`,
`test-results/`) plus an empty `fixtures/remote/` tree with no fixture bytes.

Do not add specs, configs, or fixtures here.

- Canonical fast website unit suite: `test/*.test.mjs`
  (`node --test test/*.test.mjs`, `cargo xtask test web`).
- Canonical fixture-server gates: `crates/fixture-server/tests/`
  (`http_contract.rs`, `security.rs`, `webapp-e2e/`).
- Real fixtures: `testdata/scenarios`.
- Full map: `docs/testing.md` (`Test locations`).

Safe local cleanup removes only ignored output
(`rm -rf tests/node_modules tests/test-results`).
Never delete real fixtures in `testdata/`.
