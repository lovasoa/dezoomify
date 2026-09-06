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
`--json`, `-d/--dezoomer <name>` (default auto), `-l/--largest`,
`-w/--max-width <px>`, `--max-height <px>` (`-h <px>` sets height; bare
`-h` shows help), `--zoom-level <n>`, `-n/--parallelism <n>` (default 16),
`-r/--retries <n>` (default 3, 0 allowed), `--retry-delay <duration>`
(default 2s), `--compression <0-100>` (default 5),
`--max-idle-per-host <n>` (default 32), `--accept-invalid-certs`,
`-H/--header "Name: value"`, `-i/--min-interval <duration>` (default 0),
`--timeout <duration>` (default 30s), `--connect-timeout <duration>`
(default 6s), `--logging <level>` (default info), `-c/--tile-cache <dir>`,
`--bulk <file-or-url>`, `--outfile <file>`, `-h/--help/-?`, `-V/--version`.

Each single run saves one job to one output file (PNG, JPEG, TIFF, or IIIF
folder by extension). With no arguments the tool prompts for input/output
when a terminal is present, else prints help. Missing arguments print help;
unknown flags fail with exit 2. `--tile-cache` reuses downloaded tiles
across runs; `--retries` overrides the tile retry budget of 3 (0 is parsed;
the job engine clamps to at least 1). `--image-index`, `--zoom-level`,
`--max-height`, per-tile `--min-interval`, `--parallelism`,
`--retry-delay`, `--compression`, `--max-idle-per-host`, `--timeout`,
`--connect-timeout`, `--logging`, and non-auto `--dezoomer` are parsed with
native gaps (see `docs/user/command-line.md`); bulk `--min-interval` paces
images. The default `Referer` is the http(s) bulk source or input URL unless
`-H "Referer: …"` overrides it; `--largest` (implied in bulk mode without
level caps) selects the uncapped level.

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
