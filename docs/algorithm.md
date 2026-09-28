# Algorithm

`dezoomify(inputs, options, host)` is the shared async function used by website,
extension, desktop, and CLI. It awaits injected platform capabilities and returns
`Result<Output, Error>`. It awaits `host.settle()` before returning.

## Discovery

Discovery receives ordered source, observed-document, and observed-resource
inputs. It preserves requested URLs, headers, redirected bases, and branch-local
resource history. Shared resource reads deduplicate equivalent requests and
apply byte, request, navigation, and traversal budgets across inputs.

Source catalogs and format-specific references precede readable observed
documents, recognized metadata/image addresses, viewer navigation, and opaque
observations. Registry order breaks equal format matches. Within an evidence
class, input and document order determine precedence. Failed parents do not
prune child references. Navigation cycles are bounded.

Initial reads forbid interaction. A resource that needs access remains deferred
while accessible alternatives run. When automatic work is exhausted, discovery
awaits an interactive read of the same resource. Browser permission details stay
inside the Host.

## Selection and planning

Interactive choices are awaited Host calls carrying the actual catalog or image.
Automatic selection follows the supplied rule. Native selection preserves exact
zoom, largest, optional width/height caps, image-index clamping, and its fallback
ordering. Browser selection chooses a ready image and a level fitting canvas
limits; progress includes maximum and selected dimensions for the UI notice.

Deferred catalog entries resolve within the invocation with bounded follows and
cycle detection. Planning retains lazy tile generation, validated geometry,
processing recipes, and adaptive probing. Reusable successful probes count toward
the final image.

## Retry and progress

Acquisition bounds complete fetch/process/decode/place operations. A tile retains
its identity across attempts. Concurrent successes settle before partial output
is decided. A lazy plan does not allocate every tile URL in advance.

Transient failures retry within the configured budget. Default exponential
backoff starts at 1 s and caps at 30 s; an observed Retry-After is honored up to
300 s. Permanent failures, including HTTP 403, settle without retry. The shared
algorithm asks the Host to sleep and owns retry classification.

Progress reports the active work and acquired/total counts. Host output failures
remain output failures, not missing tiles.

## Pause and cancellation

Cancellation checkpoints apply to discovery and acquisition. Acquisition
checkpoints also wait for resume. Pause prevents new tile acquisitions while
in-flight work settles; discovery and probing remain available. Cancel wakes
paused work and wins over further scheduling or publication.

Hosts abort actual operations and await owned decoding and output work during
cleanup. Late browser completions cannot draw into a replacement image. Native
cancellation cannot overwrite an existing output file.

## Partial output and save

After every tile settles, missing tiles retain structured failure details.
Retry resets the budget for missing tiles only and keeps acquired tiles.
Keep saves a partial result; discard fails with the stable partial-discarded code.
A job with no usable tiles fails rather than presenting empty partial output.

The algorithm awaits `host.finish` and returns its actual output disposition:
native publication, browser save initiated, browser save ready, or display only.
Ordinary image display never claims readable pixels or a programmatic save.
