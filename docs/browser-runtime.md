# Browser runtime

`packages/browser-runtime` hosts `crates/dezoomify-wasm` for browser-facing
effects; it does not contain the shared UI. The runtime owns workers, image
decode, canvas and save surfaces, and an optional bounded browser cache. WASM
only adapts core, job, and pure processing code.

## Engine-effect assembly

The runtime is the shared effect executor for every browser host of the Rust
job engine (the extension job tab today, the website after its migration).
It owns no job policy: retries, cancellation, partial-output decisions, and
ordering belong to the engine. The executor maps typed host effects onto
browser execution:

- `acquire-tile` carries the complete output placement (position, planned
  extent, declared canvas, processing recipe) plus the engine-declared
  request headers. Hosts decode during acquisition (the native model), so a
  tile that cannot decode fails its acquisition outcome and flows through
  the engine's retry and partial policy.
- `decode-pixels` verifies the held decoded tile; tile bytes never cross
  the effect (the wasm adapter releases its arena copy when the tile
  outcome settles).
- `open-encoder` carries the output format and declared canvas size; the
  host validates actual dimensions and area before allocating the surface
  and fails typed (`PLAN_INVALID` with a desktop handoff) beyond the
  browser limits. Undeclared sizes are derived from the accumulated
  placements.
- `finalize-encoder` draws every held tile at its planned placement (the
  plan is trusted for layout; decoded bitmaps are scaled to the planned
  extent), closes the bitmaps deterministically, and encodes the surface.
- `publish-output` persists the encoded output exactly once (blob anchor
  save; no `downloads` permission).
- `release-bytes` closes every host-retained per-tile resource.

Processing recipes beyond `none` are not executable by the engine-host
assembly yet and fail typed (`TILE_PROCESSING_UNAVAILABLE`) instead of
silently dropping the recipe; the website's discovery-session path keeps
full processing support until the engine contract grows it. The
deterministic catalog selection for engine hosts lives in
`engine-selection.ts` (largest ready image, largest level that fits the
browser canvas, smallest declared level as the fail-fast fallback).

## Catalog boundary

Browser hosts consume the protocol `CatalogDto` with stable `img:` and `lvl:`
identifiers. The WASM discovery session projects its core catalog through the
same `dezoomify-job` projection as the job engine, and planning accepts those
stable identifiers. Browser selection, declared-size preflight, and plan gates
therefore use one generated wire shape; hosts do not define their own catalog
or level DTOs.

## Ordinary image display

For ordinary website tiles with `ProcessingRecipe::None`, the runtime may load through `<img>` and draw into a canvas even when the source taints it. The canvas remains visible, and the user can use the browser's right-click or other user-agent save support where available.

Once a canvas is tainted, the runtime never invokes JavaScript pixel reads, hashing, processing, `toBlob`, or `toDataURL` on it and never promises a clean programmatic save. The website labels this limitation before rendering and offers a readable route when the user needs processing or clean save.

## Readable-byte fetching

Readable metadata, processed tiles, and clean saves use bytes obtained first by
direct browser fetch. After a classified CORS or network failure, the website
automatically retries only an eligible public, non-credential metadata request
through the metadata CORS proxy; tiles are never proxied, so readable tile
bytes on CORS-blocked sources require the extension or the desktop app.
Readable responses are transferred to workers, decoded, processed according to
the core recipe, and encoded or assembled for saving. Byte and pixel limits are
checked before allocation.

Object URLs are scoped to the job and revoked after use. The optional browser cache stores only non-sensitive reusable data within configured quotas; see [Security](security.md).

## Request order

The website uses this order:

1. Direct browser fetch with cookies, `Authorization`, and browser credentials omitted.
2. After a classified CORS or network failure, or a direct fetch that does not complete within the 1500 ms metadata window, automatic metadata CORS proxy fallback when the metadata request is public and non-credential.
3. For unprocessed ordinary tiles, one direct readable attempt classifies each origin. A successful ordinary `<img>` fallback marks that origin display-only for the job, so later ordinary tiles load directly through `<img>`.
4. A typed recovery action offering the [extension](extension.md) or [native app](native-apps.md) when no accepted browser route can supply readable bytes.

The website always shows the active transport as direct browser fetch or the metadata CORS proxy, including an automatic transition after the classified direct failure. Proxy fallback requires no per-attempt consent.

The extension transport is tab-origin direct fetch followed by `<img>` tainted display-only. The extension fetches readable bytes in the monitored tab's origin context under activeTab or granted host permissions; the active transport stays visible in the modal. When readable bytes are unavailable (CORS-blocked without a grant), tiles render as ordinary `<img>` elements: visible but tainted, with no JavaScript pixel reads, hashing, processing, `toBlob`, or `toDataURL`. The extension never uses the metadata CORS proxy.

The proxy is not a general relay and serves metadata only, never tiles. Both the browser-to-proxy request and the proxy's upstream request omit cookies, `Authorization`, and browser credentials. The proxy accepts only validated metadata requests for eligible public resources, blocks private and local networks, follows bounded redirects, limits size and duration, strips headers outside its allowlist, and returns explicit CORS headers. The frontend holds metadata-proxy requests to a single global budget of at most 4 requests in flight and at most 4 request starts per second; direct tile requests never draw from that budget and keep their own per-host pacing. Details are in [Security](security.md).

## Limits and capabilities

At startup the runtime reports codec support, worker and storage availability, maximum practical canvas and allocation sizes, proxy availability, and supported output modes. The job engine validates plans against these [capabilities](protocol.md#capabilities). A job that exceeds browser limits fails with a typed error that points to the native app.
