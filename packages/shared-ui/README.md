# shared-ui

The Dezoomify interface shared by the website, desktop app, and extension:
URL entry, automatic format detection, progress, cancellation, results, and
error guidance. Shared pure helpers own history, queues, naming, and bounded
diagnostic reports.

Products supply progress, results, and ordinary action callbacks. The UI
never touches network, filesystem, or extension APIs directly.

Contributing: keep components host-neutral, error codes stable, and the
active transport always visible. Tests live beside the sources.
