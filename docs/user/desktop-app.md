# desktop-app

# Desktop app

The desktop app runs Dezoomify natively on Windows, macOS, and Linux,
beyond what a browser tab can hold, within an 8 GiB in-memory canvas cap.
Use it when:

- the image is **very large**: a browser may refuse to display or save
  images beyond a certain size; the desktop app assembles larger images
  than a browser tab (up to the 8 GiB canvas limit) and writes the
  finished output directly to disk;
- the site **refuses visitors from other pages**: the app can introduce
  itself as coming from the site's own viewer page.

Each run saves one job to one output file or IIIF tile folder. It runs
no bulk queue. The app holds the full image in memory while it works (4
bytes per pixel plus working space), so very large saves need matching
free memory; when the image exceeds the 8 GiB canvas limit the save stops
with a typed error before anything is written, and saving a smaller level
fits the budget.

## Resuming an interrupted save

Small network interruptions are retried automatically. When a save stops
anyway, running the same job again with the same resume folder reuses the
tiles already saved instead of fetching them again. On the command line,
the resume folder is the `--tile-cache` option pointing at a folder.
Tiles are keyed by digest of their address, so only response bytes persist
there, never passwords, cookies, or session contents. If the site changes
its image, remove the resume folder and start fresh.

## Install

No installer ships yet. A future installer will appear on the
[releases page](https://github.com/lovasoa/dezoomify/releases). Meanwhile,
use the [website](./website.md) or the
[command-line tool](./command-line.md).

## Save an image

Paste the address of the page (or of the image description file) into the
app and choose where to save the result, exactly like on the
[website](./website.md). You can also start the app with the address as an
argument, or drive it from the terminal; see the
[command-line guide](./command-line.md).

**Members-only sites:** the desktop app cannot sign in by itself. Get the
image address with the [browser extension](./browser-extension.md) and send
the job to the desktop app; the extension asks for your consent before
passing the site's credentials, which stay in memory only.

**Sites that refuse visitors:** some servers only send their image to
requests that appear to come from the site's own viewer. If the save
fails with a "forbidden" style error, tell the app which page the image
belongs to (most image viewers open with such a page) and it will introduce
itself as coming from there. On the command line, this is the
`-H "Referer: …"` option; see [protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).

## Choosing the file format

The output name selects the format. The app saves PNG for names ending in
`.png`, JPEG at quality 92 for `.jpg` or `.jpeg`, TIFF for `.tif` or
`.tiff`, and a IIIF tile folder for a name with no extension. Any other
extension stops the job with a typed error before anything is saved, so
rename the output instead.

JPEG versions stay small and suit on-screen viewing; TIFF and PNG suit
archiving and further editing. JPEG cannot address images larger than
65535 pixels per side; such images save as PNG, TIFF, or a IIIF tile
folder. The IIIF tile folder holds an `info.json` file plus JPEG tiles and
suits viewers that read IIIF image folders.

If a save stops partway, run it again with the same resume folder so
already-saved tiles are reused; see
[resuming an interrupted save](#resuming-an-interrupted-save).

## Next steps

- [Command-line usage](./command-line.md)
- [Troubleshooting](./troubleshooting.md)
