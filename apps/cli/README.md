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
`--bulk <file-or-url>`, `--outfile <file>`.

Each single run saves one job to one output file (PNG, JPEG, TIFF, or IIIF
folder by extension). With no arguments the tool prompts for input/output
when a terminal is present, else prints help. Missing arguments print help;
unknown flags fail with exit 2. `--tile-cache` reuses downloaded tiles
across runs; `--retries` overrides the tile retry budget of 3.
`--image-index` and per-tile `--min-interval` are parsed with native gaps
(see `docs/user/command-line.md`); bulk `--min-interval` paces images.

Bulk mode saves one output per list entry and never stops early:

```sh
./target/debug/dezoomify-cli --bulk list.txt --outfile collection.png
```

`list.txt` holds one URL per line plus an optional title, `#` comments
ignored. A IIIF collection manifest URL is accepted best-effort (its
`manifests`/`members`/`items` ids become entries; a single manifest saves
its first image). Failures continue with a per-image summary; the exit is 1
when any entry fails.

Errors are redacted (no credentials, cookies, or local paths leak into
output). Tests: `cargo xtask test native` and `cargo xtask test scenario`.

Contributing: argument parsing and presentation live here; format parsing,
downloading, and codecs belong to `dezoomify-native`/`dezoomify-core`.
