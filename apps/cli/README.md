# CLI Application

The `dezoomify` command runs the real download pipeline through
`dezoomify-native`: core discovery, bounded concurrent tile download,
decode/assemble, and output writing, with progress events on the terminal
(`--json` for machine-readable events).

```sh
cargo xtask build cli
./target/debug/dezoomify-cli [options] <input-url> <output>
```

Run `./target/debug/dezoomify-cli --help` for the full list: `--overwrite`,
`--json`, `--max-width <px>`, `--accept-invalid-certs`,
`-H/--header "Name: value"`, `--image-index <n>`, `--retries <n>`
(default 3), `--min-interval <duration>` (default 0), `--tile-cache <dir>`,
`--outfile <file>`.

Each run saves one job to one output file (PNG, JPEG, TIFF, or IIIF folder
by extension). Missing arguments print help; unknown flags fail with exit
2. `--tile-cache` reuses downloaded tiles across runs; `--retries`
overrides the tile retry budget of 3. `--image-index` and `--min-interval`
are parsed (see `docs/user/command-line.md` for native gaps); there is no
bulk queue yet and no interactive prompt.

Errors are redacted (no credentials, cookies, or local paths leak into
output). Tests: `cargo xtask test native` and `cargo xtask test scenario`.

Contributing: argument parsing and presentation live here; format parsing,
downloading, and codecs belong to `dezoomify-native`/`dezoomify-core`.
