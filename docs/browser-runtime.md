# Browser runtime

`packages/browser-runtime` contains BrowserHost and the shared browser application used by the website and extension. Host operations own fetching, decoding, painting, canvas resources, and saving; application modules own UI composition and invocation lifetime.

## Host operations

Both products call the generated async Rust function with BrowserHost, injecting transport, source acquisition, permission operations, and save behavior into one application. Selection, tile retries, ordering, and partial-output policy belong to the shared [algorithm](algorithm.md). Browser products acquire at most six tiles concurrently and pace request starts per host; each acquisition includes fetching, processing, decoding, and painting.

The shared runtime calls `fetchResource(request, signal)` with the generated `ResourceRequest`, preserving its purpose, URI, and headers; results contain readable bytes and the final redirect URI. Probes compose from the same fetch, decoder, and ordinary-image loader as acquisition. Typed failures preserve the stable transport code, HTTP status, route, and any `Retry-After` hint in milliseconds; the algorithm alone decides whether and when to retry.

Extension fetches use the attempt signal and a local deadline: aborting the attempt cancels pending body reads, while a deadline remains a network timeout rather than a user cancellation. Streaming bodies are bounded before buffering, error previews consume at most 4 KiB, and request limits belong to the configured transport, never to reconstructed algorithm requests. Ordinary-image loads also receive the attempt signal.

- `acquireTile`: the website checks and shows the declared canvas before the first tile, then decodes and paints each good tile at once; the visible canvas is the output throughout, including while paused. Bad tiles fail the acquisition and flow into algorithm retry/partial handling, while a surface failure (canvas limits, allocation, 2D context) fails the job typed at once and never becomes one tile's failure. Probes (`purpose: probe`) share the `probe.ts` helper; a probe kept for output also paints at once.
- `finish`: encodes the surface already on screen and returns the product's actual output disposition. The website reports `browser-save-ready` when its blob URL is ready for the user's save click; the extension reports `browser-save-initiated` after the browser download manager confirms its saved file. A tainted canvas reports `display-only`. Plans lacking declared dimensions size the surface from accumulated placements here. Over-limit dimensions fail typed (`plan-invalid`) before allocation; a refused allocation or 2D context fails typed the same way (`output-unavailable`), and PNG encoding fails as `encode-failed`.
- Tiles draw at planned placement, 1:1 scale. Pixels past the planned edge crop from right and bottom (padded edge tiles); short tiles leave the gap empty. Each bitmap closes right after painting.
- A clean output reports the product's actual save disposition: the website retains a Blob URL for a later save click, the extension awaits the download manager's confirmation and retains the saved-file identity for open/reveal actions, and a tainted display-only canvas skips encoding.

Tiles the browser reads as bytes take the WASM `applyProcessing` path per the core recipe. Ordinary unprocessed tiles without readable bytes fall back to plain `<img>` (display-only): the canvas taints, no bytes result, and the job ends display-only. Only the first tile per origin tries readable bytes; later tiles go straight to `<img>`. Website and extension starts request the algorithm's largest-fitting selection policy with the device's automatic selection limits from [configured limits](../packages/browser-runtime/src/limits.ts); the device tier comes from `userAgentData.mobile` where the browser reports it, with an iOS/Android user-agent fallback. When automatic selection takes a smaller known level than the maximum, the shared UI names the selected and maximum resolutions and offers the desktop app, a maximum retry, and (while the job runs) stop; the choice stays after the smaller job completes. A maximum retry starts with unbounded selection caps, so the algorithm takes the largest known level and the canvas gate reports what cannot work (allocation, context, or PNG encoding) with the desktop-app action. The algorithm chooses the ready image and level, or follows deferred catalog entries on the same job within its existing bound. The shared UI has no manual image or level chooser; other callers can supply interactive selection through awaited chooseImage and chooseLevel capabilities.

## Generated WASM boundary

BrowserHost implements the generated Host interface. Metadata crosses as Uint8Array, choices and outputs as domain values, and failures as structured Error rejections. The bindings convert promises and futures without application policy. See [Architecture](architecture.md#bindings-and-errors).

## Catalog boundary

Hosts consume the ordered generated `Catalog` as is. `Image` entries carry optional `size` and selectable levels with optional `size` and `tileSize`; absent geometry stays unknown. `ImageRequest` entries carry the follow-up `uri` of deferred metadata (a IIIF service, a bulk-list entry) for a fresh bounded attempt. Hosts define no catalog types of their own.

## Ordinary image display

A readable HTTP failure goes directly to the algorithm without an ordinary-image fallback; that fallback addresses unreadable browser responses, not missing files or server error responses, and any retry of a known HTTP failure belongs to the algorithm.

`createBrowserAssembly` owns production canvas allocation, 2D context creation, processing, painting, and PNG encoding; products supply canvas placement, visibility, diagnostics, and `save(Blob, width, height, signal)`. BrowserHost shares its decoder between probes and assembly and disposes it during settlement. Release aborts unfinished execution idempotently while retaining completed dimensions and product-owned output access; released decoders never restart through fallback, and late bitmaps close without painting. Settlement waits for native decoding and PNG encoding callbacks, while cancellation updates the UI immediately. Encoding and save continuations check the attempt signal before publishing output.

For ordinary website tiles with `ProcessingRecipe::None`, the runtime loads through `<img>` and draws into a canvas even when the source taints it. The picture stays visible (browser right-click save where available). Once tainted, the runtime never runs pixel reads, hashing, processing, `toBlob`, or `toDataURL` on that canvas and never promises a programmatic save. The website says so before rendering and points at a readable route (extension or desktop app) when the job needs processing or a clean save.

## Readable-byte fetching

Direct metadata streams stop at 8 MiB and direct tile streams at 64 MiB; the metadata proxy stops at 2 MiB. The transport cancels a body as soon as its limit or attempt signal is reached, and reads at most 4 KiB for an HTTP error preview. Decoding uses asynchronous browser image APIs; processing applies the shared Rust recipe before painting, and size limits are checked before allocation. Object URLs live for one job and are then revoked.

Job diagnostics retain metadata requests and aggregate successful tile traffic. Failed acquisitions retain request, route, status, bounded preview, timing, and placement; repeated failures retain a count and first/last samples. Cancellation adds no fetch-failure noise. The shared report replaces console-dependent activity logs; see [Architecture](architecture.md#diagnostics).

## Request order

Use this order when debugging website requests.

1. Direct browser fetch with cookies, `Authorization`, and browser credentials omitted.
2. After a classified CORS or network failure, or a direct fetch not completing within the 1500 ms metadata window, automatic metadata CORS proxy fallback when the metadata request is public and non-credential.
3. For unprocessed ordinary tiles, one direct readable attempt classifies each origin. A successful ordinary `<img>` fallback marks that origin display-only for the job, so later ordinary tiles load directly through `<img>`.
4. The UI offers the [extension](extension.md) or [native app](native-apps.md) when no accepted browser route supplies readable bytes.

The website always shows the active transport, including the automatic switch after a classified direct failure. No per-attempt consent exists. An HTTP error remains an HTTP error when its diagnostic body times out; it never triggers proxy fallback. A proxy deadline reports a transient `proxy-error`, while cancelling the job reports `cancelled`. Metadata with headers other than `Accept` and `Accept-Language` is proxy-ineligible, since those are the only algorithm headers the proxy can forward unchanged. The extension transport is tab-origin direct fetch plus `<img>` display-only fallback and never uses the metadata proxy; see [Extension](extension.md#fetching-and-permissions). Proxy controls: [Security](security.md#proxy-controls).

## Limits and capabilities

The browser selects levels using configured canvas limits and validates allocation before painting. A job exceeding those limits fails with a typed error pointing to the native app.
