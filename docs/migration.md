# Migration

The unified apps replace the legacy website, extension, and native releases
per the phase-14 cutover record. `migration-sources/` remain read-only
evidence through phase 15. Legacy release access and minimum compatible
versions are listed in the cutover acceptance record.

## Legacy verification

These commands verify the imported legacy trees only. They are historical
evidence checks, not a substitute for the `cargo xtask` gates:

```sh
cargo test --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace
cargo clippy --manifest-path migration-sources/dezoomify-rs/Cargo.toml --workspace --all-targets -- -D warnings
cargo fmt --manifest-path migration-sources/dezoomify-rs/Cargo.toml --all -- --check
npm ci --prefix migration-sources/dezoomify-web/tests
npm test --prefix migration-sources/dezoomify-web/tests
npm ci --prefix migration-sources/dezoomify-extension
npm test --prefix migration-sources/dezoomify-extension
```

The `npm` suites are network-dependent live checks; report them separately
from deterministic checks.
