# Historical regression fixtures

New product fixtures live in [`fixtures/`](../../fixtures/README.md).
These historical reproductions remain inputs to focused parser, transport, and
product failure tests. Files are ordinary reviewed source; Git records their
history. Discovery and failure expectations live directly in the focused tests.
The hash registry, scenario inventories, and capture/verification framework
are removed. Identical payloads share relative symlinks.

## Provenance

The imported fixtures retain their original grants:

| Directory | Source snapshot | Grant |
|---|---|---|
| `rs-core/formats/payloads/` (except synthetic Second Canvas/FZP inputs) | dezoomify-rs `a304e43` | GPL-3.0-only |
| `web/*/payloads/` imported web reproductions | dezoomify-web `f7caa07` | GPL-2.0-or-later |
| imported extension fixtures | dezoomify-extension `d231dd0` | GPL-3.0-or-later |
| `formats/fzp/`, native/desktop/website fixtures, local web reproductions | locally authored synthetic data | GPL-3.0-or-later |

The complete original per-file source paths and grants remain in the
[historical registry](https://github.com/lovasoa/dezoomify/blob/6bc8706eba0cef1dbc63069f0e7bd4f54fbd9f26/testdata/scenarios/manifest.json).
The Google Arts HTML files retain the original signing token layout and title
fields after removing unrelated site content; krpano retains every scene and
image. Second Canvas metadata/viewers are synthetic (2026-09-11); FZP inputs are
synthetic from the specification (2026-09-29), except `rs-core/.../fzp/unversioned.xml`,
public factual JSCE Library metadata (2026-10-02).
`coverage/iiif/bruun-rasmussen-info.json` is the imported Rust regression for
https://bruun-rasmussen.dk/m/lots/B7651D2E4677/images/1.
Observed Zoomify inputs reproduce Museum Ludwig behavior with synthetic data.
Live-triage fixtures (2026-09-07) are synthetic. Memorix demo keys and Arts
fixture tokens are public test doubles; they are never real credentials.

## Serving reproductions

Use ordinary loopback URLs for local files. For a recorded remote URL, use
`/fetch?url=<encoded URL>` (the Node `replayUrl` helper builds this).
This is the only replay form. The standard URL parser normalizes requests;
bad test requests produce a logged exception rather than a simulated API contract.

A file at `payloads/{host}/{path}` answers that host/path. Alternate paths use
relative symlinks; content types follow file extensions (or the symlink target
for extensionless files). Captured text URLs can omit `.html`, `.json`, `.xml`,
or `.txt`; directory URLs use `index` with those extensions. Percent-encoded
paths and their decoded spellings identify the same file. Duplicate host/path
files must contain identical bytes; conflicting copies fail at startup.

A local `server.js` exports `serve(request, { file, origin })` and returns a
standard Response for requests it owns, or null to fall through to static files.
Returning a 404 finishes the request. The file argument is the matching static
file; tile fallbacks yield to metadata files, while authentication checks run
before protected files are served. Headers, cookies, redirects, and generated
responses belong in these handlers. They can use `fileResponse` from
`test/fixture-files.mjs` to infer MIME types and supply Response options.

Text substitutes `{{origin}}`, `{{localhost_origin}}`, and `{{host}}`.
Encoded bodies are sent unchanged. Format code stays outside the generic server.

The server binds ephemeral loopback ports and never forwards unknown requests
to public hosts. Cookie values stay out of request logs. Handlers use local bytes
and deterministic synthetic responses. Third-party image servers are test
subjects, not replacement fixture infrastructure.
