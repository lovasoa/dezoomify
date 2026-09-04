# Migration Sources

- **Responsibility:** Preserve the history-bearing imports used to establish
  behavior and test parity while the unified repository is assembled.
- **Allowed dependencies:** Each imported root remains self-contained and may
  use only its existing project dependencies.
- **Forbidden responsibilities:** Do not host new architecture, shared code, or
  routine fixes here; do not edit, reformat, move, or delete imported content
  except when an explicit migration-plan step requires it.
- **Interfaces and tests:** Use each root's existing public entry points and
  commands as migration evidence. New-tree parity tests must live in the owning
  target crate, app, package, or `testdata/scenarios`.
- **Migration sources:** `dezoomify-rs`, `dezoomify-web`, and
  `dezoomify-extension` were added by non-squashed subtree merges. Web and
  extension remain locked at `f7caa07` and `d231dd0`; `dezoomify-rs` was
  imported at `23c4639` and synced to the resolved upstream tip `a304e43`
  (v2.20.0) by squash commit `135414f`, with source history reachable from each
  merge commit. See `docs/migration/source-lock.json` and
  `docs/migration/history-imports.md` for the locked SHAs.
