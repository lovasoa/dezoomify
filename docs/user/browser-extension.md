# browser-extension

# Browser extension

The extension adds Dezoomify to your browser. While you look at a zoomable
image, it can find the image behind the viewer automatically, including on
pages where you are signed in, such as library portals, museum
subscriptions, and academic archives.

## 1. Click the Dezoomify icon

On the page with the image, click Dezoomify in the browser toolbar. If it is
hidden, open the puzzle-piece menu and pin it.

## 2. Let the page settle

Dezoomify reads the page's retained resource entries without reloading it. Wait
for the job tab to open, then zoom in on the image once.

## 3. Start dezooming

Dezoomify opens a new tab and starts dezooming automatically. Leave it open
until your image is ready, then save it.

## Tiled or static?

Use the browser's normal save action when **Save image as** gives you the
complete artwork. Use Dezoomify when zooming stays sharp and the viewer loads
many tiles or strips instead of one image.

## Install

Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
(works with Chrome, Edge, Brave, and other Chromium-based browsers) or
[Firefox Browser Add-ons](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/).

## Save an image

1. Open the page that shows the zoomable image.
2. Press the Dezoomify magnifying-glass button in the browser toolbar.
   The grey icon turns blue with a dot: the extension is now working on that
   tab's explicit job.
3. Pressing the button needs no extra permission: Dezoomify only ever looks
   at the tab you pointed it at, never at all your browsing. If the image
   or its tiles live on other addresses, the browser may ask for permission
   to look at those too; approve it to continue.
4. The dedicated job tab starts from the source page's retained resource
   entries. Keep both tabs open; a second press of the button, closing a tab,
   or navigating away stops the active job.
5. The extension selects the largest image it finds and the highest
   resolution that fits in a browser tab, then saves it automatically. When
   the highest resolution would not fit, the save continues at the largest
   one that does and a message shows the resolution being saved and the
   maximum available, with the desktop app, **Try maximum**, and **Stop**;
   after the save completes, the offer stays without **Stop**. There
   is no list to pick from in the extension. To choose a particular image or
   level, use the [command-line tool](./command-line.md).

## If something goes wrong

A temporary failure shows **Try again** in the job tab. Pressing it reads the
page again and restarts the job from the page's retained entries. If the
message instead points to another fix, the problem is not temporary. There is
no **Start over** in the extension: to work on a different image, open its page
and press the Dezoomify toolbar button.

## What the extension does with your data

- It only looks at the page you pointed it at, only after you pressed the
  button. It does not watch your browsing in the background. Each press
  takes one bounded snapshot and stops by itself when it finds an image,
  when you press the button again, or when you close the tab or leave the
  page; it never restarts itself.
- It uses your existing browser session, so images behind a sign-in work.
  Your credentials stay in your browser; Dezoomify never stores or sends
  them anywhere else.
- Sign-in details stay in the browser. The extension does not transfer them
  to the desktop app.

## Next steps

- [The extension found nothing? See troubleshooting](./troubleshooting.md)
- [Very large images belong in the desktop app](./desktop-app.md)
