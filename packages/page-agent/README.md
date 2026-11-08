# page-agent

Viewer discovery and live tile access run inside the inspected page's main
JavaScript world, independent of extension permissions and host SDKs.

The extension injects `viewer-scanner.js` only when a job needs to inspect a
document. The scanner finds viewers and registers their live tile loaders in
module-local state. If any live viewers are found, it opens a job-scoped page
listener and returns a random channel ID with its observations.

The extension uses one long-lived `tabs.connect` Port per scanned frame with
live viewers. An isolated-world bridge hands the page listener a MessagePort
and forwards messages unchanged between it and the extension Port, so tile
bytes cross both hops as structured-clone ArrayBuffers. The listener answers
`ready` on the handoff, retires itself if no bridge claims it in time, and
releases the scan's handles when the Port closes. There is no page global
registry or generic cross-host agent service.

The extension retains ownership of browser permissions, document identity,
request validation, networking, retries, and the job lifecycle. Replies from
the page must always be treated as untrusted.

The package remains bundleable as one script and may not import extension or
desktop APIs. Browser tests cover live viewer adapters and message transport.
