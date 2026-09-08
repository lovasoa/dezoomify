# desktop-app

# Desktop app

The desktop app runs Dezoomify natively on Windows, macOS, and Linux,
beyond what a browser tab can hold, within an 8 GiB in-memory canvas cap.
Use it when:

- the image is **very large**: a browser may refuse to display or save
  images beyond a certain size; the desktop app assembles larger images
  than a browser tab (up to the 8 GiB canvas limit) and writes the
  finished output directly to disk;
- the site **refuses visitors from other pages**: the app can introduce
  itself as coming from the site's own viewer page.

Each job saves to one output file or IIIF tile folder. You can queue
several jobs: an address submitted while a job runs waits in the queue table
instead of replacing the running job, and jobs save one at a time in the
order they were added. Each row shows its site, status, and progress; one
entry can be cancelled without touching the rest, **Cancel all** stops new
work, and failed jobs offer **Retry**. A failed job never stops the rest,
and the totals read like the command line
(`bulk: X succeeded, Y failed, Z total`). The app holds the full image in
memory while it works (4
bytes per pixel plus working space), so very large saves need matching
free memory; when the image exceeds the 8 GiB canvas limit the save stops
with a typed error before anything is written, and saving a smaller level
fits the budget.

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

The app keeps your last 20 saves on this device only. Each entry shows the
full address, the picture size, the format, and the date. Click an entry to
put its address back in the main screen, where you can change the settings
before starting again. **Clear history** removes all entries.

## Saving and opening images

Choose the folder, format, size, and network settings on the main screen.
The app saves the image automatically in that folder. When **Image saved**
appears, use **Open image** to open it with your usual image viewer, or
**Show in folder** to find it in your file manager. There is no second save
step. Settings and the queue do not appear on the finished image screen.
If some parts could not be retrieved, the app labels the image as saved with
gaps; the open actions use that partial file.
If opening fails, each attempt shows its own error. **Technical details &
logs → Copy diagnostics** includes the failed action and its error code.
You can still open the containing folder if the image has been moved.

## Install

Linux ships an unsigned `.deb` on the [releases
page](https://github.com/lovasoa/dezoomify/releases) (`desktop-linux-x86_64`;
no paid Apple/Azure signing anywhere). Windows and macOS ship no installer
in this wave: their bundles build only on their matching hosts, so use the
[website](./website.md) or the [command-line tool](./command-line.md) there
and check the releases page for news.

There is no automatic in-app update: when a new version appears on the
releases page, download it manually and install it yourself. Before
installing, verify the download: compare its SHA256 against `SHA256SUMS`
and check the GPG signatures (`SHA256SUMS.sig` plus the per-artifact
`.sig`) with the key in `release/gpg-public-key.asc`. A mismatch or missing
signature means do not install.

You can also build the app locally with `cargo xtask build desktop`, which
produces an unsigned installer for the matching host under
`target/release/bundle/` (Linux `.deb` on a Linux host with the webview
system packages; Windows `.msi` and macOS `.dmg` only on their matching
hosts).

## Save an image

Paste the address of the page (or of the image description file) into the
app and start dezooming. The app immediately saves to the folder selected on
the main screen; it does not ask for a second file choice. The native engine
uses the image title it finds to determine the file name and adds the extension
for the selected format. You can also start the app with the address as an
argument, or drive it from the terminal; see the
[command-line guide](./command-line.md).

**Members-only sites:** the desktop app cannot sign in by itself. Get the
image address with the [browser extension](./browser-extension.md) and send
the job to the desktop app; the extension asks for your consent before
passing the site's credentials, which stay in memory only.

**From the website or extension:** the **Send to desktop app** button carries
only the image address, never passwords or cookies in the link. The app
validates the link (http(s) only, no userinfo, no sensitive query or
fragment keys) and shows the source plus provenance for explicit
confirmation. Nothing runs until confirmation; declining does nothing.

**Sites that refuse visitors:** some servers only send their image to
requests that appear to come from the site's own viewer. If the save
fails with a "forbidden" style error, tell the app which page the image
belongs to (most image viewers open with such a page) and it will introduce
itself as coming from there. On the command line, this is the
`-H/--header "Referer: …"` option; see [protected pages](./troubleshooting.md#forbidden-or-unauthorized-errors).

## Choosing the file format

Open **Customize** before saving to pick PNG, JPEG, TIFF, ZIF, WebP, or an
IIIF tile folder. The app remembers your choice and summarizes it while the
panel is closed. The native engine uses that choice to add the matching
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

If some tiles cannot be fetched, the app still writes what it got: the kept
output lands next to the derived name with `.partial` inserted before the
extension (`photo.png` becomes `photo.partial.png`), and the chosen name
itself stays untouched, so a partial file never masquerades as the complete
save. Run the job again with the same resume folder to reuse already-saved
tiles; see [resuming an interrupted save](#resuming-an-interrupted-save).

## Settings

The settings panel holds the output folder, the compression level,
optional width and height caps, the retry budget, the resume cache folder,
and extra request headers. Every setting is validated when you change it:
invalid values are refused and the last good settings stay in force. Settings
persist on the device across restarts, together with the output format
choice.

## If a save fails

A failed save says what went wrong and whether retrying can help; the queue
row offers **Retry**, and a failed entry never stops the rest. Partially
fetched saves need no decision from you: they are kept automatically as the
`.partial` file described above.

## Next steps

- [Command-line usage](./command-line.md)
- [Troubleshooting](./troubleshooting.md)
