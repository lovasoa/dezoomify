# browser-runtime

What the browser can and cannot do with image bytes, in one place: readable
fetches for decoding and saving, versus ordinary `<img>` display that stays
visible but tainted. Script may show it, never read its pixels
(`originClean` guards enforce this).

Hosts the WASM worker (built from `crates/dezoomify-wasm`) and reports the
active transport (direct vs. metadata proxy) to the UI.

Contributing: no UI, no cookie-jar exposure, no treating opaque loads as
bytes. Tests: `cargo xtask test browser`.
