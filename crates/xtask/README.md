# xtask

Run repository tasks from the root with `cargo xtask <task> [target] [options]`.
Use `cargo xtask --help` for command grammar and targets,
[Development](../../docs/development.md) for setup, and
[Testing](../../docs/testing.md) to choose coverage.

## Maintaining tasks

`xtask` invokes component tools, propagates failures, and owns cleanup of child
processes, temporary profiles, servers, and integration registrations. Keep
runtime application behavior outside tooling; use process boundaries instead of
linking app internals when possible.

Scripts and workflows rely on the CLI vocabulary. Unknown tasks, targets, lanes,
and flags must fail as usage errors rather than silently widening coverage.
Checks and verification are read-only; generation is an explicit command.
Deterministic tasks never contact public source sites.

Test argument parsing, failure propagation, cleanup, and deterministic generation.
Keep dependency/version policy in workspace manifests and setup code, and CI
composition in xtask and workflows rather than copying their inventories here.
Publication and rollback instructions live in [Operations](../../docs/operations.md).
