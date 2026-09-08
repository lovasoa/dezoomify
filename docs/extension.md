# Browser Extension

The extension is MV3 in both browsers with one shared manifest base:
Chromium runs the background as a service worker and Firefox as an event page.
The background is one-shot and dormant by construction: the toolbar click
arms indefinite explicit-action monitoring on exactly the clicked tab, performs
at most one reload, injects the in-tab monitor after reload completion, and
reveals the job UI only after byte confirmation. There is no fallback extension
page and no automatic tab opening.

## Discovery

Monitoring begins only after an explicit toolbar action. The icon is grey while
idle and blue with a dot while monitoring. Monitoring stops on detection, a
second click, tab close, or navigation away. It never polls, enumerates tabs,
or rearms after a worker restart.

Candidates come from the monitored tab's own performance timeline. The
background deliberately observes no traffic: a `webRequest` listener without
host permissions is deaf, and `activeTab` does not enable observation. No
permanent host permissions are declared.

`crates/dezoomify-core` runs through WASM inside the extension iframe. It
recognizes formats from fetched bytes, not URL text. The first candidate whose
bytes produce an image confirms detection and replaces the monitoring card
with the job UI in the same tab.

The source collector is `apps/extension/src/content/modal.js`. Chromium loads
it directly into the clicked tab. Firefox temporarily registers it for the
clicked tab origin and reloads that tab once because programmatic Firefox
content scripts do not retain runtime listeners. The collector observes
resource entries and supplies the extension-origin job tab. If the job cannot
start, the toolbar shows an error badge; the extension never silently opens
another page.

## Fetching

The extension fetches with tab-origin direct fetch under the narrowest grant:
`activeTab` for the clicked tab, or an explicitly granted optional host
permission for another origin or redirect target. It uses the current browser
session and validates every URL and redirect against that grant.

Readable metadata, processed tiles, and clean saves use tab-origin bytes. The
extension never uses the metadata CORS proxy. If readable fetching is
unavailable for an ordinary unprocessed tile, the job may use an ordinary
`<img>` display fallback; the result stays visible but tainted and cannot be
read or programmatically saved.

## Job and save

The modal job uses the WASM core to discover an image, select a level, plan
tiles, apply processing, and assemble the result on a canvas. A clean canvas is
saved through a Blob URL and anchor click, which needs no `downloads`
permission. A tainted canvas finishes as display-only and never receives pixel
reads or serialization calls afterward.

User-visible job failures stay in the modal. Startup failures stay in the
monitoring card. Background failures keep an error badge and action title until
the user clicks again or the tab leaves the monitored page.

## Native handoff

The extension may offer native handoff for huge outputs or local destinations.
It reaches native only through allowlisted Native Messaging. A fresh challenge
and one-use nonce bind messages to one consent session and prevent replay; they
do not establish identity. Cookies pass only after a prompt names the
destination origins and scope, and are not intentionally persisted.

## Packaging

`scripts/generate-manifests.mjs` produces the browser manifests from
`src/manifest/base.json` and the per-browser overlays. The store package ships
only the background, injected tab monitor, modal iframe, modal runtime
modules, generated vendor mirrors, icons, and WASM. The removed extension-page
entry and its scanner are not packaged or tested.

User-facing job behavior comes from the same protocol and scenarios as web and
desktop. See [Testing](testing.md) and [Releases](releases.md). For user-facing
use, see [browser extension](user/browser-extension.md).

## Diagnostics

The background logs structured console lines
(`[dezoomify:background] <level> <code> <detail>`). Lifecycle milestones are
logged at info, recoverable states at warn, and terminal failures at error.
Logged URLs are redacted. User-visible failures travel through the in-tab
modal or monitoring card rather than disappearing with the toolbar state.
