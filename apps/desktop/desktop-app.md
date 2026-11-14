# desktop-app

# Desktop app

Use desktop for images beyond browser limits, local sources, or more output
formats. It runs on Windows, macOS, and Linux and saves directly to your chosen
folder. It cannot reuse your browser login; use the
[extension](../../docs/user/browser-extension.md) for signed-in pages.

Downloads use your own internet connection. Most formats can save without keeping
the whole image in memory; WebP and AVIF need the complete picture. If a save
reaches a limit, choose another format, a smaller resolution, or a tile folder.

## Resuming an interrupted save

Run the same job again to reuse cached tiles. The cache is enabled by default;
choose a custom folder in settings. If the source image changed, remove its
cached tiles first.

## Recent pictures

History keeps recent images on this device. Click a saved filename
under **Result** to open its file; missing files show **Deleted**. Click **Source**
to fill the address field without starting. Remove entries with the trash icon
or **Clear history**; this never deletes saved images.

## Saving and opening images

Choose the folder, format, and size on the main screen, paste an address, and
start. Saving is automatic; existing files are preserved. When **Image saved**
appears, use **Open image** or **Show in folder**. Pause stops new tile downloads;
Cancel remains available while output finishes.

When a source offers several images, choose **Download all** above the image
picker. Cancelling keeps completed saves. With PDF selected, the batch saves
one file in picker order, keeping completed pages after a failure or cancellation.

Open local source files through **File → Open…**,
**⌘O** on macOS, **Ctrl+O** on Windows/Linux, or by dropping a file onto the window.
URL lists are plain text: one address or file path per line, optionally followed
by a title. Relative entries use the list's directory. Keep local metadata with
its tile files. Finish or cancel the current download before opening another source.

## Install

The [releases page](https://github.com/lovasoa/dezoomify/releases/latest)
ships Linux x86_64 downloads (`.AppImage` and `.deb`), Windows x86_64 (`.exe`, NSIS),
and Apple silicon macOS (`.dmg`). Linux and Windows installers are unsigned.
macOS releases use a Developer ID signature and Apple notarization. The operating
system may ask you to confirm that you want to open a downloaded app.

On Linux, make the AppImage executable in its file properties, then open it.
It needs no installation. If FUSE is unavailable, run it from a terminal with
`APPIMAGE_EXTRACT_AND_RUN=1 ./dezoomify-desktop.AppImage`.
Linux releases are built on Ubuntu 24.04; older distributions may not run them.

Choose **Help → Check for updates…** to check GitHub Releases. The app asks
before downloading a signed update and restarting. Finish or cancel any
current save first. Linux and Windows may ask for administrator permission
to install the update. Older versions without this menu need one manual upgrade.

### Opening the macOS app

Download and open the `.dmg`, then:

1. Drag **Dezoomify** into **Applications**.
2. Open **Dezoomify** from **Applications**.
3. If macOS asks whether to open this downloaded app, click **Open**.

Official macOS releases are signed and notarized. Only open a download you trust.

Older releases and local ad-hoc builds may require approval under
**System Settings → Privacy & Security → Open Anyway**. See
[Apple's instructions](https://support.apple.com/en-us/102445).

If macOS says the app is damaged, will damage your computer, or has been moved
to Trash, download a fresh copy. These warnings are different from the ordinary
approval prompt. If it still fails, report the exact warning, macOS version,
and release filename in a [GitHub issue](https://github.com/lovasoa/dezoomify/issues).

## Choosing the file format

- **Auto** chooses JPEG for an opaque image within JPEG's dimensions, otherwise PNG.
- **PNG or TIFF** are lossless choices for archiving and editing.
- **JPEG** suits smaller on-screen copies; it is limited to 65,535 pixels per side.
- **JPEG 2000** supports lossless and lossy output without transparency.
  Compression zero is lossless. It requires a regular source grid with at most
  65,535 tiles.
- **WebP** is lossless here, but needs a complete pixel buffer and is limited to
  16,383 pixels per side.
- **AVIF** saves lossy images with transparency, up to 65,535 pixels per side.
  It needs the complete image in memory and does not preserve embedded color
  profiles. Quality 100 is not a lossless mode.
- **ZIF** is a tiled multi-resolution image and omits transparency.
- **PDF** preserves selected resolution on a marginless page, with transparency.
  **Download all** creates a single multi-page document.
- **IIIF** saves a folder with an offline viewer. Press Open or open `viewer.html`
  in your browser. Keep the whole folder together, including `full/` overview images.

Higher Compression in the Size menu aims for smaller files, at the cost of
detail for lossy formats. The amber warning marks quality where text and fine
details may become unreadable. IIIF/ZIF/PDF can preserve original compressed tiles.

Size estimates assume an image filling the selected maximum dimensions. They
are rough budgets; actual file size and memory use can differ.

## Settings

Choose an output folder, format, compression, optional size caps, retry budget,
cache folder, and request headers. Settings persist on this device.

Network offers **Gentle**, **Automatic** (default), and **Aggressive**. All use
adaptive pacing and respect server limits; Gentle starts slowly. Network’s
information button shows request rates per server. For custom rates,
use the [CLI](../../docs/user/command-line.md#request-pacing).

If a site accepts requests only from its viewer, add that page as the Referer
header. See [access refusals](../../docs/user/troubleshooting.md#forbidden-or-unauthorized-errors).

## If a save fails

Read the error's suggested next step. After automatic retries are exhausted,
the download pauses and offers **Retry once more** or **Cancel**. Retrying keeps
successfully downloaded tiles. An incomplete image is never published.
Restarting the job can reuse good cached tiles; see
[resuming](#resuming-an-interrupted-save).

If opening a saved file fails, try **Show in folder**. Use **Technical details &
logs** for a report, reviewing sensitive addresses and settings before sharing.

## Next steps

- [Troubleshooting](../../docs/user/troubleshooting.md)
- [Command-line usage](../../docs/user/command-line.md)
