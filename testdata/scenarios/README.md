# Integration Scenarios

- **Responsibility:** Define host-independent end-to-end scenarios as deterministic
  requests, responses, observed progress, results, and failures.
- **Allowed dependencies:** Scenarios may reference public domain types
  and fixture-server route vocabulary, with payloads stored beside the scenario.
- **Forbidden responsibilities:** No app implementation, real credentials,
  private URLs, uncontrolled timing, internet requirement, or host-specific
  expectations unless the scenario explicitly tests that host boundary.
- **Interfaces and tests:** Each scenario records purpose, provenance, routes,
  expected request order/headers, readable-fetch or ordinary image display,
  expected `originClean` transitions, outputs/errors, and license. Include
  bounded extension scan/direct-fetch and validated handoff cases. Run fixture
  verification plus native and browser tests where applicable.
- **Sources:** Distill each scenario from the behavior of the real site it
  represents; preserve behavior, not any particular directory layout.

## Route conventions

`routes.json` carries only behavior that departs from the defaults. A route
that omits fields takes `method: GET`, `status: 200`, no extra headers, and a
`route_id` derived from host + path. More importantly, the **payload layout**
is the default route table:

- A payload stored at `payloads/{host}{url-path}` is served at
  `{host}{url-path}` with the content type inferred from its extension
  (`.xml` and `.dzi` are `application/xml`). No `routes.json` entry is needed.
- An explicit route wins over the layout-derived route for the same served
  URL, and an exact `path` beats a `path_prefix`/`path_regex` wildcard
  regardless of order.
- Keep an explicit entry when the route is not a plain layout-derived
  `200`/`GET`: non-`200` statuses, extra or non-standard headers, redirects,
  query matching, wildcards, generators, or a payload whose file name does
  not follow its URL (e.g. `tile-0_0.png` served at
  `pyramid_files/9/0_0.png`).
- `required_cookies` is a name/value map that makes a route return a stable
  `403` unless the browser sends each pair. The server records only missing
  cookie names, never cookie values, so session tests assert product outcomes
  rather than request headers.

## Harness maintenance

- **Provenance:** every payload records `source_snapshot`, `source_path`, and
  `license_provenance` in `manifest.json`; fixtures with unclear licenses,
  secrets, or personal data are blocked from the corpus.
- **Adding a scenario:** create `testdata/scenarios/<id>/` with `scenario.json`
  containing `id`, `description`, `source_evidence`, `input`, and `operation`.
  The owning test defines its input and expected result shape. Store byte
  payloads under `payloads/{host}{url-path}` and expectations under `expected/`.
  Add `routes.json` only for the exceptions above. Copy payload bytes exactly,
  record SHA-256 in `manifest.json`, and run
  `cargo xtask fixtures verify`.
- **Routes and hashes:** explicit routes match exact method/host/path with
  optional exact query; the payload layout covers the rest; host matching
  ignores ephemeral ports. `cargo xtask fixtures verify` checks required
  scenario fields, directory IDs, typed manifest and route records, references,
  SHA-256, sizes, duplicate IDs, incompatible duplicate served URLs (explicit
  and layout-derived), unlisted/missing files, traversal, and provenance.
  Verification never rewrites files.
- **Serving:** `cargo xtask fixtures serve --port 0 --write-address
  target/fixture-server.addr` binds loopback only and writes one parseable
  address after listening. The server has no passthrough: unknown resources get
  a stable `fixture-missing` response and public egress is impossible by
  construction.
- **Deterministic vs live:** everything here runs without public DNS or
  network. Live compatibility (`cargo xtask test live`) is advisory and never
  replaces scenario coverage.

- **Sensitivity vocabulary:** manifest `sensitive` is `false` for clean data,
  `true` for real secrets (never committed), or `review:<reason>` for
  synthetic test-doubles (e.g. `review:test-double-token` for a public demo
  `apiKey`). Only clean data and reviewed synthetic values belong in the corpus.
  Expected transcripts containing the same
  public test-double are covered by the same vocabulary.
- **Transcript updates:** transcripts are compare-only expected data; tests
  fail on drift. Update them deliberately, then inspect `git diff` and
  `git status --porcelain -- testdata/scenarios` before accepting.
