# Architecture

All four products call `dezoomify(inputs, options, host)`, one asynchronous Rust
algorithm. Rust discovers images, selects a resolution, plans and acquires tiles,
handles retries, then awaits saving and cleanup. Hosts supply
platform operations. This keeps download behavior consistent across products
without making the core depend on a browser or operating system.

## Boundaries

| Layer | Responsibility |
|---|---|
| [`crates/dezoomify`](../crates/dezoomify/) | Domain types, pure format parsers and geometry, shared algorithm |
| [`crates/dezoomify-native`](../crates/dezoomify-native/README.md) | Network, files, codecs, cache, and publication for CLI and desktop |
| [`crates/dezoomify-wasm`](../crates/dezoomify-wasm/README.md) | Rust/JavaScript bridge, without platform I/O |
| [`packages/browser-runtime`](../packages/browser-runtime/README.md) | Browser Host and application composition shared by website and extension |
| [`packages/shared-ui`](../packages/shared-ui/README.md) | Host-neutral React presentation and translations |
| `src/` and `apps/` | Website, extension, desktop, and CLI integration |

Products never import each other. Shared UI receives actions and capabilities
rather than accessing host globals. Browser transport and image modules receive
callbacks rather than importing UI. Parsers consume supplied data; Hosts own
networking and inert HTML parsing, clocks, codecs, and resources.

The website serves the new app at `/`, the preserved legacy app at `/legacy/`,
and redirects `/beta` links to the new app.
The local and deployed website proxies share one implementation. See
[Operations](operations.md#website-deployment-contract) for deployment.

## Algorithm ownership

For shared tiled-image discovery, inputs can describe a source, an observed
document, or an observed resource.
The core interprets this evidence, orders discovery, and bounds traversal; an
extension scan supplies evidence rather than recognizing formats itself.
Declared source catalogs and recognized metadata resources precede reconstructed
viewer snapshots, so a loaded canvas does not hide the rest of its manifest.
The `viewer` format uses the page's tile loader; `generic` remains URL-template discovery.
Discovery explores accessible alternatives before requesting interactive access.
The Host owns the actual permission prompt. It can supply additional observations
while discovery is running; each batch shares the existing job's cache and limits.

Hosts choose images and resolutions from the catalogs supplied by Rust.
The core owns deferred resolution, retry classification, scheduling, retry budgets,
and backoff. Hosts make individual acquisition attempts and report structured
failures; they must not add a second retry policy. The extension's
[live viewer adapters](../apps/extension/src/job/viewers/session.ts) reuse
page loaders, retaining their built-in retries. Cancellation stops waiting
without clearing the viewer's queue or cache. Rust validates the observed finite
grids and plans tile placement through its existing grid geometry. Tile sources
distinguish resource requests from calls through job-owned viewer handles; viewer
calls never enter URL transports or ordinary-image fallback. GUI Hosts await Retry or Cancel
inside optional acquisitions, pausing new work while in-flight operations settle.
Retry approval retains successful tiles. Every required tile must succeed before
finalization; permanent tile and output failures stop the job. Exact policies
live in [acquisition](../crates/dezoomify/src/acquisition.rs) and its
[per-origin scheduler](../crates/dezoomify/src/pacing.rs).

## Bindings and errors

[`model.rs`](../crates/dezoomify/src/model.rs) defines cross-language values;
[`host.rs`](../crates/dezoomify/src/host.rs) defines Host capabilities. Import
generated declarations from `packages/wasm-bindings`, never redeclare or edit
them manually. After boundary changes, run `cargo xtask bindings generate`.

Host calls use futures and promises. The bridge converts values and preserves
structured errors without adding application policy. Branch on `kind` and
structured facts, never display text. Preserve request context and underlying
causes so failures remain actionable across language boundaries.

## Job ownership

Each invocation owns cancellation, pause, pending choices, diagnostics, and
temporary resources. Replacing a browser job updates presentation immediately
but waits for the previous invocation to retire before starting work. Asynchronous
completions must check ownership before changing the view, history, or output.
Cancellation closes pending choices and aborts I/O; settlement still waits for
owned decode and encoding work. Otherwise late work could damage a replacement
image or publish a cancelled output.

Desktop owns native tasks across Tauri IPC; CLI awaits NativeHost directly.
Native publication protects existing destinations and keeps committed output
after retirement. Shared tile acquisition and retries belong to Rust; product
features can stay in their product when that makes the design simpler.

## Diagnostics

Reports are local and bounded. Preserve exact URLs, settings, and error causes;
aggregate successful tile traffic so failures remain visible. Reports survive
cancellation while their result is shown. Sharing is a user action, and reports
can contain sensitive addresses; see [Security](security.md#credentials).
