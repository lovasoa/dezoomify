# desktop-app

# Desktop app

The desktop app runs Dezoomify natively on Windows, macOS, and Linux,
beyond what a browser tab can hold, subject to the memory currently available
to the process.
Use it when:

- the image is **very large**: a browser may refuse to display or save
  images beyond a certain size; the desktop app assembles larger images
  than a browser tab (subject to available memory) and writes the
  finished output directly to disk;
- the site **refuses visitors from other pages**: the app can introduce
  itself as coming from the site's own viewer page.

Each job saves to one output file or IIIF tile folder. PNG, JPEG and TIFF
compress while pieces arrive and release decoded pieces as their pixels are
read. Compatible IIIF/ZIF pieces keep their compressed bytes. Working pixels
stay in RAM, with a budget based on 80% of available memory at job start.
Pixel processing and codec working space share that budget; network response
buffers need additional memory. Unknown dimensions, missing
early pieces and WebP output can need more buffering. If the working data
cannot fit, the save stops with a typed error and removes unpublished output.
Choose a smaller resolution in that case.

Tile counts show acquisition; the progress bar and counts switch to pixels
while the saved image finishes. Pause affects acquisition. Cancel remains available
through output preparation.

## Resuming an interrupted save

Small network interruptions are retried automatically. The tile cache stays
on by default, so running the same job again reuses the tiles already saved
instead of fetching them again, without passing any extra option. A custom
resume folder remains available with `--tile-cache` on the command line and
the cache directory setting in the app; reuse the same folder to resume.
Tiles are keyed by digest of their address, so only response bytes persist
there, never passwords, cookies, or session contents. If the site changes
its image, remove the resume folder and start fresh.

## Recent pictures

The app keeps your last 20 started images on this device only, including failed
and cancelled attempts. Each row shows the title (or source address), time since
starting, known pixel dimensions, and status. Saved images show their file name;
click the row to open the local image. Files that are no longer there show
**Deleted**. Other rows fill and focus the address field so you can review it
before starting again. File availability is checked in the background when you
return to the main screen or app. Use the trash icon to remove one row, or
**Clear history** to remove all entries; this never deletes your saved images.

## Saving and opening images

Choose the folder, format, size, and network settings on the main screen.
The app saves the image automatically in that folder. When **Image saved**
appears, use **Open image** to open it with your usual image viewer, or
**Show in folder** to find it in your file manager. There is no second save
step. Settings do not appear on the finished image screen.
If opening fails, each attempt shows its own error. **Technical details &
logs → Copy diagnostics** includes the failed action and its error kind.
You can still open the containing folder if the image has been moved.

## Install

The [releases page](https://github.com/lovasoa/dezoomify/releases/latest)
ships installers for Linux x86_64 (`.deb`), Windows x86_64 (`.msi`),
and Apple silicon macOS (`.dmg`). Linux and Windows installers are unsigned.
The macOS app has an ad-hoc signature, which requires no paid Apple account,
but is not signed with Developer ID or notarized by Apple. The operating
system may ask you to confirm that you trust the app.

There is no automatic in-app update: when a new version appears on the
releases page, download it manually and install it yourself.

You can also build the app locally with `cargo xtask build desktop`, which
produces an installer with the same signing policy for the matching host under
`target/release/bundle/` (Linux `.deb` on a Linux host with the webview
system packages; Windows `.msi` and macOS `.dmg` only on their matching
hosts).

### Opening the macOS app

Download the `.dmg` from the releases page and open it. The installation
window displays these steps beside the app and Applications icons:

1. Drag **Dezoomify** into **Applications**.
2. Open **Dezoomify** from **Applications**.
3. If macOS cannot verify the developer or check for malicious software,
   open **System Settings → Privacy & Security**.
4. Under **Security**, click **Open Anyway** for Dezoomify, then confirm **Open**.

Only approve a download you trust. This free app is not notarized by Apple.

macOS remembers this app exception. See
[Apple's instructions](https://support.apple.com/en-us/102445).
Ad-hoc signing does not remove this approval step.

If macOS instead says the app is damaged, will damage your computer, or has
been moved to Trash, download a fresh copy from the releases page. If it
still fails, report the exact warning (or a screenshot), your macOS version,
and the release filename in a
[GitHub issue](https://github.com/lovasoa/dezoomify/issues).
A damaged-app warning can indicate a packaging or signature problem;
automatic movement to Trash can indicate malware detection. Do not assume
either warning is the ordinary developer-approval prompt.

## Save an image

Paste the address of the page (or of the image description file) into the
app and start dezooming. The app immediately saves to the folder selected on
the main screen; it does not ask for a second file choice. The native app
uses the image title it finds to determine the file name and adds the extension
for the selected format. You can also start the app with the address as an
argument, or drive it from the terminal; see the
[command-line guide](../../docs/user/command-line.md).

**Members-only sites:** the desktop app cannot reuse your browser sign-in.
Use the [browser extension](../../docs/user/browser-extension.md) to work with pages that
require your existing browser session.

**From the website:** copy the image address and paste it into the desktop app.

**Sites that refuse visitors:** some servers only send their image to
requests that appear to come from the site's own viewer. If the save
fails with a "forbidden" style error, tell the app which page the image
belongs to (most image viewers open with such a page) and it will introduce
itself as coming from there. On the command line, this is the
`-H/--header "Referer: …"` option; see [protected pages](../../docs/user/troubleshooting.md#forbidden-or-unauthorized-errors).

## Choosing the file format

Use the **Format** quick setting to pick Auto (the default), PNG, JPEG, TIFF,
ZIF, WebP, or an IIIF tile folder. Auto saves JPEG for opaque images when both
dimensions are at most 65,535 pixels; transparency or larger images use PNG.
The app remembers your choice.
The native app uses that choice to add the matching
extension to its derived output name: `.png`, `.jpg`, `.tif`, `.zif`, `.webp`,
or `.iiif`. An IIIF folder contains `info.json` and the image tiles, ready to
serve from a static file server.

JPEG versions stay small and suit on-screen viewing; TIFF and PNG suit
archiving and further editing. JPEG cannot address images larger than
65535 pixels per side; such images save as PNG or TIFF. The compression
setting changes the JPEG quality (quality is 100 minus compression, so the
default 5 means 95); TIFF stays lossless at every level.

Each save writes exactly one output. If the derived name already exists, the
app adds a numeric suffix rather than replacing the existing file.

The app saves only after every required tile has been retrieved. If automatic
retries are exhausted, the download pauses and offers **Retry once more** or
**Cancel**. Retrying retains successfully downloaded tiles. Cancelling publishes
no image. You can also restart with the same resume folder to reuse cached tiles;
see [resuming an interrupted save](#resuming-an-interrupted-save).

## Settings

The settings panel holds the output folder, the compression level,
optional width and height caps, the retry budget, the resume cache folder,
and extra request headers. Every setting is validated when you change it:
invalid values are refused and the last good settings stay in force. Settings
persist on the device across restarts, together with the output format
choice.

## If a save fails

A failed save says what went wrong and whether retrying can help. Permanent
tile failures stop the job without saving an incomplete image.

## Next steps

- [Command-line usage](../../docs/user/command-line.md)
- [Troubleshooting](../../docs/user/troubleshooting.md)
