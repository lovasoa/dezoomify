# Security

dezoomify treats source websites, image metadata, tiles, handoff payloads, and output names as untrusted input. Each runtime grants only the access needed for the active user-requested job.

## Trust boundaries

- The website runs under normal browser origin rules.
- The website page policy permits cross-origin images for ordinary tile
  display; displayed cross-origin tiles taint the canvas, which stays
  unreadable to scripts, so no pixel data leaves the page that way.
- The metadata CORS proxy is a restricted metadata fetcher for eligible public, non-credential metadata requests, not a trusted credential endpoint and never a tile relay.
- The extension background worker has elevated browser access but accepts requests only from its own authenticated extension contexts.
- Native apps can access the network and filesystem, so they validate protocol input and require user-selected local destinations.
- Core and job crates parse data and decide behavior without performing effects.

All parsers and decoders enforce input, dimension, tile-count, allocation, recursion, and decompression limits. URLs are normalized before policy checks. Redirects are revalidated at every hop.

## Credentials

Authorization headers, cookies, signed URLs, and tokens stay within the runtime that receives them. They are omitted from logs, analytics, cache keys visible to users, error messages, and ordinary handoff payloads.

The website's direct browser fetch and browser-to-proxy request use credential omission and do not attach cookies or `Authorization`. The proxy also never forwards cookies, `Authorization`, browser credentials, or other caller credentials upstream and never fetches authenticated or otherwise credential-bearing resources. Signed or token-bearing URLs and requests requiring credentials are ineligible for proxy fallback. The extension may use the current browser session only for origins covered by active host permissions. Cookies pass only from extension to native after explicit consent identifies origins, scope, recipient, and job; consent is not reusable for later jobs.

Transferred cookies are not intentionally persisted. Implementations drop references and temporary containers when the consent session ends, but do not claim cryptographic zeroization in JavaScript or managed browser memory.

## Proxy controls

The website attempts a direct browser fetch first with a short (1500 ms) completion window. A classified CORS or network failure, or a direct fetch that does not complete within that window, triggers automatic metadata CORS proxy fallback, and only when the metadata request is an eligible public, non-credential `http` or `https` destination. There is no per-attempt proxy consent. The website shows the active transport.

The proxy permits only supported HTTP methods and serves metadata only, never tiles. It resolves and rejects loopback, private, link-local, reserved, and cloud-metadata addresses before connecting and after redirects. It rechecks public-resource and credential eligibility across redirects; bounds redirects, response bytes, duration, and concurrency; validates expected metadata content (structured metadata formats and viewer HTML pages; image bodies are rejected); omits credentials; strips request and response headers outside an allowlist; and applies abuse controls without recording sensitive URLs. The frontend never holds more than 4 proxy requests in flight and never starts more than 4 per second against the proxy, under one page-global budget shared by metadata and any tile images fetched through it; direct tile requests keep their own more generous pacing outside that budget. A busy site's transient rate-limit response is retried at most once, after a bounded delay; persistent throttles fail closed. Authentication failures and ordinary HTTP application errors do not qualify as CORS or network failures and do not activate the fallback.

## Extension and desktop

Extension scans begin only with an explicit action: the toolbar click arms
indefinite monitoring on exactly the clicked tab (grey idle, blue with a dot
while monitoring), performs at most one reload, and stops on detection, a
second click, tab close, or navigation away, with no auto-rearm and no
deadline; a worker restart fails closed to idle; see [Extension](extension.md).
The extension never enumerates tabs and its toolbar icon always reports
idle versus monitoring (grey idle action icon, blue brand icons). The in-tab
modal is injected programmatically on the explicit click only (`scripting`
on the clicked tab, no declared content scripts, no `<all_urls>`); it runs
with tab-origin authority:
the monitored tab's origin under activeTab plus explicitly granted host
permissions, with every redirect hop revalidated and the metadata CORS proxy
never used. Content scripts cannot invoke arbitrary browser-session fetches. Tauri exposes an allowlisted command surface and passes opaque file handles instead of unrestricted paths where practical. The desktop app declares only the permissions its shipped code uses: the capability documents grant exactly the commands, event channels, and updater check the shipped shell and frontend exercise. The frontend invokes `query_capabilities` once at boot so the grant always maps to a live negotiation, and external links leave only through the single granted `opener:allow-open-url` command for valid `https` URLs with no fallback attempted.

Website and deep-link handoffs are bounded, non-secret, untrusted input that native validates and the user confirms; they use no client-side signing. For Native Messaging, browser enforcement of the native host's allowed extension IDs authenticates the extension sender to the native host. A fresh challenge and one-use nonce bind messages to one session and prevent replay; they do not establish identity. Security regressions are covered by shared and host-specific tests in [Testing](testing.md).
