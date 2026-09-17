# Architecture

dezoomify is one monorepo containing Rust crates, generated WASM bindings, the shared UI, browser-extension packaging, and native applications. Dependencies point inward toward pure domain libraries; hosts own all effects.

## Components

### `crates/dezoomify-core`

A pure Rust library that converts supplied resource bytes and URLs into discovery results, normalized image catalogs, positional tile plans, and processing recipes. It describes required resources but never fetches them. Its library code performs no network, filesystem, async runtime, image decoding/encoding, UI, DOM, clock, random source, process, or environment access. Pure parsing, URL manipulation, deterministic crypto, serialization, and data-structure libraries plus the `log` facade are permitted. Tests may invoke tooling without making it a normal dependency. Each format registers a static name with a user-visible display name in one ordered registry; registry order defines automatic precedence. Catalog and level order is frozen before publication, selection uses array positions, and tiles carry only a selected-level ordinal.

### `crates/dezoomify-job`

A pure, host-neutral Rust effect/state machine. It owns discovery, selection, planning, acquisition, recovery choices, and the phase-gated finalization result. The host owns destinations, codecs, saving, and display-only status behind one awaited `FinalizeOutput` effect. Hosts feed typed commands into the machine and consume its ordered effects and events. The engine owns no routing identifier; browser and desktop integrations retain their opaque job tokens outside it. The browser runtime drives it through the WASM adapter; the native runtime drives it directly through its job driver. See [Job engine](job-engine.md).

### `crates/dezoomify-protocol`

The Rust source of truth for job/WASM values, errors, processing recipes, output formats, probe outcomes, and Native Messaging requests. `Tsify` and `wasm-bindgen` generate `packages/wasm-bindings`; TypeScript products import that package. See [Cross-language contracts](protocol.md).

### `crates/dezoomify-native`

The native effect implementation: HTTP transport, local-file access, image decoding, processing execution, and the PNG output encoder. The tile-cache helpers stay unwired (storage `none`); canvas assembly is bounded by the memory currently available to the process. Both the CLI and Tauri desktop application use it. See [Native apps](native-apps.md).

### `crates/dezoomify-wasm`

The generated typed WASM ABI for core, job, and pure processing code. A session accepts generated command objects and returns generated result objects for every transition. It does not own fetching, workers, decoding, browser canvases, storage, or output saves. See [Browser runtime](browser-runtime.md).

### `packages/shared-ui`

One host-neutral React view renders discovery, selection, job progress,
recovery, and output through typed `.tsx` components. Hosts mount it with
`renderView(container, state, callbacks, ctx)`; their effect layers (web
worker, Vite bundling, Tauri commands, extension messaging) stay in the
product packages. The TypeScript/TSX sources are the single source of truth
and are bundled directly by Vite/WXT; there are no hand-maintained `.js`
mirrors. The shared UI depends on generated TypeScript protocol types, not
host-specific implementation details.

### `packages/browser-runtime`

The browser host owns workers, readable-byte fetching, request activity,
active-transport reporting, image decode, tile painting, canvas and save
surfaces, and an optional bounded browser cache. The website and the
extension job tab both run their jobs through the shared engine host
(`engine-host.ts`) over `crates/dezoomify-wasm`, injecting only their own
transport and output surface. The host owns canvas execution and host limits,
never job policy (retries, cancellation, partial output, and ordering stay in
the engine). Hosts supply transport eligibility and fallback
policy: the web integration tries a direct browser fetch first, with browser
credentials omitted, and may automatically use the metadata CORS proxy only
after a classified CORS or network failure, or a direct fetch that does not
complete within the 1500 ms metadata window, for an eligible public,
non-credential metadata request (never tiles). The active transport is retained
in the job's technical details and copied diagnostics. No cookies,
`Authorization`, browser credentials, or user-supplied credential headers are
sent to or by the proxy. The extension never uses the metadata CORS proxy;
extension-to-native cookie handoff is separately consent-gated. The extension
transport is tab-origin direct fetch followed by `<img>` tainted
display-only, with the active transport always visible. It connects
`packages/shared-ui` to
`crates/dezoomify-wasm` on the website and in the extension.
The website compatibility module `src/webIntegration.ts` is a re-export-only
shim; browser integration policy lives in
`packages/browser-runtime/src/web-integration.ts`. Transport display labels
live only in `packages/browser-runtime/src/transport-labels.ts`.

### Metadata CORS proxy

The metadata relay is one pure module, `src/server/proxy.ts`
(`handleProxyRequest`), with three thin host adapters around it:
`functions/api/proxy.ts` (Cloudflare Pages Function),
`src/server/proxy-node.ts` (Node HTTP, used by the local dev server), and the
`node:test` seam in `test/proxy-*.test.mjs`. Each adapter translates its host
transport to the same relay call, so the SSRF, credential, redirect, size,
content-type, and CORS policy is identical in tests, local development, and
production. The dev server (`scripts/dev-server.mjs`) serves the assembled
`dist/` tree and routes `/api/proxy` to the Node adapter.

### Support workspaces

`packages/wasm-bindings` contains the tracked declaration emitted by the real WASM build. `crates/fixture-server` serves controlled origins, `testdata/scenarios` contains shared declarative scenarios, and `crates/xtask` owns repository generation and validation tasks.

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

IIIF levels use the same pure adaptive-planning boundary as other probed
formats: core describes an ordinary first-tile observation and any
standards-advertised fallback, while hosts fetch and decode it. If probing
cannot refine the plan, core returns the manifest-declared grid unchanged.

## Boundary rules

- Core and job logic remain deterministic and testable without I/O.
- URLs, headers, credentials, bytes, and output destinations cross boundaries only through typed values. Rust contract types are never redeclared by browser boundary modules.
- Closed generated unions are consumed through exhaustive typed handler tables. Correlated Rust state supplies context such as error phase and request identity rather than accepting it again from a host.
- Runtime differences appear as negotiated [capabilities](protocol.md#capabilities), and automatic fallback is exposed through active-transport state rather than hidden.
- Errors cross host boundaries as stable protocol errors with typed [recovery actions](errors.md).
- Shared scenarios cover the native runtime and CLI (`native/cli-dzi`, `native/cli-tile-failure`); see [Testing](testing.md).
