# dezoomify-core

- **Responsibility:** Purely parse supplied resources, discover image catalogs,
  validate grids, and describe tile requests and processing plans.
- **Allowed dependencies:** Deterministic data/parsing libraries and a logging
  facade; no dependency on other workspace runtime crates.
- **Forbidden responsibilities:** No network/filesystem I/O, async runtime,
  image decoding/encoding, clocks, environment, cache, CLI, UI, or browser APIs.
- **Interfaces and tests:** Expose format registry, discovery transitions,
  catalog/level/tile models, fixed-grid plans, and adaptive programs. Require
  parser fixtures, property/unit tests, and a direct-dependency purity test.
- **Migration source:** Migrate from
  `migration-sources/dezoomify-rs/dezoomify-core` while preserving format parity.
