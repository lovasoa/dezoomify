# Shared tests and harnesses

Cross-component tests cover website behavior, shared presentation, server
adapters, and browser integrations. They complement the focused tests kept
beside individual apps, crates, and packages.

Shared harnesses let Rust and browser tests use the same local image sources.
[Product fixtures](../fixtures/) exercise complete downloads across products;
[historical data](../testdata/) reproduces specific regressions. The
[task runner](../crates/xtask/) selects and runs the suites.
