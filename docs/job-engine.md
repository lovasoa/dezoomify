# Job engine

`crates/dezoomify-job` is the deterministic effect/state machine used by every runtime. It decides what must happen next; it never performs I/O, decodes pixels, reads time, or writes output.

## Model

A job contains immutable input intent and evolving state. Input intent includes the source, selected catalog item and level, crop, processing recipe, output destination and format, retry policy, partial-output policy, and applicable transport preference. State records the current phase, active transport, tile acquisition and processing outcomes, in-flight effect identifiers, failures, cancellation, publication, and cleanup status.

The engine accepts a command or effect result and returns:

- the next state;
- zero or more effects for the host;
- ordered protocol events for observers.

Effect identifiers make late, duplicate, and out-of-order results safe to ignore. The host supplies clock-derived retry wakeups explicitly, so replaying the same inputs produces the same state and events.

## Phases

Jobs move through discovery, selection, planning, output-destination resolution, tile acquisition, processing, encoding, finalization, publication, and cleanup. The engine issues effects for host I/O and records each outcome; hosts do not decide lifecycle policy. A job can also wait for user input, retry delay, recovery, or cancellation cleanup. Phase changes are emitted as [protocol events](protocol.md#events).

Selection is explicit when discovery returns multiple images or levels. Headless callers may provide a deterministic selection rule in the initial command; the engine never guesses silently.

## Retry and progress

Retry policy defines attempts, backoff inputs, and retryable error classes. The
engine schedules retries; the host implements the delay and request. The web
integration evaluates the first classified direct CORS or network failure as an
application-specific transport transition before ordinary same-transport retry:
an eligible public, non-credential metadata request supplies a metadata CORS
proxy effect when proxy use is enabled, and the active-transport event makes
that transition visible. Opt-out and ineligibility prohibit that effect.
Authentication failures, invalid metadata, unsupported formats, and
deterministic decode failures are not retried automatically.

Progress is structured by phase and reports completed, active, queued, failed, and total units where known. Byte counts supplement work-unit counts but do not replace them. Monotonic progress survives retries and cache hits without claiming that unknown totals are complete.

## Cancel and partial output

Cancellation is a command, not an abrupt state mutation. The engine stops issuing new work, asks the host to cancel in-flight effects and remove unpublished artifacts, and waits for cleanup acknowledgements before reaching `cancelled`.

The selected partial policy is one of:

- `fail`: no final output is published when required tiles are missing;
- `keep`: a marked partial result is encoded with missing regions;
- `prompt`: the job pauses and exposes typed choices before encoding.

Partial results list every missing tile and preserve the errors that caused each omission. The engine publishes a kept partial only after successful encoding and finalization; otherwise it directs cleanup. The policy never converts metadata, permission, destination, encoding, or publication failures into partial success.

See [Errors](errors.md) for recovery behavior and [Testing](testing.md) for deterministic state-machine scenarios.
