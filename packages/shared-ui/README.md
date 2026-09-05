# shared-ui

The Dezoomify interface shared by the website, desktop app, and extension:
URL entry, format choice, progress, cancellation, results, and layered error
guidance — host-neutral, so every app behaves the same.

Hosts plug in capabilities (fetch, save, permissions) through the runtime
integration contract; the UI never touches network, filesystem, or
extension APIs directly.

Contributing: keep components host-neutral, error codes stable, and the
active transport always visible. Tests live beside the sources.
