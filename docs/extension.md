# Browser Extension

The extension is MV3 in Chromium and Firefox. The toolbar click grants access to the active tab and opens a dedicated job page. The job page owns discovery, the Rust invocation, browser permissions, retry and cancellation, saving, and presentation. The background is a toolbar launcher with a small in-memory source-tab-to-job-tab directory.

## Background launcher

The background opens `job.html#sourceTabId=<id>` for the clicked tab. A repeated click focuses the existing job tab and sends one `dz.toolbar-click` event; the job page cancels an active job and leaves a completed job available. Closing either tab removes the directory entry. The background does not scan, fetch, prompt for permissions, maintain job state, or run discovery, and a background restart does not stop a job already owned by its tab.

The launcher uses only the toolbar click and tab APIs needed to open and focus the job. The test-only runtime messages are absent from production behavior. The package declares no permanent host permissions or content scripts.

## Job ownership and discovery

The job page reads the source tab ID from its fragment, gets that tab's current URL, and creates one source-access object for that document. Each attempt calls `scan()` once, then calls the shared browser application. A retry retires that invocation, scans the same source document once, and starts a new invocation.

`source-access.ts` exposes two ordinary asynchronous calls:

```ts
const inputs = await source.scan();
const result = await source.fetch(request, signal);
```

The module injects the self-contained functions in `job/source-operations.ts` with `scripting.executeScript({ target: { tabId, frameIds: [0] } })`. Their argument and return shapes come from `Parameters`, `Awaited`, and `ReturnType`; the job page validates URLs, headers, document identity, result shape, candidate and payload limits at this browser boundary.

Scan inputs use the generated `JobInput` contract: the top document is a `source`, readable child frames are `observed-document`, and retained performance resource URLs are `observed-resource`. The WASM binding preserves these kinds into the shared Rust discovery scheduler. The extension supplies evidence; format recognition, precedence, navigation, and job-wide discovery limits belong to Rust.

One source-access object is bound to one source document. A loading event, tab close, changed URL, or returned result from another document invalidates it, discarding results that finish after invalidation. A job that already has inputs can continue through the extension-origin transport when source-context access is lost; the source tab is never silently rebound after navigation. Firefox document IDs are not required, so the current Firefox 133 minimum remains supported.

The source fetch operation tracks live requests in the extension isolated world. Cancellation aborts a live fetch and acknowledges its completion; cancellation delivered before the fetch starts prevents that request from starting. Responses are streamed and capped at 8 MiB before they cross the script boundary as base64; the job page decodes and checks the payload once.

Every source operation has one absolute 30-second deadline covering browser API calls and response bodies. Cancellation, navigation, and disposal wait for the fetch result or cancellation acknowledgement, bounded by that same deadline if browser replies disappear. Delayed injections cannot start an expired request, and late results cannot revive retired work. Timeouts remain typed transient failures for the Rust invocation retry policy rather than starting an unbounded second route.

## Fetching and permissions

BrowserHost shares access requests within the invocation. Discovery first reads with interaction forbidden and explores accessible alternatives. When automatic work is exhausted it awaits the visible grant action. The click invokes the browser permission API synchronously, preserving user activation. Denied origins remain denied for that invocation; cancellation closes pending interactions. An upstream HTTP refusal never opens a permission action.

`activeTab` and `scripting` grant one explicit source-page scan after the toolbar click; `downloads` lets the job page confirm that its generated file finished saving. Same-origin reads carry the page's browser session, including its cookies, and metadata and requests for the source page's own origin use this context first. A source-context failure falls back to the extension-origin transport; a definitive HTTP refusal remains a typed failure. Cross-origin tiles use the extension-origin transport under an explicitly granted optional host permission. The permission request is made synchronously from the visible job-page action so the browser retains user activation. The job page checks and observes permissions directly; there is no permission mirror in the background.

Extension-origin requests attach no cookies or `Authorization` header and follow redirects through browser fetch. Redirect responses do not disclose their bytes to the redirecting site. The extension never uses the metadata proxy. Ordinary unprocessed tiles without readable bytes fall back to `<img>` display, which is visible but tainted and cannot be read or saved.

## Job, save, and display

The job page hosts the shared [browser application](browser-runtime.md#host-operations): WASM function, BrowserHost, transport, decode, canvas, save, and shared UI. It selects the largest image and fitting level. The algorithm owns retries, partial decisions, and ordering. A clean canvas is saved from a Blob URL through the browser download manager; the Rust invocation completes only after the manager confirms the file. Cancellation and failed status lookups cancel an unfinished download before releasing its Blob URL. The URL stays valid until a terminal event or the cancellation request settles. A tainted output remains display-only, and product actions stay in the job page.

The confirmed download ID drives the shared **Open image** and **Show in folder** actions through `downloads.open` and `downloads.show`. The shared UI handles pending actions and errors; tainted output has no file actions. Failures and retry actions stay in the job page. A retry takes another bounded source snapshot only if the original source document is still live. No Start over exists; a new job starts from the toolbar on the source page.

## Packaging and tests

The protected-session fixture requires both its HttpOnly session cookie and the exact source-page referrer for metadata and every tile. Both packaged browsers must save the readable image through this route; extension-tab requests with only the cookie fail the fixture.

WXT generates both MV3 manifests from `apps/extension/wxt.config.ts` (Chromium service worker and Firefox classic background script). The store package ships the launcher, job page, shared UI, browser runtime, icons, and WASM, with no content scripts or fallback pages. Build, dev, test, and release regenerate the WASM glue before WXT builds, and packaging needs root workspace dependencies (`cargo xtask setup` or `pnpm install --frozen-lockfile`). Browser-suite coverage: [Testing](testing.md).

The same algorithm and fixture contracts as web and desktop govern job behavior. See the [user guide](user/browser-extension.md).

## Diagnostics

Request counters measure route attempts, including source-document, extension-origin, and ordinary-image fallback. Pending attempts settle as completed, failed, or cancelled; tile totals come independently from progress. Definitive source HTTP refusals are grouped at warning level with their route and URL, even when no fallback occurs. Ordinary-image failures explicitly report unavailable HTTP status. Elapsed time uses the attempt's original start time across every render.

Each attempt owns a bounded [diagnostic report](errors.md#diagnostic-reports) retaining the scanned document URL, candidate count and overflow, candidate URLs without DOM contents, the first tile request, source fetch status and content type, extension-origin fallback, and permission prompts and failures. The report survives cancellation. Browser injection failures preserve their original cause; the shared application owns diagnostic capture. URLs remain intact; technical details show the conditional sign-in note from the [data-use guidance](user/browser-extension.md#what-the-extension-does-with-your-data) before sharing controls.
