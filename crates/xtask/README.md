# Repository tooling

Coordinates development, validation, builds, and releases across the Rust crates,
JavaScript packages, and [apps](../../apps/). The same tasks run locally and in
[CI workflows](../../.github/workflows/), keeping their behavior aligned.

This crate brings the component tools together and handles work that crosses
product boundaries. The [release runbook](../../release/README.md) covers the
operator decisions around publication and recovery.
