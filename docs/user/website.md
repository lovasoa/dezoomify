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

## Save part of an image

When the picture appears, the preview toolbar offers **Crop**. The button
toggles region mode: drag on the preview to draw the region, or type exact
numbers (`x,y,w,h` in level pixels) and press **Apply crop**. The live
estimate names the region size. **Apply crop** runs the same picture again
for exactly that region at the same resolution; **Clear** restores the full
picture. An empty region or a region outside the picture stops before any
piece is saved with a message naming the fix. The selection uses only the
tile plan and never reads picture data, so it works where the picture can
only be viewed.

## Saving several images

Pasting another address while a job runs queues it instead of stopping the
current job. Queued jobs save one at a time in the order they were added; a
failed address never stops the rest. The address bar always shows the job
that is running now. To save many addresses at once from a list, use the
[command-line tool](./command-line.md) with `--bulk`, or queue them in the
[desktop app](./desktop-app.md).

## Recent pictures

The start page keeps your last 20 saves on this device only. Each entry
shows the site, the picture size, the format, and the date, with an
**Open again** action that runs the same job without retyping the address.
A **Clear history** button removes all entries. Full addresses stay only
for ordinary pages when you tick the opt-in box; addresses with sign-in
details never keep their full text, only the site plus a short reference.
Reloading the page stops the current run; reopen it from the list.

## Language

The apps speak English, French, German, and Italian. The language picker
offers these four; when you have not picked one, the app follows your
browser's preferred languages and falls back to English for anything
untranslated. Error codes, file format names, and the help pages themselves
stay in English; only the app's own buttons, messages, and guidance are
translated.

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
  assembled picture below with a one-click **Send to desktop app** button:
  the button names the image origin and the summary notes that no sign-in
  details travel, one job only, kept in memory. The desktop app asks for
  confirmation before anything runs. For a save that happens automatically, in the
  format you choose, use the [desktop app](./desktop-app.md).
- **Colors may shift.** The browser save does not keep the original color
  profile (ICC) or photo metadata (EXIF). The desktop app preserves the
  first tile's color profile for exact colors.

When an image is too large for the tab, the error offers the same one-click
Send to desktop app with the origin named. Local files (`file:` addresses)
cannot leave the browser: the error shows a local-only note instead of a
link. Open the [desktop app](./desktop-app.md) and choose the file there;
nothing is sent.

## Next steps

- [Something did not work? Read the troubleshooting guide](./troubleshooting.md)
- [Install the browser extension for members-only pages](./browser-extension.md)
