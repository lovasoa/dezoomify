# Security

Source pages, metadata, tiles, and output names are untrusted input. Apply
protections for concrete risks while retaining Dezoomify's ability to download
very large images. Each runtime takes only the access its user-started job needs.

## Trust boundaries

- The website obeys browser origin rules. Cross-origin images may display on a
  tainted canvas, but script cannot read or encode its pixels.
- The extension scans only after explicit user action. Its job tab owns source
  access and permissions; source navigation invalidates that access.
- Native apps can reach network and filesystem, so native validation and output
  publication must protect destinations independently of frontend checks.
- Parsers and decoders bound untrusted data and allocations. Keep limits high
  enough for gigapixel work and preserve typed failures.

## Credentials

Website requests omit cookies and Authorization; its proxy handles only public
metadata. The extension can fetch from the source document with that site's
browser session. Extension-origin fetches are credential-free and require active
host permissions. It does not transfer browser credentials to desktop.

Diagnostics are local until the user shares them. They preserve exact supplied
URLs, query parameters, paths, settings, and error causes; do not promise automatic
sanitization. Avoid recording authentication headers and cookies, and tell users
to review reports before sharing. See [extension data use](user/browser-extension.md#what-the-extension-does-with-your-data).

Use the shared secret-query helpers from the Rust boundary where a runtime is
available; pure TypeScript callers use [`source-url.ts`](../packages/shared-ui/src/source-url.ts).
Proxy eligibility uses its narrower signed-query policy, not an independently
invented credential vocabulary.

## Proxy controls

The metadata proxy must not become a general-purpose network relay. Public
metadata only, no tiles or credentials; reject private and reserved destinations
before connection and across redirects. Bound redirects, response bodies,
duration, and concurrency, and allowlist forwarded headers.

[`src/server/security.ts`](../src/server/security.ts) owns eligibility and network
policy, shared by local and deployed proxy adapters. The browser transport owns
fallback; HTTP refusals must not be reclassified as CORS failures to bypass them.

## Extension and desktop

Declare only permissions shipped code uses. Keep scans explicit and permissions
requested from a visible user action. Validate injected source results at the
job-page boundary; implementation notes are in the [extension README](../apps/extension/README.md).

Tauri uses allowlisted commands and opaque saved-file handles where practical.
Validate deep links natively and confirm them before starting work. Deep links
carry bounded non-secret input, never browser credentials. Open external links
only through the declared opener capability. Choose useful regression coverage
from [Testing](testing.md).
