# Browser runtime

BrowserHost supplies platform operations to the shared Rust algorithm. The
website and extension share application composition and invocation lifetime;
products inject source acquisition, transport, permissions, and saving.
See [Architecture](../../docs/architecture.md) for ownership boundaries.

## Image access

Readable bytes permit processing, decoding, and saving. Ordinary `<img>` loads
can display unprocessed tiles after a network failure, but may taint the canvas.
A tainted canvas stays display-only: never read pixels or promise an encoded save.
HTTP, permission, decoding, processing, and cancellation failures do not qualify
as network fallback. Successful ordinary-image loading classifies the origin
for later tiles in that job.

The website tries direct metadata access before eligible public-metadata proxy
fallback; the extension uses its source session and permission-controlled
transport, never the proxy. Transport preserves request headers, redirect bases,
and typed failures. Retry policy belongs to Rust.

## Resource lifetime

Cancellation updates presentation immediately, but settlement waits for owned
decoding and encoding callbacks. Late bitmaps close without painting; save
continuations must check cancellation before publishing. Product save behavior
determines whether output is ready for a click, confirmed saved, or display-only.

For current canvas and transport limits, consult [limits.ts](src/limits.ts).
Tests: `cargo xtask test browser`.
