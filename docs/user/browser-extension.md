# browser-extension

# Browser extension

Use the extension to find an image behind a viewer or save from a page where
you are signed in. For images beyond browser size limits, use the
[desktop app](../../apps/desktop/desktop-app.md).

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
(Chrome, Edge, Brave, and other Chromium browsers) or
[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/).
Pin Dezoomify through the browser's extension menu if its icon is hidden.

## Save an image

1. Open the image's viewing page, sign in if needed, and let the viewer load.
   Zoom in once to ensure its image resources have loaded before starting.
2. Click Dezoomify in the browser toolbar. A dedicated job tab opens and starts
   automatically. The source page is not reloaded.
3. If the job asks for access to another site hosting the image or tiles, approve
   that visible request to continue.
4. Leave the job tab open until the browser confirms saving. Then choose
   **Open image** or **Show in folder**.

The extension selects the largest image and resolution that fit in a browser
tab. If it saves a smaller resolution, it shows both sizes and offers the desktop
app or **Try maximum**. Trying maximum can still fail at the browser's limits.
To choose a specific image or level, use the [CLI](./command-line.md).

Clicking the toolbar button again focuses the existing job tab and cancels an
active job. Closing the job tab also stops it, including an unfinished save.
Source-page navigation ends access to the old document; a job can continue only
with discovered data it can fetch without that document's session.

## 1. Click the Dezoomify icon

Follow [Save an image](#save-an-image) above; pin the icon if it is hidden.

## 2. Let the page settle

Let the viewer load and zoom before clicking. Each attempt reads one snapshot;
the extension does not keep watching for resources loaded afterward.

## 3. Start dezooming

The job tab starts automatically and confirms when saving finishes.

## Tiled or static?

Use the browser's normal **Save image as** when it already gives you the complete
artwork. Use Dezoomify when zooming stays sharp and the viewer loads many pieces.

## If something goes wrong

If automatic retries are exhausted, **Retry once more** continues the existing
job and retains downloaded tiles; **Cancel** stops it without saving an incomplete
image. After a failed job, **Try again** reads the same source document again
and restarts the attempt. For a different image or a navigated source page, click
the toolbar button on that page. Follow [troubleshooting](./troubleshooting.md)
for other errors or a visible picture that cannot be saved.

## What the extension does with your data

The extension examines only the source page you select, after your click. It
can use that site's browser session, but does not transfer login credentials
to the project server or desktop app.

**Technical details & logs** includes full page and image addresses. They may
contain sensitive information, especially on signed-in sites. Review them before
sharing; reports are not automatically sanitized.

## Next steps

- [Find an image address manually](./finding-the-image-address.md)
- [Use desktop for very large images](../../apps/desktop/desktop-app.md)
