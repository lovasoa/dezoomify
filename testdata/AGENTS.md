- Keep fixtures minimal, deterministic, and usable without public network access.
  Production code must not depend on repository test data.
- Record source URLs, issues, grants, and retained notices beside imported data;
  preserve the grants in `scenarios/README.md`.
- Exclude private data, credentials, unexplained large binaries, and generated
  build output. Share identical payloads through relative symlinks.
- New successful product saves belong in `fixtures/`; use historical scenarios
  for focused regressions. The replay/handler contract lives in
  `test/fixture-server.mjs`.
