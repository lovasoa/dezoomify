# Integration Scenarios

- **Responsibility:** Define host-independent end-to-end cases as deterministic
  requests, responses, expected protocol events, results, and failures.
- **Allowed dependencies:** Scenario schemas may reference public protocol types
  and fixture-server route vocabulary, with payloads stored beside the scenario.
- **Forbidden responsibilities:** No product implementation, real credentials,
  private URLs, uncontrolled timing, internet requirement, or host-specific
  expectations unless the scenario explicitly tests that host boundary.
- **Interfaces and tests:** Each scenario records purpose, provenance, routes,
  expected request order/headers, readable-fetch or ordinary image-display mode,
  expected `originClean` transitions, outputs/errors, and license. Include
  bounded extension scan/direct-fetch and validated handoff cases. Run schema
  validation plus native and browser parity where applicable.
- **Migration source:** Distill scenarios from Rust fixtures and browser
  Playwright fixtures under `migration-sources`; preserve behavior, not legacy
  directory layout.
