# CLI Application

The `dezoomify` command runs the real download pipeline through
`dezoomify-native`: core discovery, bounded concurrent tile download,
decode/assemble, and output writing, with progress events on the terminal
(`--json` for machine-readable events).

```sh
cargo xtask build cli
./target/debug/dezoomify-cli [--overwrite] [--json] [-H "Name: value"] \
  <input-url> <output>
```

Errors are redacted (no credentials, cookies, or local paths leak into
output). Tests: `cargo xtask test native` and `cargo xtask test scenario`.

Contributing: argument parsing and presentation live here; format parsing,
downloading, and codecs belong to `dezoomify-native`/`dezoomify-core`.
