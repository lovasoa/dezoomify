# Integration Scenarios

- **Responsibility:** Define host-independent end-to-end cases as deterministic
  requests, responses, expected protocol events, results, and failures.
- **Allowed dependencies:** Scenario schemas may reference public protocol types
  and fixture-server route vocabulary, with payloads stored beside the scenario.
- **Forbidden responsibilities:** No app implementation, real credentials,
  private URLs, uncontrolled timing, internet requirement, or host-specific
  expectations unless the scenario explicitly tests that host boundary.
- **Interfaces and tests:** Each scenario records purpose, provenance, routes,
  expected request order/headers, readable-fetch or ordinary image display,
  expected `originClean` transitions, outputs/errors, and license. Include
  bounded extension scan/direct-fetch and validated handoff cases. Run schema
  validation plus native and browser parity where applicable.
- **Sources:** Distill each scenario from the behavior of the real site it
  represents; preserve behavior, not any particular directory layout.

## Harness maintenance

- **Provenance:** every payload records `source_snapshot`, `source_path`, and
  `license_provenance` in `manifest.json`; fixtures with unclear licenses,
  secrets, or personal data are blocked from the corpus.
- **Adding a scenario:** create `testdata/scenarios/<id>/` with `scenario.json`
  (see `schema/scenario.schema.json`), `routes.json` (see
  `schema/routes.schema.json`), byte payloads under `payloads/`, and
  expectations under `expected/`. Copy payload bytes exactly, record SHA-256
  in `manifest.json`, and run `cargo xtask fixtures verify`.
- **Routes and hashes:** routes match exact method/host/path with optional
  exact query; host matching ignores ephemeral ports. `cargo xtask fixtures
  verify` checks schemas, references, SHA-256, sizes, duplicate IDs,
  incompatible duplicate served URLs, unlisted/missing files, traversal, and
  provenance. Verification never rewrites files.
- **Serving:** `cargo xtask fixtures serve --port 0 --write-address
  target/fixture-server.addr` binds loopback only and writes one parseable
  address after listening. The server has no passthrough: unknown resources get
  a stable `fixture-missing` response and public egress is impossible by
  construction.
- **Transcripts:** `expected/legacy-web.json` files are canonical expected
  transcripts (UTF-8, LF, sorted keys, `127.0.0.1:PORT` and `blob:URL`
  normalization). Regeneration must be byte-identical; review diffs before
  accepting updates.
- **Deterministic vs live:** everything here runs without public DNS or
  network. Live compatibility (`cargo xtask test live`) is advisory and never
  replaces scenario coverage.

- **Sensitivity vocabulary:** manifest `sensitive` is `false` for clean data,
  `true` for real secrets (never committed), or `review:<reason>` for
  synthetic test-doubles (e.g. `review:test-double-token` for a public demo
  `apiKey`). `cargo xtask fixtures verify` accepts `false` and `review:*`
  but fails closed on `true`. Expected transcripts containing the same
  public test-double are covered by the same vocabulary; request logs and
  error bodies redact its value regardless.
- **Transcript updates:** transcripts are compare-only expected data; tests
  fail on drift. Update them deliberately, then inspect `git diff` and
  `git status --porcelain -- testdata/scenarios` before accepting.
  `lastTile` is order-independent (tiles sorted by x, y, url);
  `tile_requests` are sorted.
