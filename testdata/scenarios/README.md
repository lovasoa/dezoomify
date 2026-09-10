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

## Route conventions

`routes.json` carries only behavior that departs from the defaults. A route
that omits fields takes `method: GET`, `status: 200`, no extra headers, and a
`route_id` derived from host + path. More importantly, the **directory mirror**
is the default route table:

- A payload stored at `payloads/{host}{url-path}` is served at
  `{host}{url-path}` with the content type inferred from its extension
  (`.xml` and `.dzi` are `application/xml`). No `routes.json` entry is needed.
- An explicit route wins over the mirror for the same served URL, and an exact
  `path` beats a `path_prefix`/`path_regex` wildcard regardless of order.
- Keep an explicit entry when the route is not a plain mirrored `200`/`GET`:
  non-`200` statuses, extra or non-standard headers, redirects, query
  matching, wildcards, generators, or a payload whose file name does not
  mirror its URL (e.g. `tile-0_0.png` served at
  `pyramid_files/9/0_0.png`).

## Harness maintenance

- **Provenance:** every payload records `source_snapshot`, `source_path`, and
  `license_provenance` in `manifest.json`; fixtures with unclear licenses,
  secrets, or personal data are blocked from the corpus.
- **Adding a scenario:** create `testdata/scenarios/<id>/` with `scenario.json`
  (see `schema/scenario.schema.json`), byte payloads under
  `payloads/{host}{url-path}`, and expectations under `expected/`. Add
  `routes.json` (see `schema/routes.schema.json`) only for the exceptions
  above. Copy payload bytes exactly, record SHA-256 in `manifest.json`, and run
  `cargo xtask fixtures verify`.
- **Routes and hashes:** explicit routes match exact method/host/path with
  optional exact query; the mirror covers the rest; host matching ignores
  ephemeral ports. `cargo xtask fixtures verify` checks schemas, references,
  SHA-256, sizes, duplicate IDs, incompatible duplicate served URLs (explicit
  and mirrored), unlisted/missing files, traversal, and provenance.
  Verification never rewrites files.
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
