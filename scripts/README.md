# Build and release scripts

These scripts assemble distributable apps, generate supporting assets, run
local servers, and connect release artifacts to publication services. They
support development and delivery rather than the image-download algorithm.

The [task runner](../crates/xtask/) coordinates this work for contributors;
[GitHub workflows](../.github/workflows/) use the same tooling in automation.
The [release runbook](../release/README.md) covers publication and recovery.
