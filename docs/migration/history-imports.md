# History Import Evidence

All three migration sources are reachable from unified `HEAD`
(`7c76bc38b2203a8c654e706c94d0ec3e4d06021d`) through non-squashed subtree
merges. No import was replayed: the normal path is verification-only.

## Web

- Canonical repository: `https://github.com/lovasoa/dezoomify`
- Snapshot SHA: `f7caa07e1ebd3e7d600075ca54a152cee30d8602`
  (`Audit legacy test fixtures (#992)`, 463 commits reachable)
- Tree SHA: `6de605b25368246cccb09b581de46e3c0c5eadec`
- Subtree prefix: `migration-sources/dezoomify-web/`
- Import commit: `04df950ad8c6a2a06a5e2dde49c4344ab70aa37f`
- Import parents: `f301ece1d3976c60b696fd8729cc6d547f8e1376` (mainline),
  `f7caa07e1ebd3e7d600075ca54a152cee30d8602` (source)
- Trailers: `git-subtree-dir: migration-sources/dezoomify-web`,
  `git-subtree-split: f7caa07e1ebd3e7d600075ca54a152cee30d8602`
- Verification:
  `git merge-base --is-ancestor f7caa07e1ebd3e7d600075ca54a152cee30d8602 HEAD`
  (zero),
  `git diff --quiet f7caa07e1ebd3e7d600075ca54a152cee30d8602 HEAD:migration-sources/dezoomify-web`
  (zero, P01-WEB-TREE)

## Rust upstream baseline

- Canonical repository: `https://github.com/lovasoa/dezoomify-rs`
- Baseline SHA: `cb13f0b83c23eb7408ac8cac93bfe842b9b49966`
  (`Isolate legacy site adapters and live tests (#353)`, 722 commits reachable)
- Tree SHA: `6a1c3a18b20bfce073a168bdc837d12cc0c533ea`
- No checked-in prefix may masquerade as this tree. It is a Git object only.

## Rust destination snapshot (resolved tip)

- Canonical repository: `https://github.com/lovasoa/dezoomify-rs`
- Snapshot SHA: `a304e43c34cd87bdfdcbbb9db9a9244973a8d59b`
  (`Update dependencies and bump version to 2.20.0` by lovasoa,
  729 commits reachable; `cb13f0b` is its ancestor)
- Tree SHA: `7dbd36044a5b530c4dd2dfec943d2e2c454d68cc`
- Subtree prefix: `migration-sources/dezoomify-rs/`
- Sync commit: `135414fce401bebc27b49798c402e0185e7ce0cc`
  (`Squashed 'migration-sources/dezoomify-rs/' changes from 23c4639..a304e43`,
  single parent `23c4639`)
- Trailers: `git-subtree-dir: migration-sources/dezoomify-rs`,
  `git-subtree-split: a304e43c34cd87bdfdcbbb9db9a9244973a8d59b`
- Original import (superseded content, retained history): `8570435` merged
  `23c4639` under the same prefix with parents
  `04df950ad8c6a2a06a5e2dde49c4344ab70aa37f` (mainline) and
  `23c46390c4e3245c278aa3d21145f8b692f19aef` (source), trailers
  `git-subtree-dir: migration-sources/dezoomify-rs` and
  `git-subtree-split: 23c46390c4e3245c278aa3d21145f8b692f19aef`.
- Verification:
  `git merge-base --is-ancestor cb13f0b a304e43c34cd87bdfdcbbb9db9a9244973a8d59b`
  (zero, P01-RUST-LINEAGE),
  `git merge-base --is-ancestor a304e43c34cd87bdfdcbbb9db9a9244973a8d59b HEAD`
  (zero),
  `git diff --quiet a304e43c34cd87bdfdcbbb9db9a9244973a8d59b HEAD:migration-sources/dezoomify-rs`
  (zero, P01-RUST-TREE)

## Superseded historical snapshot `23c4639`

`23c46390c4e3245c278aa3d21145f8b692f19aef`
(`Snapshot in-progress dezoomify-rs migration work`, direct child of `cb13f0b`,
tree `21fb2bc98c5304e145eec6f429fda690ee12160b`) was the earlier
destination-only snapshot. Upstream later reverted it (`REVERT: 23c4639` in the
sync) and released v2.20.0 as `a304e43`; the checked-in prefix therefore equals
`a304e43`, not `23c4639`. The object remains reachable for audit. Its
`cb13f0b..23c4639` inventory is retained below, followed by the
`23c4639..a304e43` sync inventory; phase 02 classifies the combined
`cb13f0b..a304e43` delta.

## Extension

- Canonical repository: `https://github.com/lovasoa/dezoomify-extension`
- Snapshot SHA: `d231dd0bef310a46604140baa50ef29702aef53e`
  (`stop detecting retired dezoomers (#80)`, 80 commits reachable)
- Tree SHA: `e81218f97a72a5f63b134fc4e3931f581cb24667`
- Subtree prefix: `migration-sources/dezoomify-extension/`
- Import commit: `a539c0d83cc4b2eb5f185cd960e0095eb222972c`
- Import parents: `857043513d3c4f2ecda3de85386fbea1b9245bd0` (mainline),
  `d231dd0bef310a46604140baa50ef29702aef53e` (source)
- Trailers: `git-subtree-dir: migration-sources/dezoomify-extension`,
  `git-subtree-split: d231dd0bef310a46604140baa50ef29702aef53e`
- Verification:
  `git merge-base --is-ancestor d231dd0bef310a46604140baa50ef29702aef53e HEAD`
  (zero),
  `git diff --quiet d231dd0bef310a46604140baa50ef29702aef53e HEAD:migration-sources/dezoomify-extension`
  (zero, P01-EXT-TREE)

## Rust `cb13f0b..23c4639`: destination-only candidate changes

Single commit `23c4639`. The range below is destination-only candidate
material, **not automatically accepted parity**. Every behavioral delta must be
classified in phase 02 before adoption in phase 04.

```text
M	AGENTS.md
M	Cargo.lock
M	README.md
M	dezoomify-core/Cargo.toml
A	dezoomify-core/src/arcgis/mod.rs
M	dezoomify-core/src/core/adaptive.rs
M	dezoomify-core/src/core/discovery.rs
M	dezoomify-core/src/core/mod.rs
M	dezoomify-core/src/core/registry.rs
M	dezoomify-core/src/core/tile_plan.rs
A	dezoomify-core/src/fsi/mod.rs
A	dezoomify-core/src/hungaricana/mod.rs
M	dezoomify-core/src/krpano/mod.rs
M	dezoomify-core/src/lib.rs
A	dezoomify-core/src/lizardtech/mod.rs
A	dezoomify-core/src/pnav/mod.rs
A	dezoomify-core/src/topviewer/mod.rs
A	dezoomify-core/src/vls/mod.rs
A	dezoomify-core/src/wmts/mod.rs
A	dezoomify-core/src/xlimage/mod.rs
A	dezoomify-core/testdata/coverage/arcgis/MapServer.json
A	dezoomify-core/testdata/coverage/arcgis/uncached.json
A	dezoomify-core/testdata/coverage/fsi/info.txt
A	dezoomify-core/testdata/coverage/fsi/page.html
A	dezoomify-core/testdata/coverage/hungaricana/files-url.html
A	dezoomify-core/testdata/coverage/hungaricana/files.json
A	dezoomify-core/testdata/coverage/hungaricana/imagepath.html
A	dezoomify-core/testdata/coverage/hungaricana/inline-files.html
A	dezoomify-core/testdata/coverage/hungaricana/inline-images.html
A	dezoomify-core/testdata/coverage/hungaricana/sample.ecw.json
A	dezoomify-core/testdata/coverage/lizardtech/calcrgn.xml
A	dezoomify-core/testdata/coverage/pnav/image.json
A	dezoomify-core/testdata/coverage/pnav/page.html
A	dezoomify-core/testdata/coverage/topviewer/data.json
A	dezoomify-core/testdata/coverage/topviewer/media.json
A	dezoomify-core/testdata/coverage/topviewer/mediabank.html
A	dezoomify-core/testdata/coverage/topviewer/server.html
A	dezoomify-core/testdata/coverage/topviewer/thumbnail.html
A	dezoomify-core/testdata/coverage/vls/zoom.html
A	dezoomify-core/testdata/coverage/wmts/WMTSCapabilities.xml
A	dezoomify-core/testdata/coverage/xlimage/pyramid.imgf.xml
A	dezoomify-core/testdata/coverage/xlimage/sample.imgi.xml
M	dezoomify-core/tests/dezoomer_coverage.rs
M	src/arguments.rs
M	src/download_state.rs
M	src/encoder/mod.rs
M	src/encoder/tile_buffer.rs
M	src/encoder/zif_tiff_encoder.rs
M	src/lib.rs
M	src/native.rs
M	tests/live_dezoomers.rs
```

51 files changed, 3905 insertions, 151 deletions. Notable candidate groups:
new format modules ArcGIS, FSI, Hungaricana, LizardTech, PNAV, TopViewer, VLS,
WMTS, XLimage with coverage fixtures; core discovery/adaptive/registry/tile-plan
edits; native download-state/encoder/argument edits. Documentation-only changes
(`AGENTS.md`, `README.md`, `Cargo.lock`) are marked explicitly and carry no
behavior.

## Rust `23c4639..a304e43`: upstream sync inventory

Upstream commits (oldest first): `c27fc90`, `4c153d3`, `b08288c`, `f67ab8a`,
`6f46bd2`, `5f7c1ce`, `a304e43`, including `REVERT: 23c4639`. The sync reaches
v2.20.0 (`dezoomify-rs` 2.20.0, dependencies updated) and removes the NYPL
module and retired dezoomers that no live site reaches. Full path list:

```text
M	Cargo.lock
M	Cargo.toml
M	README.md
M	dezoomify-core/Cargo.toml
M	dezoomify-core/src/arcgis/mod.rs
M	dezoomify-core/src/core/adaptive.rs
M	dezoomify-core/src/core/discovery.rs
M	dezoomify-core/src/core/model.rs
M	dezoomify-core/src/core/registry.rs
M	dezoomify-core/src/dzi/mod.rs
M	dezoomify-core/src/fsi/mod.rs
M	dezoomify-core/src/google_arts_and_culture/tile_info.rs
M	dezoomify-core/src/hungaricana/mod.rs
M	dezoomify-core/src/iiif/mod.rs
M	dezoomify-core/src/iipimage/mod.rs
M	dezoomify-core/src/lib.rs
M	dezoomify-core/src/lizardtech/mod.rs
D	dezoomify-core/src/nypl/mod.rs
M	dezoomify-core/src/pnav/mod.rs
M	dezoomify-core/src/topviewer/mod.rs
M	dezoomify-core/src/vec2d.rs
M	dezoomify-core/src/vls/mod.rs
A	dezoomify-core/src/web_page.rs
M	dezoomify-core/src/wmts/mod.rs
M	dezoomify-core/src/xlimage/mod.rs
M	dezoomify-core/src/zoomify/image_properties.rs
M	dezoomify-core/src/zoomify/mod.rs
M	dezoomify-core/src/zoomify/ngv.rs
M	dezoomify-core/testdata/coverage/arcgis/MapServer.json
M	dezoomify-core/testdata/coverage/fsi/page.html
D	dezoomify-core/testdata/coverage/hungaricana/files-url.html
D	dezoomify-core/testdata/coverage/hungaricana/files.json
D	dezoomify-core/testdata/coverage/hungaricana/imagepath.html
D	dezoomify-core/testdata/coverage/hungaricana/inline-files.html
M	dezoomify-core/testdata/coverage/pnav/page.html
M	dezoomify-core/testdata/coverage/topviewer/mediabank.html
D	dezoomify-core/testdata/coverage/topviewer/server.html
M	dezoomify-core/testdata/coverage/vls/zoom.html
M	dezoomify-core/tests/dezoomer_coverage.rs
M	src/download_state.rs
M	src/encoder/iiif_encoder.rs
M	src/encoder/tile_buffer.rs
M	src/encoder/zif_tiff_encoder.rs
M	src/lib.rs
M	src/network.rs
M	src/output_file.rs
M	tests/live_dezoomers.rs
```

47 files changed, 1561 insertions, 940 deletions. Phase 02 classifies the
combined `cb13f0b..a304e43` delta; rows already inventoried against `23c4639`
are re-checked against the resolved tip where paths overlap.
