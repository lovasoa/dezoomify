# Test Data

- **Responsibility:** Store deterministic, reviewed fixtures shared across
  crates, packages, and applications.
- **Allowed dependencies:** Tests and fixture tooling may read these files;
  production code must not require repository testdata at runtime.
- **Forbidden responsibilities:** No live endpoints as sole coverage, generated
  build output, oversized unexplained binaries, credentials, private user data,
  or fixtures with unknown redistribution terms.
- **Interfaces and tests:** Document fixture provenance, license/redaction,
  expected behavior, and regeneration. Validate schemas and ensure scenarios
  remain hermetic and minimal.
- **Migration source:** Curate required cases from
  `migration-sources/dezoomify-rs/testdata` and
  `migration-sources/dezoomify-web/tests/fixtures`; do not bulk-copy by default.
