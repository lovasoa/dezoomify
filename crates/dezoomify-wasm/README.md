# dezoomify-wasm

- **Responsibility:** Bind the portable core/job engine to JavaScript and
  translate protocol messages across the WASM boundary. The browser runtime
  owns Web Worker creation and lifecycle.
- **Allowed dependencies:** `dezoomify-job`, `dezoomify-core`,
  `dezoomify-protocol`, WASM bindings, and portable browser-safe utilities; it
  does not own worker APIs.
- **Forbidden responsibilities:** No DOM/UI policy, direct native I/O, cookie-jar
  access, open-proxy behavior, or assumptions that opaque responses have bytes.
- **Interfaces and tests:** Expose a versioned worker/job API with transferable
  readable bytes and explicit capability results. Ordinary cross-origin image
  loading, display-canvas drawing, and `originClean` enforcement remain in the
  JavaScript browser host. Test WASM serialization, cancellation, memory bounds,
  and browser-runtime integration.
- **Migration source:** Migrate portable browser orchestration behavior from
  `migration-sources/dezoomify-web`, while core format logic comes from
  `migration-sources/dezoomify-rs/dezoomify-core`.
