# Architecture

dezoomify-ng is one monorepo containing Rust crates, generated protocol bindings, the shared UI, browser-extension packaging, and native applications. Dependencies point inward toward pure domain libraries; hosts own all effects.

## Components

### `crates/dezoomify-core`

A pure Rust library that converts supplied resource bytes and URLs into discovery results, image catalogs, tile plans, and processing recipes. It describes required resources but never fetches them. Its library code performs no network, filesystem, async runtime, image decoding/encoding, UI, DOM, clock, random source, process, or environment access. Pure parsing, URL manipulation, deterministic crypto, serialization, and data-structure libraries plus the `log` facade are permitted. Tests may invoke tooling without making it a normal dependency. Each format registers a stable id with a user-visible display name in one ordered registry; registry order defines automatic precedence.

### `crates/dezoomify-job`

A pure, host-neutral Rust effect/state machine. It owns the job through output-destination selection, tile acquisition and processing outcomes, encoding, finalization, partial publication, and cleanup. Hosts feed results back into the machine and execute its I/O effects. See [Job engine](job-engine.md).

### `crates/dezoomify-protocol`

The Rust source of truth for commands, events, capabilities, errors, and browser-to-native handoff. It generates the schema and `packages/protocol-ts`; all forms carry protocol-version information. See [Protocol](protocol.md).

### `crates/dezoomify-native`

The native effect implementation: HTTP transport, local-file access, persistent tile cache, image decoding, processing execution, and output encoders. Both the CLI and Tauri desktop application use it. See [Native apps](native-apps.md).

### `crates/dezoomify-wasm`

The WASM adapter for core, job, and pure processing code. It does not own fetching, workers, decoding, browser canvases, storage, or downloads. See [Browser runtime](browser-runtime.md).

### `packages/shared-ui`

One React/Vite application renders discovery, selection, job progress, recovery, and output. Thin integrations connect it to the web worker, Tauri commands, or extension messaging. The shared UI depends on generated TypeScript protocol types, not host-specific implementation details.

### `packages/browser-runtime`

The browser host owns workers, readable-byte fetching, active-transport
reporting, image decode, canvas and save surfaces, and an optional bounded
browser cache. Hosts supply transport eligibility and fallback
policy: the web integration tries a direct browser fetch first, with browser
credentials omitted, and may automatically use the metadata CORS proxy only
after a classified CORS or network failure for an eligible public,
non-credential metadata request (never tiles) when the user
has not opted out. The active transport is always visible. No cookies,
`Authorization`, browser credentials, or user-supplied credential headers are
sent to or by the proxy. The extension never uses the metadata CORS proxy;
extension-to-native cookie handoff is separately consent-gated. It connects
`packages/shared-ui` to
`crates/dezoomify-wasm` on the website and in the extension.

### Support workspaces

`packages/protocol-ts` contains generated TypeScript protocol bindings. `crates/fixture-server` serves controlled origins, `testdata/scenarios` contains shared declarative cases, and `crates/xtask` owns repository generation and validation tasks.

## Data flow

```text
Shared UI or CLI
    | typed command
    v
crates/dezoomify-job <--> crates/dezoomify-core
    | effects             ^ supplied bytes/results
    v                     |
packages/browser-runtime or crates/dezoomify-native
    | typed events
    v
Shared UI or CLI
```

Discovery first emits resource requests. The active host acquires each resource and returns bytes to the core. A selected catalog entry becomes a tile plan and processing recipe. The job engine schedules effects within host limits and turns their results into events.

## Boundary rules

- Core and job logic remain deterministic and testable without I/O.
- URLs, headers, credentials, bytes, and output destinations cross boundaries only through typed values.
- Runtime differences appear as negotiated [capabilities](protocol.md#capabilities), and automatic fallback is exposed through active-transport state rather than hidden.
- Errors cross host boundaries as stable protocol errors with typed [recovery actions](errors.md).
- Shared scenarios assert equivalent behavior across the native runtime, browser runtime, desktop app, extension, and CLI; see [Testing](testing.md).
