# Application

The shared UI renders progress, awaited choices, errors, and completed output.
Its presentation functions are pure. React components receive callbacks and
never access host globals.

One browser application serves the website and extension. Products inject input
acquisition, resource reading, explicit permission operations, saving, and
optional toolbar activity. A browser invocation owns its AbortController,
pause gate, pending choices, diagnostics, and concrete cleanup.

Starting a replacement retires the previous invocation and waits for its resources
before starting new work; the view updates immediately. Every asynchronous
completion checks ownership before changing the view, history, queue, or output.
Cancellation aborts active I/O and closes pending interactions; completion awaits
cleanup. A completed preview remains available until the user retires that result.
Permission operations run synchronously from the actual user click handler.

Shared FIFO utilities activate one job, advance after success or failure,
cancel queued work, and retry entries. Products validate their input and retain
their queue payloads. Shared history keeps the last 20 http(s) addresses over
injected storage, stays local, and treats malformed saved data as an empty list.

The desktop uses actual Tauri IPC to start and control owned native tasks and
open or reveal saved output. UI progress uses the same generated domain values.
The CLI awaits the native invocation directly.

Draft inputs, expanded details, preview choices, and settings forms belong to
the UI. Selection, retry budgets, and partial-output policy belong to Rust.
See [Architecture](architecture.md) and [Acceptance matrix](acceptance-matrix.md).
