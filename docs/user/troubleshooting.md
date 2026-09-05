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
  `--header "Referer: https://the-site.example/its/viewer/page"`.

Never paste passwords, cookies, or session contents into web forms,
chat messages, or bug reports.

## The image appears blank, or the browser slows to a halt

Very large pictures can exceed what a browser tab is allowed to hold. When
Dezoomify sees this coming, it offers to save a scaled-down copy. Options:

- Accept the smaller copy — often perfectly usable on screen.
- Use the [desktop app](./desktop-app.md), which writes the image to disk
  piece by piece and has no such ceiling. This is the honest fix for
  gigapixel images.

## The image is visible but the browser cannot save it

Some browsers fail to save very large pictures even when they can display
them. Nothing on the website can bypass that browser limit. Use the
[browser extension](./browser-extension.md) (it saves through a different,
cleaner route) or the [desktop app](./desktop-app.md).

## The download stopped partway

Small network interruptions are retried automatically. If the job stops
anyway, run it again — and on the desktop app, use a resume folder
(`--tile-cache`) so already-downloaded pieces are kept:
see [resuming an interrupted download](./desktop-app.md#resuming-an-interrupted-download).

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
