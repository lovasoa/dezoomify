# browser-extension

# Browser extension

The extension adds Dezoomify to your browser. While you look at a zoomable
image, it can find the image behind the viewer automatically, including on
pages where you are signed in, such as library portals, museum
subscriptions, and academic archives.

## Install

Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
(works with Chrome, Edge, Brave, and other Chromium-based browsers). A
Firefox version is on its way.

## Save an image

1. Open the page that shows the zoomable image.
2. Press the Dezoomify magnifying-glass button in the browser toolbar.
   The grey icon turns blue with a dot: the extension is now watching that
   tab for a zoomable image.
3. The first time on a new site, the browser asks for permission to look at
   that site. Approve it. Dezoomify only asks for the sites you use it on,
   never for all your browsing.
4. The page reloads once automatically. Keep the tab open; a second press
   of the button, closing the tab, or navigating away stops watching.
5. When an image is found, a small window opens inside the same page.
   Pick the image and save it at the highest resolution that fits in a
   browser tab.
   There is no list to pick from in the extension.
   For a different image or the full resolution, use the [desktop app](./desktop-app.md) or the [command-line tool](./command-line.md).

## What the extension does with your data

- It only looks at the page you pointed it at, only after you pressed the
  button. It does not watch your browsing in the background. Watching has
  no time limit but stops by itself when it finds an image, when you press
  the button again, or when you close the tab or leave the page; it never
  restarts itself.
- It uses your existing browser session, so images behind a sign-in work.
  Your credentials stay in your browser; Dezoomify never stores or sends
  them anywhere else.
- If you choose to send a job to the desktop app, and that site needs your
  sign-in there too, the extension asks for your explicit consent first and
  passes the site's credentials directly to the desktop app on your own
  computer. They stay in memory only.

## Send to desktop app

Saved results and display-only previews both offer a one-click
**Send to desktop app** button in the result section. The button names the
image origin; the approval dialog then names the destination origins, the
cookie names (never the values), and the job, and notes that nothing is
sent until confirmation. Declining keeps the job in the extension. Consent
covers one job only and never carries over. The desktop app confirms again
before anything runs.

## Next steps

- [The extension found nothing? See troubleshooting](./troubleshooting.md)
- [Very large images belong in the desktop app](./desktop-app.md)
