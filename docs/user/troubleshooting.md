# troubleshooting

# Troubleshooting

Find the symptom below and try its next step.

## No image found

Use the address of the page showing the image, not a search page. Try the
[extension](./browser-extension.md) after the viewer has loaded, or
[find the description address](./finding-the-image-address.md) manually.

## Forbidden or unauthorized errors

If the page requires sign-in, use the extension while signed in. Desktop
cannot reuse your browser login, and copying an address alone does not transfer
that access.

Some servers require the viewer page as the request's referrer. In desktop,
set that request header; on CLI use
`-H "Referer: https://the-site.example/viewer"`. If the site's own viewer also
fails, resolve access there first. Never share passwords, cookies, or sessions.

## The image appears blank, or the browser slows to a halt

Use [desktop](../../apps/desktop/desktop-app.md) for images beyond browser
limits, or CLI `--max-width` for a smaller copy. **Try maximum** attempts the
full resolution but cannot remove browser limits. The extension has the same
image-size limits as the website.

## The image is visible but the browser cannot save it

The browser may display an image too large to encode, or the site may permit
display without readable pixels. Try desktop; for source-session access, try
the extension. Dezoomify labels display-only output rather than claiming it saved.

## The save stopped partway

Temporary tile failures retry automatically. When only part of the image is
available, choose retry, keep, or discard where offered. Kept partial output
has gaps; native apps use a `.partial` sibling filename. Desktop defaults to
keeping it after 60 seconds without an answer. CLI applies its partial setting
immediately. A job with no usable tiles fails without saving.

For native downloads, repeat the job to reuse cached tiles; see
[resuming](../../apps/desktop/desktop-app.md#resuming-an-interrupted-save).
If the source image changed, remove its cached tiles before retrying. Browser
jobs do not use that native disk cache; reloading stops the current run.

## The output name is rejected

Use `.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`, `.webp`, or `.iiif`;
an extensionless path creates an IIIF folder. Other extensions are rejected.
JPEG is limited to 65,535 pixels per side and WebP to 16,383. Use PNG, TIFF,
ZIF, or IIIF for larger dimensions. Choose an unused IIIF destination;
`--overwrite` does not replace an existing directory.

## The site only works without encryption

Browsers block insecure resources from secure pages. Try desktop, which can
fetch the source site's ordinary HTTP resources.

## The site limited requests for that image

Wait before retrying. On CLI, reduce concurrency or increase pacing with the
options in `dezoomify --help`. Changing apps does not remove the site's limit.

## The site asks you to wait a few minutes

Follow [request-limit advice](#the-site-limited-requests-for-that-image) above.

## The image shows but cannot be saved

Follow [visible-image advice](#the-image-is-visible-but-the-browser-cannot-save-it)
above.

## Sending a signed-in image to another app asks for approval

Review any proposed handoff before accepting. Desktop does not receive your
browser credentials, so a signed-in image may still require the extension.
See [extension data use](./browser-extension.md#what-the-extension-does-with-your-data).

## Still stuck?

Open **Technical details & logs** to copy or save a report or prepare an issue
draft. Reports can contain sensitive addresses or settings: review them before
sharing. Include the viewing page, app, error, and a screenshot in a
[GitHub issue](https://github.com/lovasoa/dezoomify/issues).

## Next steps

- [Find the image address](./finding-the-image-address.md)
- [Supported formats](./supported-formats.md)
