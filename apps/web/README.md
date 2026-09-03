# Web Application

- **Responsibility:** Deploy the studio UI and browser runtime, configure worker
  assets, and provide only the narrowly secured server endpoints the web host
  requires.
- **Allowed dependencies:** `packages/studio-ui`,
  `packages/browser-runtime`, `packages/protocol-ts`, and deployment tooling.
- **Forbidden responsibilities:** No open proxy, domain logic, hand-written
  protocol copies, cookie/`Authorization`/browser-credential forwarding,
  private/local proxy destinations, out-of-policy proxy requests, or assumptions
  that all browser responses are readable.
- **Interfaces and tests:** Expose the web entry point, worker/assets, and any
  documented restricted proxy capability. Try direct readable fetch first; only
  after a classified CORS/network failure, automatically use the proxy for an
  eligible public non-credential resource when the user setting permits it.
  Clearly show the active transport, provide an opt-out, and do not require a
  per-attempt proxy consent prompt. Enforce method, scheme, port, destination,
  content, size, time, redirect, concurrency, rate, and session-budget limits.
  Ordinary cross-origin `<img>` tiles may still be drawn to a display canvas and
  remain visible or user-agent-saveable after it becomes tainted. Track
  `originClean = false`; forbid JavaScript pixel reads, processing, hashing,
  pixel persistence, `toBlob`, `toDataURL`, and claims of clean programmatic
  export, not display itself. Test direct readable fetch, classified automatic
  fallback, opt-out, transport visibility, proxy exclusions and limits, tainted
  display and guards, cancellation, clean export, responsive UI, and
  fixture-backed end-to-end jobs.
- **Migration source:** Migrate user flow and proxy requirements from
  `migration-sources/dezoomify-web`, replacing legacy security-sensitive
  behavior rather than copying it blindly.
