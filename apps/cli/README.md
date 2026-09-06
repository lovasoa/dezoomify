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
`-w/--max-width <px>`, `-h/--max-height <px>`, `--zoom-level <n>`,
`--image-index <n>`, `-n/--parallelism <n>` (default 16),
`-r/--retries <n>` (default 3, 0 allowed), `--retry-delay <duration>`
(default 2s), `--compression <0-100>` (default 5),
`--max-idle-per-host <n>` (default 32), `--accept-invalid-certs`,
`-H/--header "Name: value"`, `-i/--min-interval <duration>` (default 0),
`--timeout <duration>` (default 30s), `--connect-timeout <duration>`
(default 6s), `--logging <level>` (default info), `-c/--tile-cache <dir>`,
`--bulk <file-or-url>`, `--outfile <file>`, `-?/--help`, `-V/--version`.

Each single run saves one job to one output file (PNG, JPEG, TIFF, or IIIF
folder by extension). When the output is omitted it auto-names from the
image title when known, else `dezoomified` with a JPEG-fit extension
(small images use `.jpg`, large or unknown sizes use `.png`) and `_0001`
collision suffixes. With no arguments the tool repeats prompts when a
terminal is present until end of input, else prints help. When several
images or levels are found and no `--image-index` or level cap was given,
a terminal prompts to pick one (any number works; too large uses the
last); without a terminal the first image and automatic level win.
Missing input without a terminal prints help; unknown flags fail with
exit 2. `--tile-cache` reuses downloaded tiles
across runs; `--retries` overrides the tile retry budget of 3 (0 means no
retries). `--image-index`, `--zoom-level`,
`--max-height`, `--largest`, `--parallelism` (as `max_concurrent`),
`--retry-delay`, `--compression` (JPEG quality `100 - compression`, PNG
tiers), `--max-idle-per-host`, `--timeout`, `--connect-timeout`, and
per-tile `--min-interval` are wired through to native; bulk
`--min-interval` also paces images. `--dezoomer` is validated against
known formats (unknown names fail with exit 2; the native engine has no
format selector field and auto-detects), and `--logging` (error, warn,
info, debug, trace; default info) controls human stderr verbosity while
`--json` stdout stays machine-only (see
`docs/user/command-line.md`). The default `Referer` is the http(s) bulk source or input URL unless
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
