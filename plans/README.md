# Plans

## Active plan

- [`webapp-cli-completion.md`](webapp-cli-completion.md) — post-migration
  phases C1–C7: replace the remaining stubs (native HTTP egress, CLI download
  pipeline, webapp tile download + save, WASM job delegation, browser worker,
  browser E2E) and port the legacy live suites to run the real apps. End
  state: all webapp and CLI tests pass while exercising real code.

## Migration archive

Phases 00–15 are complete and recorded in
[`docs/migration/gates.md`](../docs/migration/gates.md). The per-phase plan
files were removed after completion; this directory remains as a pointer so
older references keep resolving.

- Completion evidence: `docs/migration/gates.md` (16/16 gate rows),
  `docs/migration/exceptions.md` (open items E01–E06), `docs/migration/parity-decisions.md`.
- Working commands: `cargo xtask --help` (run `cargo xtask check` and
  `cargo xtask test` to verify this checkout).
- History: per-phase plans live in git history before their removal commit.
