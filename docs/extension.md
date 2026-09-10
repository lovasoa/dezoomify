# Browser Extension

The extension is MV3 in both browsers with one shared manifest base:
Chromium runs the background as a service worker and Firefox as an event page.
The toolbar click starts one explicit-action job on exactly the clicked tab.
The background opens the dedicated job tab and performs finite source
operations in the clicked tab; it does not reload the source page or install a
persistent source collector. There is no fallback extension page or unrelated
tab monitoring.

## Discovery

Scanning begins only after an explicit toolbar action. The icon is grey while
idle and blue with a dot while the job is active. The source binding is
invalidated on navigation, tab close, cancellation, or worker restart. The
background never polls, enumerates tabs, or rearms a source operation.

Candidates come from the monitored tab's own performance timeline. The
background deliberately observes no traffic: a `webRequest` listener without
host permissions is deaf, and `activeTab` does not enable observation. No
permanent host permissions are declared.

`crates/dezoomify-core` runs through WASM inside the dedicated extension job
tab. It recognizes formats from fetched bytes, not URL text. The first
candidate whose bytes produce an image confirms detection in the job tab.

`apps/extension/src/background/source-operations.ts` contains the two
self-contained functions passed to `scripting.executeScript()`. The first
takes a bounded snapshot of the document URL and retained resource-timing
entries when the job tab is ready. The second performs a tab-origin fetch and
returns bounded structured-cloneable chunks. Neither operation registers a
listener or observes resources after it returns. A later snapshot is bounded
and deduplicated if discovery requests more candidates. If an operation cannot
start or its binding is stale, the toolbar shows an error badge; the extension
never silently opens another page.

## Fetching

The extension fetches with tab-origin direct fetch under the narrowest grant:
`activeTab` for the clicked tab, or an explicitly granted optional host
permission for another origin or redirect target. It uses the current browser
session and validates each operation's URL, method, declared headers, result
shape, and byte cap.

Readable metadata, processed tiles, and clean saves use tab-origin bytes. The
extension never uses the metadata CORS proxy. If readable fetching is
unavailable for an ordinary unprocessed tile, the job may use an ordinary
`<img>` display fallback; the result stays visible but tainted and cannot be
read or programmatically saved.

## Job and save

The job tab uses the WASM core to discover an image, select a level, plan
tiles, apply processing, and assemble the result on a canvas. A clean canvas is
saved through a Blob URL and anchor click, which needs no `downloads`
permission. A tainted canvas finishes as display-only and never receives pixel
reads or serialization calls afterward.

User-visible job failures stay in the job tab. Background failures keep an
error badge and action title until the user clicks again or the source tab
leaves the bound page.

## Native handoff

The extension may offer native handoff for huge outputs or local destinations.
It reaches native only through allowlisted Native Messaging. A fresh challenge
and one-use nonce bind messages to one consent session and prevent replay; they
do not establish identity. Cookies pass only after a prompt names the
destination origins and scope, and are not intentionally persisted.

## Packaging

WXT generates both MV3 manifests from `apps/extension/wxt.config.ts`. Chromium
uses the bundled `background.js` service worker. Firefox uses the same classic
IIFE artifact through `background.scripts`; the artifact verifier parses it
with `node --check`. The store package ships only the background finite-operation
coordinator, dedicated job tab, generated vendor mirrors, icons, and WASM. No
source content script or fallback extension-page entry is packaged or tested.

Extension build, development, test, and release entry points regenerate the
WASM glue from the current Rust source before WXT builds. The extension test gate
does so before its unit suite, whose worker contract runs a real generated WASM
session through the first discovery round trip; an absent, stale, or
incompatible binding is a blocking failure before browser E2E starts.
WXT packaging requires the root workspace dependencies installed by
`cargo xtask setup` or `pnpm install --frozen-lockfile`; it never invokes a
second package manager.

User-facing job behavior comes from the same protocol and scenarios as web and
desktop. See [Testing](testing.md) and [Releases](releases.md). For user-facing
use, see [browser extension](user/browser-extension.md).

## Diagnostics

The background logs structured console lines
(`[dezoomify:background] <level> <code> <detail>`). Lifecycle milestones are
logged at info, recoverable states at warn, and terminal failures at error.
Logged URLs are redacted. User-visible failures travel through the dedicated
job tab rather than disappearing with the toolbar state.
