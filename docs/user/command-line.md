# command-line

# Command-line tool

The command-line tool saves one image per run. It is the right choice for
scripts and for automating regular jobs. It supports
[protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).
Each run saves one job to one output file (PNG, JPEG, TIFF, or IIIF folder
by extension). It runs no bulk queue yet. `--tile-cache` keeps a resume
folder so a repeated run reuses tiles instead of fetching them again; see
[resuming an interrupted save](./desktop-app.md#resuming-an-interrupted-save).

## Basic use

```sh
dezoomify "https://museum.example/collection/painting" painting.png
```

The first argument is the address of the viewer page or image description
file; the second is the file to save (or pass `--outfile <file>` instead
of the positional). The tool takes the largest level that fits
`--max-width` when given, else the largest level.

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

## Next steps

- [Desktop app features](./desktop-app.md)
- [Supported formats](./supported-formats.md)
