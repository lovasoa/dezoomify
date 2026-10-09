# Algorithm

`dezoomify(inputs, options, host)` is the shared async function used by website, extension, desktop, and CLI. It awaits injected platform capabilities and returns `Result<Output, Error>`, after awaiting `host.settle()`.

## Discovery

Discovery receives ordered source, observed-document, and observed-resource inputs. It preserves requested URLs, headers, redirected bases, and branch-local resource history. Shared resource reads deduplicate equivalent requests and apply byte, request, navigation, and traversal budgets across inputs.

Source catalogs and format-specific references precede readable observed documents, recognized metadata/image addresses, viewer navigation, and opaque observations. Registry order breaks equal format matches; within an evidence class, input and document order determine precedence. Failed parents do not prune child references, and navigation cycles are bounded.

Initial reads forbid interaction. A resource that needs access remains deferred while accessible alternatives run; when automatic work is exhausted, discovery awaits an interactive read of the same resource. Browser permission details stay inside the Host.

Accepted catalogs send their format warnings to `host.warn`, once per distinct warning in that catalog. Hosts record these as bounded `discovery-warning` diagnostics; malformed sibling entries do not prevent using a valid image.

## Selection and planning

Interactive choices are awaited Host calls carrying the actual catalog or image. Automatic selection follows the supplied rule. Native selection preserves exact zoom, largest, optional width/height caps, image-index clamping, and its fallback ordering. Browser selection chooses a ready image and level fitting canvas limits; progress includes maximum and selected dimensions for the UI notice.

Deferred catalog entries resolve within the invocation with bounded follows and cycle detection against chosen source URLs and their redirect destinations. Observed resources remain eligible when selected later. Planning retains lazy tile generation, validated geometry, processing recipes, and adaptive probing. Reusable successful probes count toward the final image and retain their final tile order for output metadata selection.

## Retry and progress

Acquisition bounds complete fetch/process/decode/place operations. A tile retains its identity across attempts, successes remain acquired across retries, and a lazy plan does not allocate every tile URL in advance.

Transient failures retry within the configured budget. Default exponential backoff starts at 1 s and caps at 30 s; an observed Retry-After is honored up to 300 s. Permanent failures, including HTTP 403, settle without retry. The shared algorithm owns retry classification and asks the Host to sleep.

Progress reports the active work and acquired/total counts. Output failures stop the job immediately.

## Pause and cancellation

Cancellation checkpoints apply to discovery and acquisition; acquisition checkpoints also wait for resume. Pause prevents new tile acquisitions while in-flight work settles, while discovery and probing remain available. Cancel wakes paused work and wins over further scheduling or publication.

Hosts abort actual operations and await owned decoding and output work during cleanup. Late browser completions cannot draw into a replacement image, and native cancellation cannot overwrite an existing output file.

## Retry approval and save

Every required tile must succeed before finalization. Permanent tile failures and exhausted noninteractive retries fail with the tile identity, attempt count, and original cause. GUI invocations allow additional attempts marked as requiring approval. The Host awaits Retry or Cancel inside acquisition, pauses new work while waiting, and lets in-flight work settle. Approval grants one further attempt at that attempt number across tiles; successful tiles are retained. Cancellation must settle the awaiting acquisition so cleanup can finish.

The algorithm awaits `host.finish` and returns its actual output disposition: native publication, browser save initiated, browser save ready, or display only. Ordinary image display never claims readable pixels or a programmatic save.
