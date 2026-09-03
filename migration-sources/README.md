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
  `dezoomify-extension` were added by non-squashed subtree merges. Their locked
  imported tips are respectively `23c4639` (the in-progress Rust migration
  snapshot), `f7caa07`, and `d231dd0`, with source history reachable from each
  merge commit.
