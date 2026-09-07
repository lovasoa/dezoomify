# command-line

# Command-line tool

The command-line tool saves one image per run, or many with `--bulk`. It
is the right choice for scripts and for automating regular jobs. It
supports [protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).
Each run saves one job to one output file (`.png`, `.jpg`/`.jpeg`,
`.tif`/`.tiff`, `.zif`, `.webp`, `.iiif`, or extensionless `iiif-dir` by
extension). `--tile-cache` keeps a resume folder so a repeated run
reuses tiles instead of fetching them again; see
[resuming an interrupted save](./desktop-app.md#resuming-an-interrupted-save).

## Basic use

```sh
dezoomify "https://museum.example/collection/painting" painting.png
```

The first argument is the address of the viewer page or image description
file; the second is the file to save (or pass `--outfile <file>` instead
of the positional). When the output is omitted it auto-names from the
image title when known, else `dezoomify` with a JPEG-fit extension and
`_0001` collision suffixes. With no arguments the tool repeats prompts
when a terminal is present until end of input, else it prints help. When
several images or levels are found and no selector was given, a terminal
prompts to pick one; without a terminal the first image and automatic
level win. The tool takes the exact `--zoom-level` when given, else the
largest level that fits `--max-width`/`--max-height` when given, else the
largest level (`--largest`, implied in bulk mode without level caps,
ignores caps).

## Useful options

| You want to… | Option |
|---|---|
| Let the tool detect the format, or force one | `-d, --dezoomer auto` (default; a named format selects the single program, unknown names fail) |
| Always take the highest resolution | `-l, --largest` (implied in bulk mode without level caps) |
| Cap the resolution (e.g. 4000 pixels wide) | `-w, --max-width 4000` |
| Cap the height | `-h, --max-height 800` |
| Pick a level by index | `--zoom-level 0` (0 is smallest; too large uses last; wins over largest and caps) |
| Pick a specific image when several are found | `--image-index 2` (0-based; too large uses last) |
| Keep a partial image when some tiles fail | `--keep-partial` (default; missing regions stay blank, saved to a `.partial` sibling: `out.png` becomes `out.partial.png`) |
| Discard partial output on tile failure | `--no-partial` (fails with `tile.download-failed` and no output) |
| Retry more often on an unreliable server | `-r, --retries 5` (default 3; 0 means no retries) |
| Wait before retrying | `--retry-delay 2s` (delay before first retry, then doubling, plus per-tile jitter) |
| Tune output compression | `--compression 5` (JPEG quality `100 - compression`, default 95; PNG fast/balanced/best tiers) |
| Tune the connection pool | `--max-idle-per-host 32` (max idle connections per host) |
| Go slower to stay gentle with the server | `-i, --min-interval 200ms` (bulk paces images; per-tile requests are staggered) |
| Tune timeouts | `--timeout 30s`, `--connect-timeout 6s` (max time for one request and to connect) |
| Tune logging | `--logging info` (error, warn, info, debug, trace; controls human stderr verbosity, `--json` stdout unchanged) |
| Tune concurrency | `-n, --parallelism 16` (max concurrent tile downloads) |
| Look like you come from the site's viewer | `-H "Referer: <viewer page>"` (`--header` is an alias; otherwise the http(s) input or bulk source is sent as `Referer`) |
| Keep saved pieces to resume later | `-c, --tile-cache my-folder` |
| Turn off address checking for odd servers | `--accept-invalid-certs` (careful: this disables protection against impostor servers) |
| Overwrite an existing file | `--overwrite` |
| Print machine-readable records | `--json` |

Run `dezoomify --help` (`-?` is an alias) for the full list. `-V` shows the version.

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
end and the exit is 1 when any entry fails. The totals read the same as the
desktop app queue (`bulk: X succeeded, Y failed, Z total`). You can also pass a single IIIF
collection manifest address to `--bulk` to save the entries it lists
(best-effort: `manifests`/`members`/`items` ids; a single manifest saves its
first image). Between images `--min-interval` paces the queue.

## Limits

The command-line tool holds the image in memory within a 1 GiB canvas budget, while the [desktop app](./desktop-app.md) allows up to 8 GiB.
A larger save stops with a typed `output.canvas-limit` error before anything is written; save a smaller level with `--max-width`.
See [very large pictures](./troubleshooting.md#the-image-appears-blank-or-the-browser-slows-to-a-halt) when a browser tab cannot hold the image.

## Next steps

- [Desktop app features](./desktop-app.md)
- [Supported formats](./supported-formats.md)
