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
| Cap the resolution (e.g. 4000 pixels wide) | `--max-width 4000` |
| Pick a specific image when several are found | `--image-index 2` (0-based; the native driver currently resolves the first entry) |
| Retry more often on an unreliable server | `--retries 5` (default 3) |
| Go slower to stay gentle with the server | `--min-interval 200ms` (parsed; per-tile throttling needs native support) |
| Look like you come from the site's viewer | `-H "Referer: <viewer page>"` (`--header` is an alias) |
| Keep saved pieces to resume later | `--tile-cache my-folder` |
| Turn off address checking for odd servers | `--accept-invalid-certs` (careful: this disables protection against impostor servers) |
| Overwrite an existing file | `--overwrite` |
| Print machine-readable records | `--json` |

Run `dezoomify --help` for the full list.

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
