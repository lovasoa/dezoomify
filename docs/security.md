# Security

Source sites, metadata, tiles, handoff payloads, and output names are all untrusted input. Each runtime takes only the access its active user-started job needs.

## Trust boundaries

- The website runs under normal browser origin rules.
- Page policy allows cross-origin images for plain tile display; shown tiles taint the canvas, keeping it unreadable to scripts, so no pixels leak that way.
- The metadata proxy is a restricted fetcher for eligible public, non-credential metadata, never a credential endpoint or tile relay.
- The extension background accepts requests only from its own authenticated contexts.
- Native apps reach network and filesystem, so they validate protocol input and require user-picked local destinations.
- Core and job parse and decide without performing effects.

Parsers and decoders cap input, dimensions, tile counts, allocation, recursion, and decompression. URLs normalize before policy checks. Redirects revalidate every hop.

## Credentials

Auth headers, cookies, signed URLs, and tokens stay in the runtime that received them. They appear in no analytics, user-visible cache keys, or ordinary handoffs. Error details name the full request URL with a bounded server signal; they sit inert on the device until the user opens the prefilled report link, which warns to strip sign-in details and tokens before submitting. Credentials never enter the prominent message.

Website direct and proxy requests omit cookies and `Authorization`. The proxy also forwards no caller credentials upstream and never fetches credential-bearing resources. Signed or token-bearing URLs are proxy-ineligible. The extension uses the browser session only for origins under active host permissions. Cookies pass extension-to-native only after consent naming origins, scope, recipient, and job; consent never covers later jobs.

Transferred cookies persist nowhere. Implementations drop references and temp containers at session end, but claim no cryptographic erasure in JavaScript or managed browser memory.

## Proxy controls

Direct browser fetch goes first with a short 1500 ms completion window. A classified CORS or network failure, or an unfinished direct fetch inside that window, triggers automatic proxy fallback, and only for an eligible public, non-credential `http(s)` metadata request. No per-attempt consent. The website shows the active transport. Full order: [Browser runtime](browser-runtime.md#request-order).

The proxy allows only supported methods and serves metadata only, never tiles. It resolves and rejects loopback, private, link-local, reserved, and cloud-metadata addresses before connecting and after redirects. It rechecks eligibility across redirects; bounds redirects, bytes, duration, and concurrency; accepts only expected metadata content (structured metadata, viewer HTML; image bodies rejected); omits credentials; strips non-allowlisted headers; and applies abuse controls without logging sensitive URLs. The page holds at most 4 proxy requests in flight and starts at most 4 per second under one global budget; direct tile requests pace separately. A transient rate-limit response retries at most once after a bounded delay; persistent throttles fail closed. Auth failures and ordinary HTTP errors never qualify as CORS/network failures and never trigger fallback.

## Extension and desktop

Extension behavior is defined once in [Extension](extension.md): explicit-action scans on the clicked tab, finite snapshots and tab-origin fetches, no content scripts, no `<all_urls>`, no metadata proxy. Source operations accept only validated engine headers, return one bounded payload, never cookies or auth values. Tauri exposes an allowlisted command surface and opaque file handles instead of raw paths where practical. The desktop declares only permissions its shipped code uses; the frontend calls `query_capabilities` once at boot so grants track live negotiation, and external links leave only through `opener:allow-open-url` for valid `https` URLs.

Website and deep-link handoffs are bounded, secret-free, untrusted input for native validation plus user confirmation; no client-side signing. In Native Messaging, browser enforcement of allowed extension IDs authenticates the sender. Challenge plus one-use nonce bind one session against replay; they prove no identity. Security regressions are covered in [Testing](testing.md).
