# Dezoomify

[Dezoomify](https://dezoomify.ophir.dev/) finds the full image behind a zoomable
viewer and assembles its tiles into a picture you can save.

- **[Website](https://dezoomify.ophir.dev/):** paste the viewing page address,
  then save a PNG. No installation; browser image-size limits apply.
  [Guide](docs/user/website.md).
- **Browser extension for [Chrome](https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm)
  and [Firefox](https://addons.mozilla.org/en-US/firefox/addon/dezoomify/):**
  finds hidden image addresses and uses your source-page login.
  [Guide](docs/user/browser-extension.md).
- **[Desktop app](https://github.com/lovasoa/dezoomify/releases/latest):**
  Windows, macOS, and Linux; larger images, local files, more output formats,
  and cached tiles for interrupted saves. [Installation and use](apps/desktop/desktop-app.md).
- **[Command-line tool](docs/user/command-line.md):** native saving for scripts,
  image/level selection, and lists of addresses.

The apps recognize IIIF, Deep Zoom, Zoomify, Google Arts & Culture, krpano,
and [other formats](docs/user/supported-formats.md). The
[legacy website](https://dezoomify.ophir.dev/legacy/) remains available.

## If it doesn't work

Use the extension for signed-in pages and desktop for images beyond browser
limits. For missing images, access refusals, and interrupted saves, see
[troubleshooting](docs/user/troubleshooting.md) or
[find the image address manually](docs/user/finding-the-image-address.md).

Before [reporting a problem](https://github.com/lovasoa/dezoomify/issues),
search existing issues for the site. Include the viewing page, the address you
gave Dezoomify, the app, and its error or diagnostic report. Review reports for
sensitive addresses before sharing.

## Build and contribute

Install Rust and the Node.js version in [`.node-version`](.node-version).
Native x86-64 builds need NASM 2.15 or newer for AVIF SIMD
(`apt install nasm`, `brew install nasm`, or `choco install nasm`).

```sh
cargo xtask setup
cargo xtask check
cargo xtask test
cargo xtask dev web
```

Setup installs frozen JavaScript dependencies and checks WASM tools; install
Rust toolchains and browser binaries separately. Native builds bundle the
offline viewer using Node, so run setup before building them.
Use `cargo xtask --help` for build, development, and test targets.
[Desktop prerequisites](apps/desktop/README.md#bundles) are platform-specific.

To build the CLI, run `cargo xtask build cli`, then:

```sh
target/debug/dezoomify-cli "https://museum.example/collection/painting" painting.png
```

Contribution rules are scoped in `AGENTS.md`. Start format support in
[`crates/dezoomify/`](crates/dezoomify/AGENTS.md) with a
[shared product fixture](fixtures/AGENTS.md). [Release recovery](release/README.md)
and [licensing provenance](docs/licensing.md) have separate records.
