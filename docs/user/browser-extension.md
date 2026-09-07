# browser-extension

# Browser extension

Find the full image behind a museum, library, or archive viewer, even when the
page requires you to sign in.

## 1. Click the Dezoomify icon

On the page with the image, click Dezoomify in the browser toolbar. If it is
hidden, open the puzzle-piece menu and pin it.

## Install

Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
(works with Chrome, Edge, Brave, and other Chromium-based browsers). A
Firefox version is on its way.

## 2. Let the page settle

The page reloads so Dezoomify can see the viewer. Wait for it to finish, then
zoom in on the image once.

## 3. Start dezooming

Dezoomify opens a new tab and starts dezooming automatically. Leave it open
until your image is ready, then save it.

## Tiled or static?

Use the browser's normal save action when **Save image as** gives you the
complete artwork. Use Dezoomify when zooming stays sharp and the viewer loads
many tiles or strips instead of one image.

## Extension limits

The extension saves the first image it finds and does not offer an image list.
For a different image, the full resolution, or an image too large for a
browser tab, use the [desktop app](./desktop-app.md) or the
[command-line tool](./command-line.md).

## What the extension does with your data

- It only looks at the page you pointed it at, only after you pressed the
  button. It does not watch your browsing in the background.
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
