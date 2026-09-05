# dezoomify-native

Does the actual downloading outside browsers: HTTP with redirects/retries,
resume cache, image decoding/encoding, concurrency, and atomic file output —
with credentials redacted from every error, log, and snapshot. Powers the CLI
and desktop app (and the extension's Native Messaging host).

```sh
cargo xtask test native     # runtime suites
cargo xtask test scenario   # end-to-end scenarios + CLI snapshots
cargo xtask build cli       # the `dezoomify` executable
```
