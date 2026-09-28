# browser-runtime

What the browser can and cannot do with image bytes, in one place: readable
fetches for decoding and saving, versus ordinary `<img>` display that stays
visible but tainted. Script may show it, never read its pixels
(`originClean` guards enforce this).

`BrowserHost` supplies asynchronous operations to the Rust `dezoomify`
function. The website and extension share `createBrowserApplication` for
invocation lifetime, interactions, progress, history, and output presentation.

Products inject source acquisition, transport, permissions, and saving.
Opaque loads never provide readable bytes. Tests: `cargo xtask test browser`.
