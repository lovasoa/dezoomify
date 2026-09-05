# Product

dezoomify-ng turns tiled, zoomable images into portable image files. A user supplies a URL, chooses a discovered image and level, reviews output constraints, and runs a job with live progress, cancellation, retry, and an explicit partial-output policy.

## Surfaces

- **Website** handles common public sources without installation. It fetches readable bytes with a direct browser fetch first (250 ms window), then automatically uses the metadata CORS proxy only after a classified CORS or network failure or a direct fetch that does not complete in that window, and only for an eligible public, non-credential metadata request; tiles are never proxied. The website shows the active transport and never prompts for per-attempt proxy consent. Unprocessed ordinary tiles may remain visible through a tainted canvas without clean programmatic save.
- **Browser extension** discovers viewers in the current page and performs browser-session requests under extension permissions.
- **The desktop app** uses the native runtime for local files, large images, durable caching, and full encoder support.
- **CLI** exposes the same native discovery and job behavior for scripts and bulk work.

The shared React UI presents the same job concepts in every app. Runtime capability negotiation changes available actions, not their meaning. See [Architecture](architecture.md) and [Protocol](protocol.md).

## Choosing an app

Users pick between the website, the extension, the desktop app, and the CLI, often under time pressure and without background knowledge. Every app must explain that choice honestly:

- Speak in user actions and outcomes ("Use the desktop app for this very large image"), never in mechanism vocabulary. User-facing copy must not use technical terms such as network policies, headers, permissions APIs, or transport names.
- State limits as facts about the app, not as faults of the site or the user. For example: "this website can show the image but cannot save a copy because the site only serves it to its own pages; the browser extension can save it with your approval for that site."
- The comparison is rendered from the same negotiated capabilities the app uses at runtime. An app must never recommend an option it cannot verify as available, and must never rule one out that it cannot verify as unavailable.
- The same guidance appears in product documentation and in every app; hosts may adjust phrasing for context but not substance.

This document speaks to implementers; user-facing copy derived from it must follow the plain-language rules above.

## Progressive disclosure

Explanations are layered so users get the minimum they need first:

1. **First message:** one specific, plain sentence describing what happened for this job and a single best next action.
2. **"What happened":** an expandable plain-language explanation of the cause and the honest alternatives, still without jargon.
3. **Technical detail:** only behind copyable diagnostics and linked documentation, for users who choose to look.

Nothing important is locked behind a tier the user cannot reach, and every failure leaves at least one next action. Structured failure context is gathered automatically at error time — error code, phase, transport, resource kind, blocked reason, redacted source origin, and capability snapshot — so messages and support reports are specific without asking users to describe technology. See [Errors](errors.md#user-presentation).

## Core workflow

1. The runtime discovers one or more image catalogs from an input.
2. The user selects an image, resolution level, crop, processing recipe, and output.
3. The job engine validates the request against runtime capabilities.
4. The runtime executes tile acquisition and processing effects while the engine records their outcomes and reports deterministic progress.
5. The engine drives encoding, finalization, publication, and cleanup effects through the selected output destination.

Discovery, selection, acquisition, processing, and saving remain distinct phases. This keeps failures and recovery choices specific; see [Job engine](job-engine.md) and [Errors](errors.md).

## App boundaries

The browser is optimized for interactive jobs that fit browser memory and save limits. Native apps own huge images, local input, bulk operation, resumable disk-backed work, and the complete output format set. The website sends neither cookies, `Authorization`, nor browser credentials on direct browser fetches or through the metadata CORS proxy. The extension is a distinct runtime: it obtains readable bytes under granted host permissions and the current browser session, processes them, and creates clean saves without the metadata CORS proxy.

dezoomify-ng does not bypass authentication or access controls. Users are responsible for permission to retrieve and reproduce source material. Credential handling follows [Security](security.md).
