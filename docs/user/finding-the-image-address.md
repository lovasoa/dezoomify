# finding-the-image-address

# Finding the image address

Dezoomify usually works with the ordinary address of the page that shows the
image. If it answers that no image was found, the site probably hides its
image description file. Every zoomable viewer loads such a small file that
describes the picture; Dezoomify needs its address. There are two ways to
find it.

## Way 1: let the extension find it

The [browser extension](./browser-extension.md) watches the page while you
look at the image and finds the address for you. Try it first — it exists
exactly for this problem.

## Way 2: find it yourself in the browser

Your browser keeps a log of every file a page loads. The description file is
in there.

1. Open the page with the image.
2. Open your browser's **network log**:
   - Firefox: press **Ctrl+Shift+E** (menu: *Tools → Browser Tools → Network*).
   - Chrome/Edge: press **F12**, then open the *Network* tab.
3. With the log open, **reload the page** (F5) and zoom into the image.
4. The log fills with rows — one per file. Look for a small file, usually a
   few kilobytes, whose name ends in `.json`, `.xml`, or `.dzi`. Common
   names are `info.json` (IIIF), `ImageProperties.xml` (Zoomify), and
   anything ending in `.dzi` (Deep Zoom). Tiles are the big files; ignore
   them.
5. Right-click that row, choose *Copy → Copy URL*, and paste the address
   into Dezoomify.

You can recognize a good candidate because opening its address in a tab
shows a short piece of text describing a picture — dimensions, tile size —
rather than a picture itself.

## Last resort: describing the tile pattern

If no description file exists, the
[generic format](./supported-formats.md#generic) can still reconstruct the
image from the addresses of the tiles themselves, when those addresses
follow a simple pattern.

1. In the network log, find one of the picture's tile files (the many
   similar-looking images, often named like `0-0.jpg`, `1-0.jpg`, …).
2. Copy its address and spot the two numbers inside it: the column and the
   row of the tile.
3. Paste the address into Dezoomify and replace those two numbers with `--`,
   keeping everything else identical:
   - `https://example.com/art/image-0-0.jpg`
   - becomes `https://example.com/art/image--.jpg`

Dezoomify then works out the image's dimensions by trying the pattern.
On the command line, the same trick applies with the
[generic format](./supported-formats.md#generic).

If none of this works, the site may use a viewer that needs a new recipe —
[open an issue](https://github.com/lovasoa/dezoomify/issues) with the
site's address and someone can add support for it.

## Next steps

- [Troubleshooting](./troubleshooting.md)
- [All supported formats](./supported-formats.md)
