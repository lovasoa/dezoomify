# Application

The shared UI renders progress, awaited choices, errors, and completed output. Its presentation functions are pure, and React components receive callbacks instead of accessing host globals. Completed views read the generated `Output` directly: its disposition determines whether saving is available or already initiated, and its completeness determines partial-output wording. Errors retain the generated diagnostic facts while presentation chooses a localized headline.

One browser application serves the website and extension. Products inject input acquisition, resource reading, explicit permission operations, saving, and optional toolbar activity. A browser invocation owns its AbortController, pause gate, pending choices, diagnostics, and concrete cleanup. Starting a replacement retires the previous invocation and waits for its resources before starting new work, while the view updates immediately. Every asynchronous completion checks ownership before changing the view, history, or output. Cancellation aborts active I/O and closes pending interactions; completion awaits cleanup. A completed preview remains available until the user retires that result. Permission operations run synchronously from the actual user click handler.

Submitting an address starts one invocation, replacing any previous invocation. Shared history keeps the last 20 http(s) addresses over injected storage, stays local, and treats malformed saved data as an empty list.

The desktop uses actual Tauri IPC to start and control owned native tasks and open or reveal saved output; UI progress uses the same generated domain values, and the CLI awaits the native invocation directly.

Draft inputs, expanded details, preview choices, and settings forms belong to the UI. Selection, retry budgets, and partial-output policy belong to Rust. See [Architecture](architecture.md) and [Acceptance matrix](acceptance-matrix.md).
