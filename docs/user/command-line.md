# command-line

# Command-line tool

The command-line tool saves one image per run, or many with `--bulk`. It
is the right choice for scripts and for automating regular jobs. It
supports [protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).
Each run saves one job to one output file (PNG, JPEG, TIFF, or IIIF folder
by extension). `--tile-cache` keeps a resume folder so a repeated run
reuses tiles instead of fetching them again; see
[resuming an interrupted save](./desktop-app.md#resuming-an-interrupted-save).

## Basic use

```sh
dezoomify "https://museum.example/collection/painting" painting.png
```

The first argument is the address of the viewer page or image description
file; the second is the file to save (or pass `--outfile <file>` instead
of the positional). With no arguments the tool prompts for both when a
terminal is present, else it prints help. The tool takes the largest level
that fits `--max-width` when given, else the largest level.

## Useful options

| You want to… | Option |
|---|---|
| Let the tool detect the format, or force one | `-d, --dezoomer auto` (default; named formats fall back to auto-detect) |
| Always take the highest resolution | `-l, --largest` (implied in bulk mode without level caps) |
| Cap the resolution (e.g. 4000 pixels wide) | `-w, --max-width 4000` |
| Cap the height | `--max-height 800` (or `-h 800`; bare `-h` shows help, as does `--help` and `-?`) |
| Pick a level by index | `--zoom-level 0` (0 is smallest; too large uses last; needs native support) |
| Pick a specific image when several are found | `--image-index 2` (0-based; the native driver currently resolves the first entry) |
| Retry more often on an unreliable server | `-r, --retries 5` (default 3; 0 is parsed but the engine clamps to at least 1) |
| Wait before retrying | `--retry-delay 2s` (parsed; timing needs native support) |
| Tune output compression | `--compression 5` (parsed; native encodes JPEG at quality 92) |
| Tune the connection pool | `--max-idle-per-host 32` (parsed; pooling needs native support) |
| Go slower to stay gentle with the server | `-i, --min-interval 200ms` (parsed; per-tile throttling needs native support) |
| Tune timeouts | `--timeout 30s`, `--connect-timeout 6s` (parsed; native uses 60s and 15s) |
| Tune logging | `--logging info` (parsed; reporting stays human lines plus `--json`) |
| Tune concurrency | `-n, --parallelism 16` (parsed; native runs 6 concurrent fetches) |
| Look like you come from the site's viewer | `-H "Referer: <viewer page>"` (`--header` is an alias; otherwise the http(s) input or bulk source is sent as `Referer`) |
| Keep saved pieces to resume later | `-c, --tile-cache my-folder` |
| Turn off address checking for odd servers | `--accept-invalid-certs` (careful: this disables protection against impostor servers) |
| Overwrite an existing file | `--overwrite` |
| Print machine-readable records | `--json` |

Run `dezoomify --help` for the full list. `-V` shows the version.

## Saving many images

Put the addresses in a text file, one per line, with an optional title after
each one:

```text
# my-collection.txt: lines starting with # are ignored
https://museum.example/painting-1 Portrait of a lady
https://museum.example/painting-2
https://library.example/manuscript/info.json
```

Then:

```sh
dezoomify --bulk my-collection.txt --outfile collection.png
```

This saves `collection_1.png`, `collection_2.png`, and so on. A failed image
does not stop the rest; a per-image summary plus totals are printed at the
end and the exit is 1 when any entry fails. You can also pass a single IIIF
collection manifest address to `--bulk` to save the entries it lists
(best-effort: `manifests`/`members`/`items` ids; a single manifest saves its
first image). Between images `--min-interval` paces the queue.

## Next steps

- [Desktop app features](./desktop-app.md)
- [Supported formats](./supported-formats.md)
