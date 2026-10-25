# OpenLayers issue corpus

Collected before implementation on 2026-10-25 from open and closed Dezoomify
issues. `cases.json` contains reduced public configuration facts, not downloaded
artwork, credentials, or complete site scripts. Reproductions are synthetic
GPL-3.0-or-later data and use the shared image tiles with real OpenLayers code.

| Reports | Evidence and purpose |
| --- | --- |
| [#1296](https://github.com/lovasoa/dezoomify/issues/1296), [#734](https://github.com/lovasoa/dezoomify/issues/734) | Asian Art Museum HAR: IIIF with failing metadata and an eMuseum map stored in element data. |
| [#715](https://github.com/lovasoa/dezoomify/issues/715) | Allen Memorial HTML and `modules.gz/emuseum/MediaZoom.js`: older initializer without a version argument, selecting IIIF 2 inside the module. |
| [#773](https://github.com/lovasoa/dezoomify/issues/773) | New Britain HTML and the same module: explicit IIIF 2 version and different image geometry. |
| [#321](https://github.com/lovasoa/dezoomify/issues/321) | Philadelphia history discussion records 6212×6248 inline Zoomify dimensions and missing metadata. The tile size is the reproduction's synthetic setting. Current page is challenged. |
| [#455](https://github.com/lovasoa/dezoomify/issues/455), [#626](https://github.com/lovasoa/dezoomify/issues/626) | Geographic WMS requests are controls: a map is not automatically a finite image pyramid. #455's public `js/map.js` supplies the control's source type. |

Source pages are linked in `cases.json`. Network observations supplement the
deterministic replay; tests never depend on public sites staying available.

## Other historical reports examined

[Texas History #652](https://github.com/lovasoa/dezoomify/issues/652) identifies
OpenLayers 3.20.1 in its discussion. Its public `tiles/ImageProperties.xml` still
supplies the corpus geometry (7149×10000, tile size 256). The current viewer
requires a bot check; only the metadata read is a current live pass.
[Deutsche Fotothek #76](https://github.com/lovasoa/dezoomify/issues/76) and
[#343](https://github.com/lovasoa/dezoomify/issues/343) document the
`.ete-openlayers-src` Zoomify integration; the inspected record currently returns
a service-unavailable page.
[Breuer #614](https://github.com/lovasoa/dezoomify/issues/614) currently returns
a page-not-found response. These unavailable examples are not counted as
successful downloads or invented runtime captures.

The replay runs real OpenLayers 6.15.1 and 10.11.0 in Chromium and Firefox,
including bundled libraries without an `ol` global, nested layers, duplicate
sources and element data stores. Historical geometry is replayed on these pinned
runtimes; this does not claim that OpenLayers 3.20.1 itself has been validated.

The replay covers finite image sources. Ordinary geographic maps, unsupported
grids, inaccessible frames and expired source documents must remain controlled
failures. Existing OpenSeadragon scenarios remain regression coverage for the
shared scanner and live resource lifecycle.
