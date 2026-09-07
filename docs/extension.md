# Browser extension

The extension is MV3 in both browsers with one shared manifest base:
Chromium runs the background as a service worker, Firefox as an event page
(the per-browser overlay declares only its own `background` entry; Chrome
121+ for `wasm-unsafe-eval`). The background is one-shot and dormant by
construction: the toolbar click arms indefinite explicit-action monitoring
on exactly the clicked tab (grey icon becomes blue with a dot), performs at
most one reload, and opens nothing until detection. On detection the job
hosts in a modal in the same tab. The extension does not use the metadata
CORS proxy.

## Discovery

Monitoring begins only after an explicit action: the toolbar button (activeTab grant on the clicked
tab), which arms monitoring on exactly that tab. The toolbar icon reports
state: grey means idle, blue with a dot means monitoring. Monitoring is
indefinite: it carries no deadline and never polls in the background. It
stops on the first terminal signal: detection, a second click (replace and
cancel), tab close, or navigation away. A reload never rearms scanning and
stopped monitoring never restarts itself. Monitoring never enumerates tabs:
it touches only the clicked tab via `tabs.get`/`tabs.reload` plus a bounded
webRequest collector filtered to the exact target tab and the `http(s)`
schemes before at most one reload. The unbound first-run page shows guidance
only and makes zero tabs API calls.

Candidates are the observed request URLs; `crates/dezoomify-core` (wasm,
loaded inline) performs format recognition and discovery on the
chosen candidate. Detection stops monitoring and opens the modal: a
Shadow-DOM host in the same tab holds a `chrome.runtime.getURL` iframe
(`modal/modal.html`, web-accessible on http/https only) that runs the job
through the shared-ui `renderView` geometry with tab-origin direct fetch,
origin-clean save or `<img>` display-only, blob-anchor save, and the native
handoff offer. Closing the modal disposes the collector, revokes object
URLs, and restores the grey icon. The scan state machine is shared code
(`apps/extension/src/page/scan.ts`) exercised by unit tests and by the
headless E2E in both engines. The modal-in-tab UI hosts the job in the
detected tab itself; it never opens a new tab for results.

## Fetching

The extension fetches with tab-origin direct fetch under the narrowest grant
(activeTab on the monitored tab, or explicitly granted host permissions for
other origins such as redirect targets) and the current browser session. It
validates every URL and redirect against that grant and applies size limits
(`apps/extension/src/page/fetch.ts`). The active transport is always visible.
Website JavaScript cannot call this fetch channel. The extension never uses
the metadata CORS proxy: readable metadata, processed tiles, and clean saves
use tab-origin bytes first, and CORS-blocked sources without readable bytes
fall back to `<img>` tainted display-only (visible, no pixel reads).

The wasm core decodes and processes the bytes, and the page assembles them on
an origin-clean canvas. Page cookies follow browser extension permission and
credential rules. The saved image is written via a blob-anchor download, which
needs no `downloads` permission.

## Native handoff

The extension offers native handoff for huge outputs or local destinations. Source URLs, catalog
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
per-browser overlay (Chromium: service worker + minimum version; Firefox:
event-page scripts + gecko id and minimum version); underscore-prefixed
overlay keys (the `_compatNote` background/offscreen notes) never ship.
`scripts/package-store.sh` stages only the loaded entry points
(background/index.js as a classic script with export statements
stripped, the injected in-tab modal `content/modal.js` as a classic script
plus `content/modal.css`, the job iframe `modal/modal.html` + `modal/modal.js`
reusing the page entry plus its direct imports, declared blue
brand icons plus the grey idle set swapped via
`action.setIcon`) plus the generated wasm glue at top-level `wasm/`, and
ships only reviewed store shapes; unit-tested libs that the manifest/page
never load (background detect/handoff/native helpers, content reload marker,
page redaction, app integration) stay in `src` for tests and never ship. The
`DEZOOMIFY_TEST_HOST_PERMISSIONS=1` variant injects loopback host
permissions for the headless E2E only (the drivers cannot click browser
chrome to grant activeTab; the harness creates its target via a single
`tabs.create` and drives the bound `?tab=` flow, never enumerating tabs)
and is never used for store payloads.

User-facing job behavior comes from the same protocol and scenarios as web
and desktop. See [Testing](testing.md) and [Releases](releases.md). For
user-facing use, see [browser extension](user/browser-extension.md).
