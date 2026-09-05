# command-line

# Command-line tool

The desktop app is also a command-line tool. It is the right choice for
scripts, for downloading many images in one go, and for automating regular
jobs. All the desktop app's abilities are available, including
[protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors) and
[resuming](./desktop-app.md#resuming-an-interrupted-download).

## Basic use

```sh
dezoomify "https://museum.example/collection/painting" painting.png
```

The first argument is the address of the viewer page or image description
file; the second is the file to save. With no arguments, the tool asks for
them interactively. If several images or resolutions exist, it shows a list
to choose from.

## Useful options

| You want to… | Option |
|---|---|
| Always take the highest resolution | `--largest` |
| Cap the resolution (e.g. 4000 pixels wide) | `--max-width 4000` |
| Pick a specific image from a list | `--image-index 2` |
| Retry more often on an unreliable server | `--retries 5` |
| Go slower to stay gentle with the server | `--min-interval 200ms` |
| Look like you come from the site's viewer | `--header "Referer: <viewer page>"` |
| Keep downloaded pieces to resume later | `--tile-cache my-folder` |
| Turn off address checking for odd servers | `--accept-invalid-certs` (careful: this disables protection against impostor servers) |

Run `dezoomify --help` for the full list.

## Downloading many images

Put the addresses in a text file, one per line, with an optional title after
each one:

```text
# my-collection.txt: lines starting with # are ignored
https://museum.example/painting-1 Image 1: portrait
https://museum.example/painting-2
https://library.example/manuscript/info.json
```

Then:

```sh
dezoomify --bulk my-collection.txt --outfile collection.jpg
```

This saves `collection_1.jpg`, `collection_2.jpg`, and so on. A failed image
does not stop the rest; a summary is printed at the end. You can also pass a
single IIIF collection manifest address to `--bulk` to download all the
images it lists, named after their titles.

## Next steps

- [Desktop app features](./desktop-app.md)
- [Supported formats](./supported-formats.md)
