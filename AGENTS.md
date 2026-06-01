# Project Guide

Dezoomify is a browser app for turning tiled zoomable images into a single image.

## Important files

- [index.html](index.html) loads the app shell and registers every dezoomer script. Script order matters for automatic detection when multiple dezoomers can match the same URL.
- [zoommanager.js](zoommanager.js) owns the main app flow: selected dezoomer, proxy configuration, tile scheduling, progress, and output assembly.
- [browser-init.js](browser-init.js) wires the browser UI to `ZoomManager`.
- [dezoomers/automatic.js](dezoomers/automatic.js) implements "Select automatically". It first tests each dezoomer's `urls` patterns, then fetches page contents and tests `contents` patterns.
- [dezoomers/](dezoomers) contains one file per zoom protocol or website family. Each dezoomer should expose URL/content detection plus the code that resolves metadata and tiles.
- [functions/proxy.js](functions/proxy.js) is the shared Javascript proxy handler and Cloudflare Pages Function for `/proxy`. [node-app/proxy.js](node-app/proxy.js) adapts that handler to a local Node HTTP server.
- [tests/dezoomers.spec.js](tests/dezoomers.spec.js) is the deterministic Playwright suite for dezoomer behavior.
- [tests/fixture-server.js](tests/fixture-server.js) serves the app, local fixtures, and intercepted remote fixture URLs for deterministic tests.
- [tests/live-smoke.js](tests/live-smoke.js) checks a small set of real websites and endpoints that are expected to remain online.
- [.github/workflows/node.js.yml](.github/workflows/node.js.yml) runs the deterministic test suite on PRs and pushes, and runs live smoke tests as a non-blocking warning job.

## Testing

Install test dependencies from [tests](tests):

```sh
npm ci
```

Run deterministic tests:

```sh
npm test
```

These tests start [tests/fixture-server.js](tests/fixture-server.js), open the real app in Chromium, and run fixture URLs through "Select automatically" whenever possible. They should not depend on live third-party websites. When a dezoomer supports automatic discovery, add or update a fixture that proves automatic selection reaches that dezoomer.

Run live smoke checks manually:

```sh
npm run test:live
```

Live smoke tests intentionally touch real websites. They are allowed to be flaky because external sites change or go down, so CI runs them as `continue-on-error` and emits GitHub warning annotations for failures. Do not use live-only behavior as the sole regression coverage for a dezoomer; keep deterministic fixtures in [tests/dezoomers.spec.js](tests/dezoomers.spec.js) for protocol behavior, and use [tests/live-smoke.js](tests/live-smoke.js) to notice when real-world examples have changed.
