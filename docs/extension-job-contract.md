# Extension source and job-tab contract

The extension has one background coordinator, finite source operations in the
clicked tab, and one dedicated extension job tab per job. The coordinator owns
the bindings between them. Webpage `postMessage` is not a job-control channel.

## Binding and ordering

Every source-originated or job-originated request carries a `SourceBindingDto`:
`job`, browser-verified `tab_id`, browser-verified `frame_id`, and
`document_generation`. It also carries one `RequestId`. The coordinator checks
the message sender's tab and frame against the stored binding before routing
it. A navigation increments `document_generation`; messages and responses for
an earlier generation are discarded. A source-tab navigation invalidates only
source-context transport. An independent extension-origin transport may remain
available for the same job.

The coordinator stores only non-secret bindings in session storage. A worker
restart restores an existing binding when its source and job-tab owners
reconnect, but never starts another scan or reload. Source or job-tab closure
cancels the relevant in-flight work and releases the binding.

## Discovery and bytes

The source operations begin only after a toolbar action and job-tab readiness.
`collectCandidates` takes a bounded snapshot containing the document URL and
retained resource-timing URLs in one batch. A later snapshot is optional,
bounded, and deduplicated by the coordinator; there is no persistent observer
or source-tab runtime listener. Overflow is returned as diagnostics, not
silently discarded.

Candidates use `CandidateChunkDto` and never include response bytes. Source
requests use `SourceFetchRequestDto`; responses use `ByteChunkDto` and
`ChunkAcknowledgementDto` with bounded out-of-band buffers. Cancellation aborts
the source fetch before more chunks are retained.

## Internal extension envelopes

The current extension uses these host-internal envelope names while generated
protocol bindings are consumed by the entrypoints: `dz.source.fetch-chunk`,
`dz.source.fetch-complete`, `dz.job.ready`, `dz.job.binding`, `dz.job.candidates`,
`dz.job.candidates-more`,
`dz.job.fetch`, `dz.job.cancel`, `dz.job.permission-required`, and
`dz.job.closed`. All are runtime messages; no webpage frame receives them.

## Transport outcomes

`ExtensionTransportOutcome` categorizes source-document loss, access required,
redirect-policy limitations, cancellation, network and throttling failures,
malformed responses, streaming limits, and native/channel disconnection.
`access-required` pauses the job with host names and rationale; only a visible
job-tab action can invoke the browser permission prompt. Automatic redirects
are not retrospectively accepted as validated.

## Job-tab engine hosting

The job tab is a full browser host of the Rust job engine: its dedicated
worker owns one WASM `Session`, and the shared browser-runtime assembly
executor (vendored from `packages/browser-runtime`) executes the engine's
effects. The controller never grows a second state machine:

- Catalog selection is deterministic (`engine-selection.ts`): largest ready
  image, largest level that fits the browser canvas. Selection commands
  (`select-image`, `select-level`) are correlated to the job.
- `request-destination` is always granted (`dst:0`): the browser
  destination is the blob anchor save, which needs no permission.
- Tile bytes are decoded during acquisition (the native model): a tile
  that cannot decode fails its acquisition outcome and flows through the
  engine's retry and partial policy. The wasm adapter releases its arena
  copy when the outcome settles.
- `open-encoder` validates actual dimensions and area before canvas
  allocation; a plan beyond the browser limits fails typed with a desktop
  handoff and cancels the engine job (the engine does not yet await codec
  outcomes).
- `request-decision` (partial) renders an explicit keep/discard choice in
  the job tab; only the user's action sends `partial-choice`.
- Host execution failures are terminal: the failure is rendered, the
  engine job is cancelled, and later effects are never faked.
- Processing recipes beyond `none` fail typed
  (`TILE_PROCESSING_UNAVAILABLE`) rather than silently dropping the
  recipe; those sources need the native app until the engine contract
  grows processing effects.
