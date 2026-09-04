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
