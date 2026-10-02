# Security

Source sites, metadata, tiles, handoff payloads, and output names are all untrusted input. Each runtime takes only the access its active user-started job needs.

## Trust boundaries

- The website runs under normal browser origin rules.
- Page policy allows cross-origin images for plain tile display; shown tiles taint the canvas, keeping it unreadable to scripts, so no pixels leak that way.
- The metadata proxy is a restricted fetcher for eligible public, non-credential metadata, never a credential endpoint or tile relay.
- The extension background accepts requests only from its own authenticated contexts.
- Native apps reach network and filesystem, so they validate typed input and require user-picked local destinations.

Parsers and decoders cap input, dimensions, tile counts, allocation, recursion, and decompression. URLs normalize before policy checks. Redirects carrying credentials revalidate every hop.

## Credentials

Auth headers, cookies, signed URLs, and tokens appear in no analytics, user-visible cache keys, or ordinary handoffs. Diagnostic capture preserves supplied URLs, query parameters, paths, and settings as supplied. Capture sites record header names, never authorization-header or cookie values. Reports contain no image bytes or full response bodies; HTTP failures may retain a bounded server signal. Reports stay local until the user copies, saves, or opens a prefilled issue draft. The extension's technical-details panel shows a conditional sign-in warning before its sharing controls; it does not infer authentication from cookies. User guidance: [extension data use](user/browser-extension.md#what-the-extension-does-with-your-data).

Website direct and proxy requests omit cookies and `Authorization`. The proxy also forwards no caller credentials upstream and never fetches credential-bearing resources. Signed or token-bearing URLs are proxy-ineligible. The extension fetches in the tab origin with the page's session and from the extension origin credential-free, only for origins under active host permissions. It does not send browser cookies or other credentials to another product.

The secret/credential query-key vocabulary lives once in Rust (`SENSITIVE_QUERY_KEYS` in [`model.rs`](../crates/dezoomify/src/model.rs)) and crosses the boundary only as the `isSecretKey`/`hasSecretParams` callables; TypeScript callers with a runtime ask the boundary. The one TypeScript list (`SENSITIVE_QUERY_KEYS` in [`source-url.ts`](../packages/shared-ui/src/source-url.ts)) is the wire-format counterpart of `isSecretKey`, kept only for pure callers that load no runtime. The deliberately narrower signed-params policy (`SIGNED_QUERY_KEYS`) governs metadata-proxy eligibility and is applied through one `hasSignedQuery` check by both `web-fetch.ts` and `src/server/security.ts`. Desktop settings and trusted-header validation live once in the native shell (`parse_settings`/`parse_header_line`) with direct unit tests; the frontend shape-normalizes only and trusts the shell's typed rejection. The retry policy exists once in Rust (`Error::retryable`) and is exposed at each host boundary (`isRetryable`/`is_retryable`); TypeScript holds no copy. Deep-link parsing lives once in the native shell (`parse_deep_link`), pinned by `testdata/deep-link-vectors.json`; the frontend never parses raw links and its payload validation refuses them.

## Proxy controls

Direct browser fetch goes first with a short 1500 ms completion window. A classified CORS or network failure, or an unfinished direct fetch inside that window, triggers automatic proxy fallback, and only for an eligible public, non-credential `http(s)` metadata request. No per-attempt consent. The website shows the active transport. Full order: [Browser runtime](browser-runtime.md#request-order).

The proxy allows only supported methods and serves metadata only, never tiles. It resolves and rejects loopback, private, link-local, reserved, and cloud-metadata addresses before connecting and after redirects. It rechecks eligibility across redirects; bounds redirects, bytes, duration, and concurrency; accepts only expected metadata content (structured metadata, viewer HTML; image bodies rejected); omits credentials; strips non-allowlisted headers; forwards the client's User-Agent, Accept-Language, and Accept upstream and sends the target URL as Referer; and applies abuse controls. The page holds at most 4 proxy requests in flight and starts at most 4 per second under one global budget; direct tile requests pace separately. A transient rate-limit response retries at most once after a bounded delay; persistent throttles fail closed. Auth failures and ordinary HTTP errors never qualify as CORS/network failures and never trigger fallback.

## Extension and desktop

Extension behavior is defined once in [Extension](extension.md): the job tab owns each job and calls finite source operations directly after the toolbar action; there are no content scripts, no `<all_urls>`, no metadata proxy, and the background only launches and focuses the job page. Source results are validated at the job-page boundary and bounded before transfer; cookies and auth values never leave the source tab. Tauri exposes allowlisted commands and opaque file handles instead of raw paths where practical. The desktop declares only permissions its shipped code uses, and external links leave only through `opener:allow-open-url` for valid `https` URLs.

Website deep links are untrusted input for native validation plus user confirmation; no client-side signing. They contain bounded non-secret job input and never transfer browser credentials. Security regressions are covered in [Testing](testing.md).
