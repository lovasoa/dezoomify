# Historical regression fixtures

Focused regressions use these imported payloads; new product saves belong in
[fixtures](../../fixtures/AGENTS.md). Replay and handler contracts are documented
at [the fixture server](../../test/fixture-server.mjs).

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
