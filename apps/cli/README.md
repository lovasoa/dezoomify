# CLI Application

The `dezoomify` command for scripts and bulk jobs: give it URLs, get image
files, with progress reporting and meaningful exit codes.

```sh
cargo xtask build cli
./target/debug/dezoomify --help
```

Errors are redacted (no credentials, cookies, or local paths leak into
output). Tests: `cargo xtask test native` and `cargo xtask test scenario`.

Contributing: argument parsing and presentation live here; format parsing,
downloading, and codecs belong to `dezoomify-native`/`dezoomify-core`.
