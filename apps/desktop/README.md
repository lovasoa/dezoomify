# Desktop application

Installation and use: [desktop guide](desktop-app.md).

## Development and tests

```sh
cargo xtask dev desktop
cargo xtask test desktop
cargo xtask test desktop --e2e-window
```

The real-window lane needs a display (headless Linux: `xvfb-run -a`) and the
platform webview packages below. Its WebDriver is embedded; no driver installation
is needed. CI lanes live in the [desktop workflow](../../.github/workflows/desktop.yml).

## Bundles

`cargo xtask build desktop` builds the shell, frontend, icons, and matching-host
bundles (Linux: `.deb` and `.AppImage`). `--unsigned-test` builds without bundling.
Run repository setup first; see the [root README](../../README.md#build-and-contribute).

| Host    | Prerequisites                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential`, and `dpkg-deb` (`dpkg-dev`) |
| Windows | WebView2, NSIS, and generated `icons/icon.ico`                                                                                              |
| macOS   | Xcode Command Line Tools and generated `icons/icon.icns`                                                                                    |

Signing and publication: [release runbook](../../release/README.md).
