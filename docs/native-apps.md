# Native apps

The CLI and Tauri desktop application share `crates/dezoomify-native`. This runtime executes job effects with native HTTP, filesystem, cache, decoder, processor, and encoder implementations.

## Native runtime

`crates/dezoomify-native` provides:

- HTTP requests with redirects, user headers, authentication, bounded concurrency, and cancellation;
- local metadata, tile, archive, and output access;
- a persistent, content-aware tile cache with validation and eviction;
- streaming decode and processing with bounded memory;
- the complete encoder set and atomic final publication;
- disk-backed plans for images larger than available memory.

Temporary files are job-scoped. Successful output is moved into place atomically where the filesystem permits. Cancellation and failure remove uncommitted output while retaining cache entries that are safe to reuse.

Native is the authoritative runtime for huge images, local sources, bulk queues, resumable long-running work, and full output support. Capability negotiation exposes actual codec and resource limits to callers; see [Protocol](protocol.md#capabilities).

## Desktop

The Tauri application hosts the same Studio used by web and extension. Its adapter maps generated protocol commands to Tauri invocations and maps native events back to Studio. File pickers and save destinations are represented as native handles rather than browser paths.

Desktop treats website and deep-link [handoffs](protocol.md#handoff) as bounded, non-secret, untrusted input. It validates them and asks the user to confirm the source and output; these handoffs use no client-side signing. Extension handoff uses allowlisted Native Messaging: browser enforcement of allowed extension IDs authenticates the extension sender to the native host, while a fresh challenge and one-use nonce bind one session and prevent replay rather than establish identity. Cookies transfer only after separate origin-scoped consent and are not intentionally persisted.

## CLI

The CLI maps arguments to the same commands and prints the same typed events as human-readable progress or machine-readable records. Interactive selection and recovery use terminal prompts; non-interactive mode requires explicit selection and recovery policies. Bulk mode runs isolated jobs with bounded shared transport and cache resources.

Exit status reflects the final typed error class. A kept partial output remains distinguishable from complete success. See [Errors](errors.md) and [Job engine](job-engine.md).
