# Architecture

All products call `dezoomify(inputs, options, host)`, one asynchronous Rust
function. The core discovers images, chooses a level, downloads tiles, handles
partial output, and awaits saving and cleanup. Hosts supply platform operations;
they do not duplicate discovery, selection, or retry policy. See
[Algorithm](algorithm.md) for that policy.

## Boundaries

- `crates/dezoomify` owns domain values, pure parsers and geometry, and the
  algorithm. It has no network, filesystem, clock, UI, or codec implementation.
- `crates/dezoomify-native` supplies HTTP, files, codecs, cache, and publication
  for CLI and desktop. [Native apps](native-apps.md) explains resource ownership.
- `crates/dezoomify-wasm` converts values and futures without platform I/O.
- `packages/browser-runtime` supplies BrowserHost and composes the website and
  extension application. Transport and image modules receive callbacks rather
  than importing UI. See [Browser runtime](browser-runtime.md).
- `packages/shared-ui` owns React presentation and translations, without host
  globals. Products inject storage, actions, and platform capabilities.
- Products never import each other; Biome enforces package boundaries.

The website serves the legacy product at `/` and the new app at `/beta`.
Cloudflare and the local server adapt the same metadata proxy implementation in
`src/server/proxy.ts`; do not create a separate local policy. See
[Operations](operations.md#website-deployment-contract).

## Parsing and bindings

Formats declare CSS routes; discovery queries `Host::parse_html` once per shared
resource read. BrowserHost uses a detached document and NativeHost uses `scraper`,
outside the WASM dependency graph. Neither executes scripts or fetches resources.

`crates/dezoomify/src/model.rs` defines cross-language values; `host.rs` defines
the capability list shared by the Rust trait and WASM imports. Import generated
declarations from `packages/wasm-bindings`, never redeclare or hand-edit them.
After changing the boundary, run `cargo xtask bindings generate`.

Host calls use ordinary futures and promises. Metadata and processing bytes cross
as `Uint8Array`; rejected calls preserve structured domain errors. Invalid JS
values become `binding.invalid-value`, and invalid invocations still await Host
settlement. Branch on error `kind` and structured facts, never display text.

## Job ownership

One browser invocation owns cancellation, pause, pending choices, diagnostics,
and cleanup. Replacing it waits for retirement before starting new work; async
completions check ownership before changing the view, history, or output.
Desktop uses native task ownership across Tauri IPC; CLI awaits NativeHost
directly. Published files survive retirement.

## Diagnostics

Reports are local and bounded. Preserve exact URLs, settings, and error causes;
aggregate successful tile traffic rather than filling the timeline. Sharing is a
user action; credential precautions are in
[Security](security.md#credentials).
