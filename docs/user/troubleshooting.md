# troubleshooting

# Troubleshooting

Start with the question closest to what you are seeing. Every answer
suggests a concrete next step.

## No image found

The website or extension could not recognize a zoomable image at that
address. Check that you pasted the address of the page that *shows* the
image (not an image file itself, not a search page). If it still fails, the
site hides its image description file: follow
[finding the image address](./finding-the-image-address.md), or let the
[browser extension](./browser-extension.md) find it for you.

## Forbidden or unauthorized errors

The site sends an error instead of the image. Two different reasons, two
remedies:

- **You normally need to sign in to see this image.** The website runs
  without any sign-in, so the site does not recognize it. Use the
  [browser extension](./browser-extension.md), which works with your own
  signed-in browser, or get the image address with the extension and send
  the job to the [desktop app](./desktop-app.md).
- **The site only serves the image to its own pages.** Some servers check
  where a request comes from and refuse everyone else. The
  [desktop app](./desktop-app.md) can introduce itself as coming from the
  site's own viewer page; on the command line, pass
   `-H "Referer: https://the-site.example/its/viewer/page"`.

Never paste passwords, cookies, or session contents into web forms,
chat messages, or bug reports.

## The image appears blank, or the browser slows to a halt

Very large pictures can exceed what a browser tab is allowed to hold. The
website stops the job with an error and points to the
[desktop app](./desktop-app.md). Options:

- Use the desktop app, which assembles the image in memory (up to its
  1 GiB canvas limit) and writes the finished PNG to disk. This
  is the fix for images that exceed browser limits but fit that cap.
- To save a smaller copy, use the [command-line tool](./command-line.md)
  with `--max-width`.

## The image is visible but the browser cannot save it

Some browsers fail to save very large pictures even when they can display
them. Nothing on the website can bypass that browser limit. Use the
[desktop app](./desktop-app.md), which assembles the image in memory (up
to its 1 GiB canvas limit) and writes the finished PNG to disk. The
browser extension stays inside the same browser memory and save
limits and never fixes this case.

## The save stopped partway

Small network interruptions are retried automatically. If the job stops
anyway, run it again from the start. The app keeps no resume cache, so
already-saved pieces are never reused.

## The output name is rejected

The output name selects the format: `.png` saves PNG, `.jpg` or `.jpeg`
saves JPEG, `.tif` or `.tiff` saves TIFF, and a name with no extension
saves a IIIF tile folder. Any other extension stops the job before
anything is saved. Rename the output to one of the supported forms and run
again. A JPEG save of an image larger than 65535 pixels per side also
stops with a typed error; save such images as PNG, TIFF, or a IIIF tile
folder instead.

## The site only works without encryption

A few old sites serve their images without encryption. A secure website is
not allowed by your browser to load those. The desktop app can still fetch
them: it is an ordinary program on your computer and follows the site's own
setup.

## Still stuck?

- Disable other browser extensions and try once more; some of them
  interfere with Dezoomify.
- If you believe Dezoomify should support this site,
  [open an issue](https://github.com/lovasoa/dezoomify/issues) with the
  address of the page, the exact error message, and your browser's name and
  version. A screenshot helps too. Leave out anything private: no
  passwords, no cookies, no signed-in addresses with tokens in them.

Support is free and done by volunteers; a precise report gets answered much
faster.

## Next steps

- [Start here](./start-here.md)
- [Supported formats](./supported-formats.md)
