# CLI Application (preview scaffold)

The `dezoomify` command parses args and fails closed until the native
download pipeline lands. Real inputs exit non-zero with an honest
not-implemented error; no files are written and no fake hashes are printed.

```sh
cargo xtask build cli
./target/debug/dezoomify-cli --help
```

Errors are redacted (no credentials, cookies, or local paths leak into
output). Tests: `cargo xtask test native` and `cargo xtask test scenario`.

Contributing: argument parsing and presentation live here; format parsing,
downloading, and codecs belong to `dezoomify-native`/`dezoomify-core`.
