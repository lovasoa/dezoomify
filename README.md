# Dezoomify

[Dezoomify](https://dezoomify.ophir.dev/beta/) finds the full image behind a
zoomable viewer and assembles its tiles into a picture you can save. It works
with image viewers used by museums, libraries, archives, and map collections.

## Runs in your browser and on your desktop

The same Dezoomify codebase runs on different platforms, with different
capabilities.

- **[Website](https://dezoomify.ophir.dev/beta/):** The easiest to run, but
  least powerful. Nothing to install: paste the address of the image's page.
  Some websites block it, and it cannot use your browser login. The browser
  limits the maximum image size, so it may save a smaller resolution than
  the source offers. Saves PNG files. [Guide](docs/user/website.md).
- **Browser extension [for Chrome](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
  and [for Firefox](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/):**
  Works with websites where you are signed in and works around some
  restrictions that prevent the website from saving images. It also finds
  image addresses that are hidden behind the viewer: open the image's page
  and click the Dezoomify button in your browser toolbar. Has the same final
  image size limits as the website. [Guide](docs/user/browser-extension.md).
- **[Desktop app](https://github.com/lovasoa/dezoomify/releases/latest):**
  For Windows, macOS, and Linux. Saves larger images, opens local files, and
  supports PNG, JPEG, TIFF, ZIF, WebP, and IIIF tile folders. Interrupted saves
  can resume using cached tiles. Image size is limited by your available
  memory. It can work with some sites that refuse the website's requests,
  but cannot reuse your browser login; use the extension for signed-in pages.
  [Guide](docs/user/desktop-app.md).
- **[Command-line tool](docs/user/command-line.md):** The same saving
  capabilities as the desktop app, for scripts. Choose a particular image or
  zoom level, limit the resolution, or save a list of addresses with `--bulk`.
  The [releases page](https://github.com/lovasoa/dezoomify/releases/latest)
  provides a Linux x86_64 executable in the `dezoomify-cli` archive. To build
  it from source, see below.

Desktop installers are available as `.msi` for Windows x86_64, `.dmg` for
Apple silicon Macs, and `.deb` for Linux x86_64. They are unsigned, so your
operating system may ask you to confirm that you trust the installer. Updates
are installed manually from the releases page; there is no automatic update.

The [legacy website](https://dezoomify.ophir.dev/) remains available.

## Save your first image

1. Open the page that shows the zoomable image and copy its address.
2. Paste it into the [Dezoomify website](https://dezoomify.ophir.dev/beta/)
   and press **Dezoomify**.
3. When the image is ready, press **Save** to keep the PNG file.

Dezoomify supports IIIF, Deep Zoom, Zoomify, Google Arts & Culture, krpano,
and [other image formats](docs/user/supported-formats.md). No app works with
every website. If you already have the address of the image's description
file, such as `info.json`, `ImageProperties.xml`, or a `.dzi` file, you can
paste that directly instead of the viewer page.

## If it doesn't work

- **No image found:** Try the browser extension on the page showing the
  image. If it still finds nothing, follow
  [finding the image address](docs/user/finding-the-image-address.md) to
  locate the description file yourself.
- **Login required or access refused:** Use the extension while signed in.
  If the site only serves images to its own viewer, the desktop app or CLI
  can identify the viewing page in their requests; see
  [forbidden or unauthorized errors](docs/user/troubleshooting.md#forbidden-or-unauthorized-errors).
- **Image too large, blank, or impossible to save:** Use the desktop app.
  Installing the extension does not remove the browser's size limits.
- **Too many requests (429):** Wait a few minutes before trying again.

See [troubleshooting](docs/user/troubleshooting.md) for interrupted saves
and other problems. Search [existing issues](https://github.com/lovasoa/dezoomify/issues)
for the site's name before
[requesting support for a site](https://github.com/lovasoa/dezoomify/issues/new?template=0_new-site-support.md)
or [reporting an app bug](https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md).
Include the exact viewing page address, the address you gave Dezoomify,
which app you used, and the error message or diagnostic report from
**Technical details & logs**.

## Build and contribute

Install Rust and Node.js 22.18.0 or newer, then run these commands from the
repository root:

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask dev web
```

To build the command-line tool, run `cargo xtask build cli`. The executable
is `target/debug/dezoomify-cli`:

```sh
target/debug/dezoomify-cli "https://museum.example/collection/painting" painting.png
```

See the [development guide](docs/development.md) for build and test commands,
and [Contributing a format](docs/CONTRIBUTING-format.md) to add support for a
site format.
