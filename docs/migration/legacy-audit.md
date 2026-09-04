# Legacy Audit

Evidence-building inventory only. No behavior is redesigned here; decisions live
in `parity-decisions.md` and `parity-matrix.csv`.

## Web registry and automatic precedence

`index.html` loads `zoommanager.js`, then dezoomers in tag order
`automatic, zoomify, seadragon, iipimage, xlimage, topviewer, krpano, iiif, fsi,
lizardtech, vls`, then ES modules `arts-culture, hungaricana, arcgis, wmts,
pnav`, then classic `generic.js`. Modules are deferred, so the effective
`addDezoomer` execution order puts `Generic dezoomer` before the five modules.
`automatic.js` tries `urls` patterns first, then BFS page/iframe `contents`
patterns, first match in registry iteration order wins; `visitedUrls` makes the
content phase cycle-safe. `zoomify.js` iframe recursion and `krpano.js` include
following have no visited set. 16 formats registered plus the `Select
automatically` dispatcher; `arts-culture-crypto.js` is helper-only (AES-CBC +
HMAC-SHA1). `krpano.js` uses a misleading internal `var seadragon` but registers
`krpano` distinctly.

## Web deterministic scenarios

`dezoomers.spec.js` (9 blocks, 58 parameterized cases + ~35 inline checks):
core protocol fixtures for all 16 formats, Zoomify viewer-page branches
(flash/fluid/openlayers/unibe/paris/ngv/artandarchitecture/iframe/tile-URL),
Seadragon branches (bl/prado/polona/nla/paris/wdl/embeds/zoom.it/zoomhub/iframe),
IIIF branches (v3/ONB/CONTENTdm/national-gallery/londonmuseum/philamuseum/
gallica/vangogh/malformed/overlap/edge-crop/manifest-failure), TopViewer/
Memorix (5 sites + thumbnail/detail paths), ArcGIS token/basemap/uncached,
Arts & Culture signed+encrypted tiles, XLimage prompt page-number, Hungaricana
4 page shapes, automatic precedence (Zoomify wins), cycle/repeated-parent
rejection with exact-once fetch counts, assembly pixels (4 layouts incl.
overlap seam, missing-tile transparency, edge cropping). `proxy-function.spec.js`
(Cloudflare GET+HEAD, Node adapter). `node-cli-smoke.js` (generic/iiif/pnav CLI).
`fixture-server.js` dynamic routes: signed Arts path verification (403 on HMAC
mismatch), fixture mapping with `{{origin}}/{{host}}` templating, live
passthrough, SVG tile generators (padded/large/edge/boundary/one/
missing-origin/placeholder), assembly tile generator, IIIF/pnav JPEG stub.
106 fixture files across 21 host dirs; `images/fixture.jpg` shared stub.

## Web runtime and UI

`browser-init.js`: hash pre-fill without auto-open; submit opens. No proxy
approval prompt, no cookie/proxy UI controls, no manual retry exist. Legacy
transport: metadata always through `/proxy` with silent `X-Set-Cookie`
accumulation into `&cookies=` query; tiles direct via `<img>` unless
`proxy_tiles` set (never in production). Scheduling: row-major, 200 ms stagger
(`MAX_REQUESTS_PER_SECOND=5`), `<img>` retry 5x with `pow(10*random(),n)` (with
an implicit-global `nextTime` bug), metadata fatal except Seadragon dual-probe.
Progress polled every 500 ms; `Converting image...` to `Save image`
(`dezoomify-result.jpg`, JPEG 0.95) via `toBlob`; tainted canvas yields no save
link. Canvas cap 268 MP with silent downscale (`UI.ratio`); per-dezoomer level
pre-filter. Error panel with prefilled GitHub issue links; first error wins.
Node CLI (`dezoomify-node.js`): jsdom + canvas, 10 tile retries, `DEZOOMIFY_PROXY_PORT`.

## Rust upstream baseline (`cb13f0b`)

Core registry order: custom, google_arts_and_culture, zoomify, iiif, deepzoom,
generic, krpano, iipimage, nypl, bulk_text. Declarative discovery:
`ResourceNeed`/`ResourceResponse`/`ResourceFailure` keyed by `RequestId`,
depth-first priority, dedup by full request, per-candidate history, limits
(10k transitions, 256 resources, 64 MiB). Catalog model with sorted levels,
duplicate rejection, fixed `Grid` (row-major, edge/overlap clipping,
Referer injection), `Positioned` (custom YAML), adaptive `DiscoverableGrid`
(generic dichotomic probing, 1x1 placeholder = missing). Typed errors
(`DiscoveryError`, `CatalogError`, `TileSourceError`, `ProcessingError`,
IIIF/manifest/geometry, YAML expression errors). Native: reqwest fetch with
default headers + user `-H` precedence + scoped Referer, tile cache
(hashed+legacy), exp-backoff retries, throttler, indicatif progress, interactive
image/level pickers, bulk BFS mode, decoders, PNG/IIIF/ZIF-TIFF/JPEG encoders,
atomic output naming. Tests: unit suites per module, `dezoomer_coverage.rs`,
`dependency_architecture.rs` (bans runtime crates from core).

## Rust destination snapshot (resolved tip `a304e43`, v2.20.0)

Supersedes `23c4639` (reverted upstream). Net effect vs `cb13f0b`: new format
modules ArcGIS, FSI, Hungaricana, LizardTech, PNAV, TopViewer, VLS, WMTS,
XLimage with coverage fixtures; NYPL removed; retired dezoomers/special cases
removed; shared page-title parsing; pnav level-geometry dedup; dependency
updates. Baseline suites pass on the resolved tip (coverage 24, architecture 1).

## Extension (`d231dd0`)

`url-recognition.js`: 7 sequential rewrites then joined `META_REGEX`
(ImageProperties/info.json/?FIF=/_files tile/.img.?cmd=info/.ecw/IIIF-path/
artsandculture asset) with `dezoomify.ophir.dev/#` self-exclusion. 11 positive
tests, negatives for plain jpg, retired `.pff`/`/viewer/p.xml`/Rijksmuseum, and
self-URL. `background.js`: click-to-arm per-tab `webRequest` listener
(`<all_urls>` + type filter), http/https dedup (https wins), badge/title/icon
states, 5 context-menu actions, tab-close cleanup, handoff
`https://dezoomify.ophir.dev/#<image-url>`. MV2, permissions
`activeTab,webRequest,contextMenus,<all_urls>`.

## Live inventory

35 live checks (`live-compat.spec.js`, isolated `--live` config, advisory only):
Arts/NationalGallery/VanGogh/London/Philadelphia/Liechtenstein (IIIF),
NGV (Zoomify), NLA/Paris-pub/Academia (Seadragon), CSNTM/ONB/Oklahoma/UW/NLS
(IIIF), Memorix ×7 (TopViewer), BLB VLS, Hungaricana, krpano.com, FSI, HNG
IIPImage, Uffizi XLimage, ArcGIS WMTS + NGI MapServer, BLB generic template,
Alabama LizardTech, OpenSeadragon Zoomify, pnav ethnomuseum. Every live row
needs deterministic replacement coverage (phase 03 scenarios) or stays blocked.
