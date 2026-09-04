# browser-runtime

- **Responsibility:** Host the WASM worker in browsers and implement browser
  capabilities for fetch, transferable bytes, storage, image loading, and file
  saving.
- **Allowed dependencies:** `protocol-ts`, generated WASM artifacts, and focused
  browser utilities; expose a host-neutral interface to `shared-ui`.
- **Forbidden responsibilities:** No UI, format/domain duplication, cookie-jar
  exposure, protocol redefinition, treating ordinary image loads as readable
  bytes, or bypassing a tainted canvas's `originClean` guards.
- **Interfaces and tests:** Expose job/session control, readable byte results,
  classified transport failures, active-transport state, and ordinary `<img>`
  tile loading for cross-origin display. Accept host-supplied transport
  offers and policy rather than owning metadata CORS proxy eligibility or URLs. The
  web integration tries a direct browser fetch before automatic metadata CORS proxy
  fallback; never treat the fallback as credential consent or expose cookies,
  `Authorization`, or other browser credentials to it. Such tiles may be drawn
  to a visible canvas regardless of proxy eligibility or opt-out; track
  `originClean = false` after a potentially tainting draw and then block
  JavaScript pixel reads, processing, hashing, pixel persistence, `toBlob`,
  `toDataURL`, and clean programmatic save claims. Preserve
  browser/user-agent right-click save where offered. Test worker lifecycle,
  transfer/backpressure, cancellation, direct/fallback ordering, opt-out,
  transport state, CORS, tainted display and guards, storage limits,
  deterministic clean save, and redaction with real-browser fixtures.
- **Migration source:** Extract browser transport and assembly constraints from
  `migration-sources/dezoomify-web/zoommanager.js` and its Playwright tests.
