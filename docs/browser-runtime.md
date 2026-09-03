# Browser runtime

`packages/browser-runtime` combines `crates/dezoomify-wasm` with the shared Studio. The runtime owns workers, image decode, canvas and export surfaces, and an optional bounded browser cache. WASM only adapts core, job, and pure processing code.

## Opaque image path

For ordinary website tiles with `ProcessingRecipe::None`, the runtime may load through `<img>` and draw into a canvas even when the source taints it. The canvas remains visible, and the user can use the browser's right-click or other user-agent save support where available.

Once a canvas is tainted, the runtime never invokes JavaScript pixel reads, hashing, processing, `toBlob`, or `toDataURL` on it and never promises a clean programmatic export. Studio labels this limitation before rendering and offers a readable route when the user needs processing or clean export.

## Readable-byte path

Readable metadata, processed tiles, and clean export use bytes obtained first by direct CORS fetch. After a classified CORS or network failure, Web Studio automatically retries an eligible public, non-credential resource through the restricted Cloudflare proxy unless the user has opted out. Readable responses are transferred to workers, decoded, processed according to the core recipe, and encoded or assembled for download. Byte and pixel limits are checked before allocation.

Object URLs are scoped to the job and revoked after use. The optional browser cache stores only non-sensitive reusable data within configured quotas; see [Security](security.md).

## Request order

Web Studio uses this order:

1. Direct readable browser fetch with cookies, `Authorization`, and browser credentials omitted.
2. After a classified CORS or network failure, automatic restricted Cloudflare proxy fallback when the resource is public and non-credential, readable bytes are required, and proxy use is enabled.
3. For unprocessed ordinary tiles, an `<img>` surface when display is possible without readable bytes.
4. A typed recovery action offering the [extension](extension.md) or [native app](native-apps.md) when no accepted browser route can supply readable bytes.

Studio always shows the active transport as direct or restricted proxy, including an automatic transition after the classified direct failure. Proxy fallback requires no per-attempt consent. A user can opt out before or during a job; while proxy use is disabled, Web Studio sends no new proxy requests and offers only eligible non-proxy recovery. Re-enabling the preference is not consent for a particular request.

The proxy is not a general relay. Both the browser-to-proxy request and the proxy's upstream request omit cookies, `Authorization`, and browser credentials. The proxy accepts only validated image and metadata requests for eligible public resources, blocks private and local networks, follows bounded redirects, limits size and duration, strips headers outside its allowlist, and returns explicit CORS headers. Details are in [Security](security.md).

## Limits and capabilities

At startup the runtime reports codec support, worker and storage availability, maximum practical canvas and allocation sizes, proxy availability, and supported output modes. The job engine validates plans against these [capabilities](protocol.md#capabilities). Jobs that exceed browser limits offer native handoff before tile download begins.
