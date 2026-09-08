# Extension source and job-tab contract

The extension has one background coordinator, a source-tab script, and one
dedicated extension job tab per job. The coordinator owns the bindings between
them. Webpage `postMessage` is not a job-control channel.

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

The source-tab script begins only after a toolbar action. It offers the
document URL, supported embedded metadata, accessible-frame inputs, retained
resource-timing URLs, and subsequent performance-observer URLs. It keeps a
bounded pending queue and bounded recent deduplication set. Candidate chunks
are acknowledged before more are sent; processed entries are drained. Overflow
is visible diagnostics, not permanent rejection of later candidates.

Candidates use `CandidateChunkDto` and never include response bytes. Source
requests use `SourceFetchRequestDto`; responses use `ByteChunkDto` and
`ChunkAcknowledgementDto` with bounded out-of-band buffers. Cancellation aborts
the source fetch before more chunks are retained.

## Internal extension envelopes

The current extension uses these host-internal envelope names while generated
protocol bindings are consumed by the entrypoints: `dz.source.ready`,
`dz.source.candidates`, `dz.source.candidates-ack`, `dz.source.fetch`,
`dz.source.fetch-chunk`, `dz.source.fetch-complete`, `dz.source.invalidated`,
`dz.source.stop`, `dz.job.ready`, `dz.job.binding`, `dz.job.candidates`,
`dz.job.fetch`, `dz.job.cancel`, `dz.job.permission-required`, and
`dz.job.closed`. All are runtime messages; no webpage frame receives them.

## Transport outcomes

`ExtensionTransportOutcome` categorizes source-document loss, access required,
redirect-policy limitations, cancellation, network and throttling failures,
malformed responses, streaming limits, and native/channel disconnection.
`access-required` pauses the job with host names and rationale; only a visible
job-tab action can invoke the browser permission prompt. Automatic redirects
are not retrospectively accepted as validated.
