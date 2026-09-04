# Core Delta Review (`cb13f0b..a304e43`)

Upstream line (oldest first): `c27fc90`, `4c153d3`, `b08288c`, `f67ab8a`,
`6f46bd2`, `5f7c1ce`, `a304e43` (v2.20.0). `cb13f0b` is their ancestor
(merge-base verified). Side commit `23c4639` (child of `cb13f0b`, reverted
upstream, superseded locally) is inventoried in `history-imports.md`; no row
below says merely "take latest".

## Commit classification

| Commit | Subject | Class | Parity linkage |
|---|---|---|---|
| `c27fc90` | Add remaining legacy dezoomers (#973) | web-parity candidate | FMT-009..016 (arcgis/fsi/hungaricana/lizardtech/pnav/topviewer/vls/wmts/xlimage) + coverage fixtures |
| `4c153d3` | Leave generic image names to the application | behavior change (naming) | DISC/TILE generic naming; adopted with test (phase-04 parity) |
| `b08288c` | Name pnav images from page titles; stop duplicating level geometry | behavior change | FMT-015; adopted with test |
| `f67ab8a` | Share HTML page title parsing | refactor | FMT-015 shared helper; no behavior delta alone |
| `6f46bd2` | Remove dezoomers and special cases that no live site reaches | retire | FMT-021 (NYPL removal); retired recognizer negatives |
| `5f7c1ce` | update dependencies | tooling | none (lockfile only) |
| `a304e43` | Update dependencies and bump version to 2.20.0 | tooling/release | none (version + lockfile) |

## Changed-path adoption status

New format modules (`arcgis`, `fsi`, `hungaricana`, `lizardtech`, `pnav`,
`topviewer`, `vls`, `wmts`, `xlimage` + coverage fixtures): ADOPTED as
parity candidates with scenario coverage (FMT-009..016). Core
discovery/adaptive/registry/tile-plan/model edits: ADOPTED after parity
comparison per format batch. Native/encoder/argument edits (`src/**`,
`tests/live_dezoomers.rs`): NOT adopted into core (host-owned; phase 10 owns
native parity). Documentation-only (`AGENTS.md`, `README.md`, `Cargo.lock`,
`Cargo.toml` version bumps): marked, no behavior. `nypl/mod.rs` deletion:
ADOPTED as retirement FMT-021 with negative scenario. `web_page.rs` addition:
ADOPTED with page-format scenarios. No row remains `blocked` without a test.

## Exhaustive changed paths (`git diff --name-status cb13f0b..a304e43 -- dezoomify-core`)

Status key: `M` modified, `A` added, `D` deleted. Verified 2026-09-04;
`5f7c1ce` touches only the workspace lockfile outside `dezoomify-core/`,
hence absent from the path list and classified tooling-only above.

| Status | Path | Adoption |
|---|---|---|
| M | `dezoomify-core/Cargo.toml` | ADOPTED (version 2.20.0 metadata; no new runtime deps; purity gate green) |
| A | `dezoomify-core/src/arcgis/mod.rs` | ADOPTED (FMT-009; `web/site-adapters`, `web/core-discovery`) |
| M | `dezoomify-core/src/core/adaptive.rs` | ADOPTED (`P04-ADAPTIVE`; scripted probe ordering/bounds/termination) |
| M | `dezoomify-core/src/core/discovery.rs` | ADOPTED (`P04-DISCOVERY`; dedup/cycles/limits; redacted logging) |
| M | `dezoomify-core/src/core/mod.rs` | ADOPTED (exports `redact_uri`/`origin_only`; no behavior) |
| M | `dezoomify-core/src/core/model.rs` | ADOPTED (`P04-FIXED-GRID`; wire bytes unchanged; redaction at log boundary) |
| M | `dezoomify-core/src/core/registry.rs` | ADOPTED (`P04-REGISTRY`; ordered id/display/hints snapshot) |
| M | `dezoomify-core/src/core/tile_plan.rs` | ADOPTED (Referer legacy parity preserved; redaction in logs only) |
| M | `dezoomify-core/src/dzi/mod.rs` | ADOPTED (DZI/Seadragon page adapters; `web/seadragon-pages`, `web/zoomify-pages`) |
| A | `dezoomify-core/src/fsi/mod.rs` | ADOPTED (FMT-010; `web/core-discovery`) |
| M | `dezoomify-core/src/google_arts_and_culture/tile_info.rs` | ADOPTED (`web/site-adapters`; decryption pure, tests under `cfg(test)`) |
| A | `dezoomify-core/src/hungaricana/mod.rs` | ADOPTED (FMT-011; `web/core-discovery`) |
| M | `dezoomify-core/src/iiif/mod.rs` | ADOPTED (IIIF v2/v3/manifest; `web/iiif-discovery`, `web/core-discovery`) |
| M | `dezoomify-core/src/iipimage/mod.rs` | ADOPTED (`web/core-discovery`, `web/query-params`) |
| M | `dezoomify-core/src/krpano/mod.rs` | ADOPTED (krpano decrypt/levels; redacted `debug`/`warn`) |
| M | `dezoomify-core/src/lib.rs` | ADOPTED (`forbid(unsafe)`, module list; no API break for parity) |
| A | `dezoomify-core/src/lizardtech/mod.rs` | ADOPTED (FMT-012; `web/core-discovery`) |
| D | `dezoomify-core/src/nypl/mod.rs` | ADOPTED as retirement FMT-021 (negative recognizer tests) |
| A | `dezoomify-core/src/pnav/mod.rs` | ADOPTED (FMT-015; title naming + no duplicated geometry) |
| A | `dezoomify-core/src/topviewer/mod.rs` | ADOPTED (FMT-016; `web/topviewer`, `web/query-params`) |
| M | `dezoomify-core/src/vec2d.rs` | ADOPTED (checked arithmetic; `P04-MALFORMED`) |
| A | `dezoomify-core/src/vls/mod.rs` | ADOPTED (FMT-013; `web/core-discovery`) |
| A | `dezoomify-core/src/web_page.rs` | ADOPTED (shared title helper; page-format scenarios) |
| A | `dezoomify-core/src/wmts/mod.rs` | ADOPTED (FMT-014; `web/core-discovery`) |
| A | `dezoomify-core/src/xlimage/mod.rs` | ADOPTED (FMT-008; `web/core-discovery`) |
| M | `dezoomify-core/src/zoomify/image_properties.rs` | ADOPTED (checked levels; overflow regression) |
| M | `dezoomify-core/src/zoomify/mod.rs` | ADOPTED (Zoomify groups/pages; `web/zoomify-pages`) |
| M | `dezoomify-core/src/zoomify/ngv.rs` | ADOPTED (NGV page adapter) |
| A | `dezoomify-core/testdata/coverage/**` | CURATED into `testdata/scenarios/rs-core/formats/payloads/**`; no crate-local canonical copy |

Validation: `git diff --name-status cb13f0b..a304e43 -- dezoomify-core`
lists exactly the rows above (plus `testdata/coverage/**` payloads);
`cargo xtask parity validate` maps every ADOPTED row to matrix IDs;
`cargo xtask test core --parity` and `--purity` pass;
`cargo check -p dezoomify-core --target wasm32-unknown-unknown --no-default-features` passes.
