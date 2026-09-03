# fixture-server

- **Responsibility:** Serve deterministic local HTTP scenarios to Rust and
  browser integration tests.
- **Allowed dependencies:** Test-oriented HTTP/TLS libraries, scenario data, and
  protocol types when typed event fixtures are needed.
- **Forbidden responsibilities:** No production proxy, internet dependency,
  product logic, persistent credentials, fixed public port, or non-loopback
  default binding.
- **Interfaces and tests:** Expose an ephemeral loopback server and scenario
  controls for redirects, headers, cookies, ranges, delays, failures, CORS, and
  readable fetch versus cross-origin image-display paths. Support deterministic
  `originClean` guard, extension direct-fetch/session, bounded scan, handoff, and
  cookie-scope cases from `testdata/scenarios`. Self-test isolation, shutdown,
  and route determinism.
- **Migration source:** Consolidate fixture behavior from
  `migration-sources/dezoomify-web/tests/fixture-server.js` and relevant local
  fixtures in `migration-sources/dezoomify-rs/testdata`.
