# desktop-app

# Desktop app

The desktop app runs Dezoomify natively on Windows, macOS, and Linux,
without a browser's limits. Use it when:

- the image is **very large**: a browser may refuse to display or save
  images beyond a certain size; the desktop app assembles images of any size
  and writes them directly to disk;
- the site **refuses visitors from other pages**: the app can introduce
  itself as coming from the site's own viewer page;
- you need a **specific file format**: the website saves PNG; the desktop
  app saves PNG, JPEG, TIFF, and more, including a local zoomable copy for
  gigantic pictures;
- a download **got interrupted**: with the resume option, already-fetched
  pieces are kept and the job continues where it stopped.

## Install

1. Go to the [releases page](https://github.com/lovasoa/dezoomify/releases)
   and download the version for your operating system.
2. Unpack it and start the program.
3. Depending on your system, you may need to confirm that you trust the app:
   on macOS, use *System Settings → Privacy & Security → Open Anyway* the
   first time you start it. The app is not professionally signed because
   Dezoomify is a free project without a paid signing certificate.

## Download an image

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
requests that appear to come from the site's own viewer. If the download
fails with a "forbidden" style error, tell the app which page the image
belongs to (most image viewers open with such a page) and it will introduce
itself as coming from there. On the command line, this is the
`--header "Referer: …"` option; see [protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).

## Choosing the file format

The format follows the file name you choose: `picture.jpg` saves a JPEG,
`picture.png` a PNG, `picture.iiif` a local zoomable copy you can open in a
browser.

- **JPEG** is the common choice and produces small files, but pictures are
  limited to 65,535 pixels per side and the whole picture must fit in your
  computer's memory.
- **PNG** is lossless (no quality loss) and works even for gigantic
  pictures: it is written to disk as it goes, without needing to hold the
  whole image in memory. It produces much larger files.
- **A local zoomable copy** (`.iiif`) is best for images of hundreds of
  megapixels or more: regular image viewers struggle with files that large,
  but a zoomable copy stays comfortable to explore.

## Resuming an interrupted download

Start the app with a resume folder (`--tile-cache <folder>` on the command
line). Every downloaded piece is kept there; if the download stops, run the
same command again and it picks up where it left off. The folder also
contains the individual pieces if you prefer to assemble them with other
tools.

## Next steps

- [Command-line usage and bulk downloads](./command-line.md)
- [Troubleshooting](./troubleshooting.md)
