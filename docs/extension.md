# Browser Extension

The extension is MV3 in both browsers with one shared manifest base:
Chromium runs the background as a service worker and Firefox as an event page.
The toolbar click starts one explicit-action job on exactly the clicked tab.
The background opens the dedicated job tab and performs finite source
operations in the clicked tab; it does not reload the source page or install a
persistent source collector. There is no fallback extension page or unrelated
tab monitoring.

## Discovery

Scanning begins only after an explicit toolbar action or an explicit retry of
a retryable failure in the job tab. The icon is grey while idle and blue with a
dot while the job is active. The source binding is invalidated on navigation,
tab close, cancellation, or worker restart. The background never polls or
enumerates tabs. Each attempt, the first and every retry, takes exactly one
bounded source snapshot; a retry discards any snapshot still in flight from the
previous attempt and starts a new engine attempt.

The initial ordered batch contains the rendered top-document `outerHTML`, then
the rendered DOM of readable same-origin iframes, then URL-only references
from the monitored tab's performance timeline. Cross-origin iframes are
skipped. The background deliberately observes no traffic: a `webRequest`
listener without host permissions is deaf, and `activeTab` does not enable
observation. No permanent host permissions are declared.

`crates/dezoomify-core` runs through WASM inside the dedicated extension job
tab. It evaluates captured DOM bytes directly before fetching URL-only roots.
The first root whose bytes produce an image confirms detection in the job tab.

`apps/extension/src/background/source-operations.ts` contains the two
self-contained functions passed to `scripting.executeScript()`. The first
takes a bounded snapshot of rendered document roots and retained
resource-timing entries when the job tab is ready. The second performs a tab-origin fetch and
returns bounded structured-cloneable chunks. Neither operation registers a
listener or observes resources after it returns. A later snapshot is bounded
and deduplicated if discovery requests more candidates. If an operation cannot
start or its binding is stale, the toolbar shows an error badge; the extension
never silently opens another page.

## Fetching

The extension fetches readable bytes with a tab-origin direct fetch under the
narrowest grant: `activeTab` for the clicked tab, or an explicitly granted
optional host permission for another origin or redirect target. Credentials
default to same-origin, so the page's session applies to its own origin while a
public cross-origin metadata server answering
`Access-Control-Allow-Origin: *` stays readable. When the source-tab fetch
fails, the job retries the request through the independent extension-origin
transport, which uses the current browser session under an optional host grant
and pauses for that grant only when the grant is missing. A granted-origin
401/403 refusal fails typed without another prompt; the grant is never
re-requested for a refusal the grant cannot fix. Every operation validates its
URL, method, declared headers, result shape, and byte cap.

Readable metadata, processed tiles, and clean saves use the browser session's
readable bytes. The extension never uses the metadata CORS proxy. If readable
fetching is unavailable for an ordinary unprocessed tile, the job may use an
ordinary `<img>` display fallback; the result stays visible but tainted and
cannot be read or programmatically saved.

## Job and save

The job tab uses the WASM core to discover an image, select a level, plan
tiles, apply processing, and assemble the result on a canvas. A clean canvas is
saved through a Blob URL and anchor click, which needs no `downloads`
permission. A tainted canvas finishes as display-only and never receives pixel
reads or serialization calls afterward.

User-visible job failures stay in the job tab. Background failures keep an
error badge and action title until the user clicks again or the source tab
leaves the bound page. A retryable failure offers Retry in the job tab: pressing
it takes a fresh snapshot of the bound page and starts a new attempt. The
extension never offers Start over, because a new job begins from the page's
toolbar button, not from an address entered in the job tab.

## Native handoff

The extension may offer native handoff for huge outputs or local destinations.
It reaches native only through allowlisted Native Messaging. A fresh challenge
and one-use nonce bind messages to one consent session and prevent replay; they
do not establish identity. Cookies pass only after a prompt names the
destination origins and scope, and are not intentionally persisted.

## Packaging

WXT generates both MV3 manifests from `apps/extension/wxt.config.ts`. Chromium
uses the bundled `background.js` service worker. Firefox uses the same classic
IIFE artifact through `background.scripts`; packaging parses it with `node --check`.
The store package ships only the background finite-operation
coordinator, the React dedicated job tab (bundling the workspace
`@dezoomify/shared-ui` and `@dezoomify/browser-runtime` packages), icons, and
WASM. No source content script or fallback extension-page entry is packaged
or tested.

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

Every extension context logs structured console lines
(`[<context>] [<code> ]<detail>`): `background` (the coordinator/service
worker), `job` (the dedicated job tab), and `worker` (the WASM session
worker). The console method carries the level; the `background` context is
the default and omits its bracket entirely, so a context bracket appears only
when a line comes from another context. The three contexts together trace each interaction with
the active tab (`toolbar-click`, `active-tab-op-start`/`active-tab-op-result`
for the finite `scripting.executeScript()` operations, `source-fetch-*`,
`permission-check`, `source-invalidated`) and each interaction with the core
(`session-created`, `command-dispatched`, `messages-drained`, `effect-*`,
`engine-event`, `core-error`).

The logger lives in `packages/browser-runtime/src/logging.ts`
(`@dezoomify/browser-runtime/logging`) so every product shares one
implementation; the extension imports the `./logging` subpath, never the
barrel. The job tab mirrors its accepted lines plus the worker's forwarded
`engine.log` lines into the job view's technical-details log, so both the job
and failed views (and copied diagnostics) carry the interaction trace.

Interaction milestones log at info, high-frequency per-tile and per-chunk
detail at debug, recoverable states at warn, and terminal failures at error.
The default level is info. Logged URLs are written in full for diagnosis;
details are bounded. User-visible failures travel through the dedicated job
tab rather than disappearing with the toolbar state.
