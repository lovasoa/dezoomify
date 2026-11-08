# page-agent

Viewer discovery and live tile access that run inside the inspected page.

The browser extension bundles `scanViewers` as `viewer-scanner.js` for the
page's main world. The scanner retains the live viewer loaders it discovers
in a document-global registry of opaque handles. The extension invokes the
self-contained `readViewerTile` and `releaseViewerTiles` functions directly
through `scripting.executeScript`; the registry survives later scans in the
same document, but no agent service needs installation.

This package owns viewer adapters, traversal, and the handle registry.
The extension owns injection, source/document validation, permission prompts,
networking, job lifetimes, and ordinary DOM-image fallbacks. Values returned
from an inspected page are untrusted and must be validated by the host.

The runtime must remain independently bundleable and must not access host
APIs such as `chrome.*` or Tauri. Browser tests exercise the same
scanner and serialized tile functions used by the extension.
