# command-line

# Command-line tool

Use the CLI for scripts, specific image/level selection, and bulk saving.
Download it from [GitHub Releases](https://github.com/lovasoa/dezoomify/releases/latest)
or build it from the repository with `cargo xtask build cli`.

## Basic use

```sh
dezoomify \
  "https://museum.example/painting" \
  painting.png
```

The first argument is a viewer, metadata address, or supported local file. The
second names the output; omit it for automatic naming. Existing files are
preserved unless you request `--overwrite`.

With no arguments, a terminal prompts for input; without a terminal it prints
help. Interactive runs can ask you to choose an image and level. Scripts use
the first image and automatic level unless you supply selectors.

## Useful options

| Task | Example |
|---|---|
| Select the highest resolution | `--largest` |
| Limit width | `--max-width 4000` |
| Choose an image by index | `--image-index 2` |
| Choose a level by index | `--zoom-level 0` |
| Retry failed tiles more often | `--retries 5` |
| Reuse downloaded tiles | `--tile-cache my-folder` |
| Identify the source viewer | `-H "Referer: <viewer URL>"` |
| Replace an existing file | `--overwrite` |
| Emit machine-readable records | `--json` |

Run `dezoomify --help` for all options, defaults, and selector precedence.
Use `--max-height` to cap height, and replace `<viewer URL>` with the page's address.
`--zoom-level` takes precedence over largest and dimension caps; `--largest`
ignores caps. Error records include a stable `kind`; use it for scripts and
bug reports rather than matching the human sentence.

Output names choose the format: `.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`,
`.webp`, `.avif`, or `.iiif`. An extensionless destination also creates an IIIF tile
folder. Other extensions are rejected. See
[choosing a format](../../apps/desktop/desktop-app.md#choosing-the-file-format).

## Request pacing

The CLI gradually increases tile-request rates after successful requests and
backs off when a server signals limits, respecting its requested wait time.
Use `--start-rps` and `--max-rps` for arbitrary positive rates per server;
`--help` lists defaults. Rates count request starts, not downloaded bytes, and
`--parallelism` independently bounds overlapping work.

`--min-interval` adds a rate ceiling and caps the starting rate to fit. It also
spaces bulk image starts. All tile pacing and recovery use the shared core,
including when an interval is supplied.

## Saving many images

Put one address per line, optionally followed by a title:

```text
# my-collection.txt
https://museum.example/painting-1 Portrait
https://museum.example/painting-2
```

```sh
dezoomify --bulk my-collection.txt \
  --outfile collection.png
```

This saves `collection_1.png`, `collection_2.png`, and so on. A failed entry
does not stop the list; the command reports totals and exits 1 if any entry
failed. Bulk mode selects the largest level unless you supply level caps or a
selector. `--min-interval` paces entries. A single IIIF collection address can
also supply the list; each referenced manifest saves its first image.

## Limits

Very large images are limited by available memory. Explicit raster formats can
reduce buffering compared with automatic format selection; WebP and AVIF need a
complete pixel buffer. AVIF uses quality `max(1, 100 - --compression)` at fixed
encoding speed and does not preserve embedded color profiles. If saving reaches
a resource limit, try a smaller level or an IIIF tile folder. JPEG, WebP and AVIF
have additional dimension limits; see
[rejected output names](./troubleshooting.md#the-output-name-is-rejected).

If a required tile still fails after automatic retries, the job stops without
publishing an image. The error retains its address, attempt count, and original
cause. Increase `--retries` for transient failures or repeat the job to reuse
good cached tiles; see [resuming](../../apps/desktop/desktop-app.md#resuming-an-interrupted-save).

IIIF directories must have unused destinations, even with `--overwrite`.
Compatible IIIF/ZIF tiles retain their original encoding; compression settings
affect converted tiles and new levels. ZIF omits alpha. Open an IIIF export's
`viewer.html` in your browser to view and zoom offline; keep the entire folder
together, including `full/` overview images. For another IIIF web viewer,
resolve the relative service identifier against `info.json` and honor
`preferredFormats`, especially for PNG-only output.

## Next steps

- [Troubleshooting](./troubleshooting.md)
- [Supported formats](./supported-formats.md)
