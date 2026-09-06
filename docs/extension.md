# Browser extension

The extension is MV3 in both browsers with one shared manifest: Chromium runs
the background as a service worker, Firefox as an event page (`background`
declares both `service_worker` and `scripts`; Chrome 121+ ignores the scripts
key, Firefox ignores the service worker key). The background is one-shot and
dormant by construction: the toolbar action opens the extension page bound to
the clicked tab, and install opens it once for first-run guidance. The page
hosts the job. The extension does not use the metadata CORS proxy.

## Discovery

The extension does not scan pages in the background. Scanning begins only
after an explicit action: the toolbar button (activeTab grant on the clicked
tab) or a tab chosen in the extension page's tab list. The page registers a
bounded webRequest collector filtered to the exact target tab before at most
one reload, observes through a finite settle period and hard deadline, then
stops. A reload never rearms scanning.

Candidates are the observed request URLs; `crates/dezoomify-core` (wasm,
loaded inline in the page) performs format recognition and discovery on the
chosen candidate. The finite scan state machine is shared code
(`apps/extension/src/page/scan.ts`) exercised by unit tests and by the
headless E2E in both engines.

## Fetching

The extension page obtains readable bytes directly under the narrowest grant
(activeTab on the scanned tab, or explicitly granted host permissions for
other origins such as redirect targets) and the current browser session. It
validates every URL and redirect against that grant and applies size limits
(`apps/extension/src/page/fetch.ts`). Website JavaScript cannot call this
fetch channel.

The wasm core decodes and processes the bytes, and the page assembles them on
an origin-clean canvas. Page cookies follow browser extension permission and
credential rules. The saved image is written through the downloads API via a
blob anchor.

## Native handoff

The extension offers native handoff for huge outputs, local destinations,
bulk work, unsupported codecs, or durable jobs. Source URLs, catalog
selection, recipes, and non-secret headers form bounded untrusted input that
native validates and the user confirms.

The extension reaches native only through allowlisted Native Messaging.
Browser enforcement of the native host's allowed extension IDs authenticates
the extension sender to the native host. A fresh challenge and one-use nonce
bind messages to one explicit consent session and prevent replay; they do not
establish identity. Cookies pass only to native after the prompt names the
destination origins and scope; they are not intentionally persisted.
Declining consent keeps the job in the extension and offers credential-free
recovery choices. See [Protocol](protocol.md#handoff) and
[Security](security.md#credentials).

## Packaging

`scripts/generate-manifests.mjs` produces `generated/manifest.{chromium,firefox}.json`
as deterministic merges of `src/manifest/base.json` plus a minimal
per-browser overlay (Chromium: minimum version; Firefox: gecko id and minimum
version); underscore-prefixed overlay keys never ship. `scripts/package-store.sh`
stages background/ and content/ as classic scripts (export statements
stripped; they must parse without module syntax) and page/ as ES modules,
copies the generated wasm glue, and ships only reviewed store shapes. The
`DEZOOMIFY_TEST_HOST_PERMISSIONS=1` variant injects loopback host permissions
plus the tabs permission for the headless E2E only (the drivers cannot click
browser chrome to grant activeTab) and is never used for store payloads.

User-facing job behavior comes from the same protocol and scenarios as web
and desktop. See [Testing](testing.md) and [Releases](releases.md).
