# Rust fixture support

Lets Rust tests use the Node fixture servers shared with browser tests. Together
they reproduce museum and tile-server behavior from local data, keeping tests
repeatable without depending on public websites.

The [product fixtures](../../fixtures/) exercise discovery and saved images across
products. [Historical reproductions](../../testdata/scenarios/) preserve specific
regressions. This crate makes both collections available to Rust tests.
