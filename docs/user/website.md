# website

# The Dezoomify website

The website needs no installation: it runs in your browser at
[dezoomify.ophir.dev](https://dezoomify.ophir.dev/) (this page you are
reading is part of it).

## Save an image

1. Open the page that shows the zoomable image in a tab of your browser.
2. Copy its address from the address bar.
3. Paste it into the Dezoomify website and press **Dezoomify !**.
4. Wait. Dezoomify identifies the image format, saves every piece of the
   picture, and assembles them. Large images take a while; the progress
   counter tells you how far along you are.
5. When the picture appears, use the **Save** button (or right-click the
   image and choose *Save image as…*). The file is saved as a PNG.

If a page offers several images, the website saves the first one it finds.
It uses the highest resolution that fits in a browser tab.
There is no list to pick from in the website.
To choose a different image or the full resolution, use the [desktop app](./desktop-app.md) or the [command-line tool](./command-line.md).

You can also paste the address of an image's description file directly,
for example an `info.json`, `ImageProperties.xml`, or `.dzi` address, when
you know it. See [finding the image address](./finding-the-image-address.md).

## What the website cannot do

These limits are facts about how browsers work, not problems with your
computer:

- **No sign-in.** The website never sends your passwords or your browsing
  session to any site, so it can only reach images that anyone can open.
  For members-only collections, use the
  [browser extension](./browser-extension.md).
- **Size limits.** A browser tab can only hold a certain amount of picture.
  With very large images, the picture may appear blank, or the browser may
  refuse to save it. The website stops the job with an error and points to
  the [desktop app](./desktop-app.md) for the full-size image. To save a
  smaller copy, use the [command-line tool](./command-line.md) with
  `--max-width`.
- **Some sites refuse visitors.** A few image servers only answer to their
  own pages and send an error to everyone else. The
  [desktop app](./desktop-app.md) can introduce itself as coming from the
  site's own viewer.
- **Viewing without saving.** Some sites show their pieces without letting
  the browser read the image data directly. The website then shows the
  assembled picture below: right-click it and choose *Save image as…* to
  keep a copy as a file. For a save that happens automatically, in the
  format you choose, use the [desktop app](./desktop-app.md).
- **Colors may shift.** The browser save does not keep the original color
  profile (ICC) or photo metadata (EXIF). The desktop app preserves the
  first tile's color profile for exact colors.

## Next steps

- [Something did not work? Read the troubleshooting guide](./troubleshooting.md)
- [Install the browser extension for members-only pages](./browser-extension.md)
