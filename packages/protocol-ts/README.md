# protocol-ts

TypeScript bindings for the Dezoomify wire protocol, generated from the
single Rust source (`crates/dezoomify-protocol`).

Do not hand-edit anything under `generated/`. Regenerate instead:

```sh
cargo xtask protocol generate   # rewrite generated sources
cargo xtask protocol check      # fail if committed output is stale
```

CI fails on regeneration drift. Tests: `cargo xtask test protocol`.
