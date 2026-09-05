# dezoomify-native (policy scaffold, no I/O yet)

Policy bookkeeping outside browsers: auth/header scope, redirect header
stripping, bounded scheduler counters, cache helpers, output validation, and
progress counters — with credentials redacted from every error, log, and
snapshot. No HTTP client, TLS, image decoding/encoding, or file output lives
here yet; callers get bookkeeping only. Powers CLI/desktop scaffolds, which
fail closed until the pipeline lands.

```sh
cargo xtask test native     # runtime suites
cargo xtask test scenario   # end-to-end scenarios + CLI snapshots
cargo xtask build cli       # the `dezoomify` executable
```
