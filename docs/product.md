# Product

dezoomify-ng turns tiled, zoomable images into portable image files. A user supplies a URL, chooses a discovered image and level, reviews output constraints, and runs a job with live progress, cancellation, retry, and an explicit partial-output policy.

## Surfaces

- **Web Studio** handles common public sources without installation. It fetches readable bytes directly first, then automatically uses the restricted Cloudflare proxy only after a classified CORS or network failure and only for an eligible public, non-credential resource. Studio shows the active transport, honors proxy opt-out, and never prompts for per-attempt proxy consent. Unprocessed ordinary tiles may remain visible through a tainted canvas without clean programmatic export.
- **Browser extension** discovers viewers in the current page and performs privileged direct requests under extension permissions.
- **Desktop Studio** uses the native runtime for local files, large images, durable caching, and full encoder support.
- **CLI** exposes the same native discovery and job behavior for scripts and bulk work.

The React/Vite Studio presents the same job concepts on every graphical surface. Runtime capability negotiation changes available actions, not their meaning. See [Architecture](architecture.md) and [Protocol](protocol.md).

## Core workflow

1. The runtime discovers one or more image catalogs from an input.
2. The user selects an image, resolution level, crop, processing recipe, and output.
3. The job engine validates the request against runtime capabilities.
4. The runtime executes tile acquisition and processing effects while the engine records their outcomes and reports deterministic progress.
5. The engine drives encoding, finalization, publication, and cleanup effects through the selected output destination.

Discovery, selection, download, processing, and export remain distinct phases. This keeps failures and recovery choices specific; see [Job engine](job-engine.md) and [Errors](errors.md).

## Product boundaries

The browser is optimized for interactive jobs that fit browser memory and export limits. Native apps own huge images, local input, bulk operation, resumable disk-backed work, and the complete output format set. Web Studio sends neither cookies, `Authorization`, nor browser credentials on direct or proxy readable fetches. The extension is a distinct runtime: it obtains readable bytes under granted host permissions and the current browser session, processes them, and creates clean exports without a hosted proxy.

dezoomify-ng does not bypass authentication or access controls. Users are responsible for permission to retrieve and reproduce source material. Credential handling follows [Security](security.md).
