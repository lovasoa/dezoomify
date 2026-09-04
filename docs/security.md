# Security

dezoomify-ng treats source websites, image metadata, tiles, handoff payloads, and output names as untrusted input. Each runtime grants only the access needed for the active user-requested job.

## Trust boundaries

- The website runs under normal browser origin rules.
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

The website attempts a direct browser fetch first. Only a classified CORS or network failure can trigger automatic metadata CORS proxy fallback, and only when proxy use is enabled and the metadata request is an eligible public, non-credential `http` or `https` destination. There is no per-attempt proxy consent. The website shows the active transport and honors opt-out by issuing no new proxy requests while the preference is disabled.

The proxy permits only supported HTTP methods and serves metadata only, never tiles. It resolves and rejects loopback, private, link-local, reserved, and cloud-metadata addresses before connecting and after redirects. It rechecks public-resource and credential eligibility across redirects; bounds redirects, response bytes, duration, and concurrency; validates expected metadata content; omits credentials; strips request and response headers outside an allowlist; and applies abuse controls without recording sensitive URLs. Authentication failures and ordinary HTTP application errors do not qualify as CORS or network failures and do not activate the fallback.

## Extension and desktop

Extension scans begin only with an explicit action, register before at most one reload, stop at a finite deadline, and never reload-rearm; see [Extension](extension.md). Content scripts cannot invoke arbitrary browser-session fetches. Tauri exposes an allowlisted command surface and passes opaque file handles instead of unrestricted paths where practical.

Website and deep-link handoffs are bounded, non-secret, untrusted input that native validates and the user confirms; they use no client-side signing. For Native Messaging, browser enforcement of the native host's allowed extension IDs authenticates the extension sender to the native host. A fresh challenge and one-use nonce bind messages to one session and prevent replay; they do not establish identity. Security regressions are covered by shared and host-specific tests in [Testing](testing.md).
