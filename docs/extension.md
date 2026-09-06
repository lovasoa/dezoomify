# Browser extension

The extension is MV3 in both browsers with one shared manifest base:
Chromium runs the background as a service worker, Firefox as an event page
(the per-browser overlay declares only its own `background` entry; Chrome
121+ for `wasm-unsafe-eval`). The background is one-shot and dormant by
construction: the toolbar action opens the extension page bound to the
clicked tab, and install opens it once for first-run guidance. The page
hosts the job. The extension does not use the metadata CORS proxy.

## Discovery

The extension does not scan pages in the background. Scanning begins only
after an explicit action: the toolbar button (activeTab grant on the clicked
tab), which opens the extension page bound to exactly that tab
(`page.html?tab=<id>`). The page never enumerates tabs: it touches only the
bound tab via `tabs.get`/`tabs.reload` plus a bounded webRequest collector
filtered to the exact target tab and the `http(s)` schemes before at most
one reload, observes through a finite settle period and hard deadline, then
stops. The unbound first-run page shows guidance only and makes zero tabs
API calls. A reload never rearms scanning.

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
overlay keys never ship. `scripts/package-store.sh` stages only the loaded
entry points (background/index.js as a classic script with export statements
stripped, the page entry plus its direct imports as ES modules, declared
icons) plus the generated wasm glue, and ships only reviewed store shapes;
unit-tested libs that the manifest/page never load (background handoff/native
helpers, content reload marker, page redaction, app integration) stay in `src`
for tests and never ship. The `DEZOOMIFY_TEST_HOST_PERMISSIONS=1` variant
injects loopback host permissions for the headless E2E only (the drivers
cannot click browser chrome to grant activeTab; the harness creates its target
via a single `tabs.create` and drives the bound `?tab=` flow, never
enumerating tabs) and is never used for store payloads.

User-facing job behavior comes from the same protocol and scenarios as web
and desktop. See [Testing](testing.md) and [Releases](releases.md).
