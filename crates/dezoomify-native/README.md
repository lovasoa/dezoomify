# dezoomify-native

- **Responsibility:** Implement trusted native host capabilities: HTTP,
  filesystem, cache, image decoding/encoding, concurrency, and local outputs.
- **Allowed dependencies:** `dezoomify-job`, `dezoomify-core`,
  `dezoomify-protocol`, and native networking/runtime/codec libraries.
- **Forbidden responsibilities:** No CLI presentation, desktop UI, browser APIs,
  format parsing duplicated from core, credentials in errors/logs, or trust in a
  Native Messaging payload based only on a challenge or nonce.
- **Interfaces and tests:** Expose native job drivers and capability adapters.
  Test with the fixture server for headers, redirects, retries, cache/resume,
  cancellation, codecs, output atomicity, and credential redaction. Native
  Messaging relies on browser enforcement of the native host manifest's allowed
  extension IDs to authenticate the extension sender. Use a fresh
  challenge/nonce to bind one handoff and its consent and block replay, never as
  identity proof. Accept any cookie handoff only after explicit consent, scope
  it to named origins, avoid intentional persistence, and retain it for a
  best-effort short lifetime without promising impossible zeroization.
- **Migration source:** Migrate networking, download state, cache, and encoders
  from `migration-sources/dezoomify-rs/src`.
