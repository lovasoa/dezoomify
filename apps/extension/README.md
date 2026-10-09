# Browser extension

Use: [browser extension guide](../../docs/user/browser-extension.md).
Development: `cargo xtask dev extension --browser chromium`.
Tests: `cargo xtask test extension` builds current WASM and both WXT packages,
then runs units and packaged Chromium/Firefox browsers. Package-local `pnpm test`
and `pnpm test:unit` run units only.

## Ownership and permissions

The toolbar click opens or focuses a dedicated job tab. That tab owns scanning,
the Rust invocation, permission prompts, cancellation, and saving. The background
only launches/focuses tabs and remembers source/job associations; a background
restart must not stop an existing job.

One source-access object belongs to one source document. Scan once per attempt;
navigation invalidates access, and late replies must not revive it. Already
discovered input can continue through extension-origin fetching, but never
silently rebind to the new page. The extension supplies observed documents and
resources; Rust owns format recognition and discovery order.

Source-origin fetches can use the page's session. Cross-origin access uses
credential-free extension fetches under explicitly granted host permissions.
Request permissions synchronously from a visible action to preserve user
activation. HTTP refusals must not open permission prompts. Keep injected
operations finite, cancellable, and validated at the job-page boundary.

## Saving and packaging

A clean result finishes only when the browser download manager confirms saving.
Keep its Blob URL alive until a terminal event or cancellation settles. A tainted
canvas is display-only. Open/reveal actions use the confirmed download identity.

[`wxt.config.ts`](wxt.config.ts) owns Chromium/Firefox manifests. Declare only
permissions shipped code uses; ship no permanent host access or content scripts.
Use root workspace dependencies and the pinned Firefox driver installed by setup.
Store publication uses immutable release artifacts; see
[Operations](../../docs/operations.md).
