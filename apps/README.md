# Applications

The four user-facing programs. Each composes the shared engine
(`crates/`) and shared UI (`packages/`) with its own host capabilities;
no app imports another app, and reusable logic lives below, not in apps.

- [The repository root](../): the website, where you paste a URL and download
  the image (the web app lives at the root, not in this directory).
- [`extension/`](extension/): browser extension, a one-shot active-tab scan
  using your browser session.
- [`desktop/`](desktop/): Tauri desktop app for local files, deep links, and
  the native messaging host.
- [`cli/`](cli/): the `dezoomify` command for scripting, bulk mode, and exit
  codes.

Contributing: an app owns its entry point, config, smoke tests, and packaging.
Put reusable domain logic in a crate/package instead.
