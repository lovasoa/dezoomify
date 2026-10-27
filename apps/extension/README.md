# Browser extension

Use: [browser extension guide](../../docs/user/browser-extension.md).
Development: `cargo xtask dev extension --browser chromium`.
Tests: `cargo xtask test extension` builds current WASM and both WXT packages,
then runs units and packaged Chromium/Firefox browsers. Package-local `pnpm test`
and `pnpm test:unit` run units only.

## Ownership and permissions

The toolbar click opens or focuses a dedicated job tab. That tab owns scanning,
the Rust invocation, permission prompts, cancellation, and saving. The background
only launches/focuses tabs and remembers source/job associations; a background
restart must not stop an existing job.

One source-access object belongs to one tab's source document. Navigation
invalidates access, and late replies must not revive it. Discovered input can
continue through extension-origin fetching, but never
silently rebind to the new page. The extension supplies observed documents and
resources; Rust owns format recognition and discovery order. When discovery
needs more evidence, scan remaining permitted frames before asking for another
origin. A finite `scripting` probe inventories permitted frames and iframe URL
hints, then refreshes after a grant. Bind follow-up operations to the document;
frame IDs survive reloads. Resource snapshots inspect one document. Memory
scanning follows only readable frames without HTTP URLs (such as `srcdoc` or
`blob:`); HTTP frames belong to the job's inventory, avoiding a second traversal.
Resource snapshots bound URL payloads separately from document contents. Rust
ranks this evidence within its input budget before spending its resource-read
budget, so unrelated page assets do not displace late image requests.

Scanned origins can use their frame's session. Other cross-origin access uses
credential-free extension fetches under explicitly granted host permissions.
Request permissions synchronously from a visible action to preserve user
activation. HTTP refusals must not open permission prompts. Keep injected
operations finite, cancellable, and validated at the job-page boundary.

The [viewer scanner](src/job/viewers/traversal.ts) shares traversal, limits and
deduplication across OpenSeadragon and OpenLayers adapters. Work limits bound
the search; fixed-step yielding keeps it responsive without making findings
depend on scheduling delays. The source operation retains its overall timeout.
Adapters extract source facts; Rust owns format interpretation and grid
validation. Known OpenSeadragon formats supply metadata. Custom OpenSeadragon
sources and finite OpenLayers image grids use the Rust-defined
`ViewerObservation` contract.

The shared [tile session](src/job/viewers/session.ts) retains page loaders in
closures behind document-bound capabilities. Addresses never fall through to
HTTP and are released on retirement. Rust computes placement/crops and owns
retry decisions; adapters reuse the viewer's loading behavior. Cancellation
detaches owned waits without clearing the viewer's render queue or cache.
Cached drawables are borrowed; only transferred bitmaps are closed.

OpenLayers detection follows accessible map references, including element data
stores, without needing a global `ol`. It supports finite pixel-image grids;
geographic maps and arbitrary reprojection are not inferred to be artwork.
The [issue corpus](tests/browser/corpus/openlayers/README.md) records provenance,
replay coverage and unavailable historical examples.

## Saving and packaging

Optional tile retries await approval in the job tab and retain successful tiles.
Cancellation settles pending approval; incomplete downloads are not saved.

A clean result finishes only when the browser download manager confirms saving.
Keep its Blob URL alive until a terminal event or cancellation settles. A tainted
canvas is display-only. Open/reveal actions use the confirmed download identity.

[`wxt.config.ts`](wxt.config.ts) owns Chromium/Firefox manifests. Declare only
permissions shipped code uses; ship no permanent host access or content scripts.
Use root workspace dependencies and the pinned Firefox driver installed by setup.
Store publication uses immutable release artifacts; see
[Operations](../../docs/operations.md).
