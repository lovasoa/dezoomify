# dezoomify-native (native effect runtime)

Real native egress and output: a rustls-based HTTP client with per-redirect
header rebuild, size/time limits and bounded retries; the full download
pipeline (core discovery -> tile plan incl. generic probe resolution ->
concurrent bounded download -> decode/assemble -> PNG encode -> atomic write
-> real sha256); plus auth/header scope (credentials redacted from every
error, log, and snapshot), bounded scheduler counters, cache helpers, and
output validation.

```sh
cargo xtask test native     # runtime + CLI suites, loopback egress tests
cargo xtask test scenario   # fixture-server scenarios pinning real digests
cargo xtask build cli       # the `dezoomify` executable
```
