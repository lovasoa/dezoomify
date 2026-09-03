# browser-runtime

- **Responsibility:** Host the WASM worker in browsers and implement browser
  capabilities for fetch, transferable bytes, storage, image loading, and file
  export.
- **Allowed dependencies:** `protocol-ts`, generated WASM artifacts, and focused
  browser utilities; expose a host-neutral adapter to `studio-ui`.
- **Forbidden responsibilities:** No UI, dezoomer/domain duplication, cookie-jar
  exposure, protocol redefinition, treating ordinary image loads as readable
  bytes, or bypassing a tainted canvas's `originClean` guards.
- **Interfaces and tests:** Expose job/session control, readable byte results,
  classified transport failures, active-transport state, the user proxy setting,
  and ordinary `<img>` tile loading for cross-origin display. Support host policy
  that tries direct readable fetch before automatic restricted-proxy fallback;
  never treat the fallback as credential consent or expose cookies,
  `Authorization`, or other browser credentials to it. Such tiles may be drawn
  to a visible canvas regardless of proxy eligibility or opt-out; track
  `originClean = false` after a potentially tainting draw and then block
  JavaScript pixel reads, processing, hashing, pixel persistence, `toBlob`,
  `toDataURL`, and clean programmatic export claims. Preserve
  browser/user-agent right-click save where offered. Test worker lifecycle,
  transfer/backpressure, cancellation, direct/fallback ordering, opt-out,
  transport state, CORS, tainted display and guards, storage limits,
  deterministic clean export, and redaction with real-browser fixtures.
- **Migration source:** Extract browser transport and assembly constraints from
  `migration-sources/dezoomify-web/zoommanager.js` and its Playwright tests.
