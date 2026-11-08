# page-agent

Viewer discovery and live tile access that runs **inside the inspected page**.
The [extension](../../apps/extension) and, later, other hosts install it into a
document and drive it through the wire contract in
[`src/messages.ts`](src/messages.ts).

Everything here executes in the page's own JavaScript world, beside hostile code.
It therefore never touches host facilities: no `chrome.*`, no Tauri, no fetch on
the host's behalf, no file or output paths. Anything it returns is untrusted and
the host must validate it before use.

Two rules shape the code:

- **It must bundle to a single self-contained script.** A host injects one file
  into a document it does not control, so entry points may not close over module
  scope and the package may not pull in React or any product's runtime.
- **State outlives one injection.** Hosts inject the agent again for later jobs
  in the same document, so anything that must survive, like the viewer handle
  registry in [`src/viewers/session.ts`](src/viewers/session.ts), lives on the
  global object rather than in module scope.

Library knowledge lives in the adapter directories; traversal, source ownership,
and the handle lifecycle are shared. See [`docs/testing.md`](../../docs/testing.md)
for how the browser suites drive this code without an extension.
