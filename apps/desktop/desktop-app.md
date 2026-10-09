# desktop-app

# Desktop app

Use desktop for images beyond browser limits, local sources, or more output
formats. It runs on Windows, macOS, and Linux and saves directly to your chosen
folder. It cannot reuse your browser login; use the
[extension](../../docs/user/browser-extension.md) for signed-in pages.

Large images are still limited by available memory. If a save reaches that
limit, choose a smaller resolution or a tile folder. Explicit output formats
can reduce buffering; WebP needs the complete picture in memory.

## Resuming an interrupted save

Run the same job again to reuse cached tiles. The cache is enabled by default;
choose a custom folder in settings or with CLI `--tile-cache`. If the source
image changed, remove its cached tiles first. Cached tiles do not contain your
browser session.

## Recent pictures

History keeps your last 20 started images on this device. Click a saved entry
to open its file; missing files show **Deleted**. Other entries fill the address
field without starting. Remove entries with the trash icon or **Clear history**;
this never deletes saved images.

## Saving and opening images

Choose the folder, format, and size on the main screen, paste an address, and
start. Saving is automatic. When **Image saved** appears, use **Open image** or
**Show in folder**. Settings return on the main screen, not the result screen.
Pause stops new tile downloads; Cancel remains available while output finishes.

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

Paste the viewer page or image description address and start dezooming. The app
names the output from the image title and adds a numeric suffix if needed;
existing files are preserved. Copy an address from the website to continue here.
For terminal use, see the [CLI guide](../../docs/user/command-line.md).

If a server accepts requests only from its viewer, add that page as the Referer
header in settings. See [access refusals](../../docs/user/troubleshooting.md#forbidden-or-unauthorized-errors).
This does not sign you in or transfer your browser session.

## Choosing the file format

- **Auto** chooses JPEG for an opaque image within JPEG's dimensions, otherwise PNG.
- **PNG or TIFF** are lossless choices for archiving and editing.
- **JPEG** suits smaller on-screen copies; it is limited to 65,535 pixels per side.
- **WebP** is lossless here, but needs a complete pixel buffer and is limited to
  16,383 pixels per side.
- **ZIF** is a tiled multi-resolution image and omits transparency.
- **IIIF** saves a folder with `info.json` and tiles for a static web viewer.

Compression controls JPEG quality (100 minus compression); TIFF stays lossless.
Compatible IIIF/ZIF tiles keep their original compressed bytes.

## Settings

Choose an output folder, format, compression, optional size caps, retry budget,
cache folder, and request headers. Settings persist on this device. Invalid
values are refused rather than starting a job with them.

## If a save fails

Read the error's suggested next step. If some tiles are missing, choose retry,
keep, or discard where offered; without an answer, desktop applies its default
after 60 seconds. Kept output uses a `.partial` sibling (`photo.partial.png`),
leaving the intended complete filename untouched. Run again to reuse good cached
tiles. A job with no usable tiles saves nothing.

If opening a saved file fails, try **Show in folder**. Use **Technical details &
logs** for a report, reviewing sensitive addresses and settings before sharing.

## Next steps

- [Troubleshooting](../../docs/user/troubleshooting.md)
- [Command-line usage](../../docs/user/command-line.md)
