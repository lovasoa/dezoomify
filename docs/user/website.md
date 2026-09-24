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

If a page offers several images, the website saves the largest one it finds.
It uses the highest resolution that fits in a browser tab. When the highest
resolution would not fit, the save continues at the largest one that does and
a message shows the resolution being saved and the maximum available. The
message offers the desktop app, **Try maximum** to restart at the maximum
resolution, and **Stop** to end the save; after the smaller save completes,
the offer stays without **Stop**.
There is no list to pick from in the website.
The desktop app also selects automatically; its size settings can cap the
resolution. To choose a particular image or level, use the
[command-line tool](./command-line.md).

You can also paste the address of an image's description file directly,
for example an `info.json`, `ImageProperties.xml`, or `.dzi` address, when
you know it. See [finding the image address](./finding-the-image-address.md).

## Saving several images

Pasting another address while a job runs queues it instead of stopping the
current job. Queued jobs save one at a time in the order they were added; a
failed address never stops the rest. The address bar always shows the job
that is running now. To save many addresses at once from a list, use the
[command-line tool](./command-line.md) with `--bulk`, or queue them in the
[desktop app](./desktop-app.md).

## Recent pictures

The start page keeps your last 20 saves on this device only. Each entry
shows the full address, the picture size, the format, and the date. A **Clear
history** button removes all entries.
Reloading the page stops the current run; enter the address again to restart it.

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
- **Size limits.** A browser tab can only hold about 1 GiB of picture on a
  computer (about 256 MiB on phones and tablets). The website saves the
  largest resolution that fits and names the chosen and maximum resolutions.
  **Try maximum** attempts the maximum resolution anyway; when the browser
  cannot hold it, the job stops with an error that points to the
  [desktop app](./desktop-app.md) for the full-size image. To save a
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
