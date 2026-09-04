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

## Phase 06 lean behavior table (implemented)

Lean `dezoomify-job` is synchronous with monotonic `seq` (checked
arithmetic), FIFO effect/event queues, and exactly one terminal event.
`Terminal` = `Completed` / `PartiallyCompleted` / `Failed` / `Cancelled`.
Post-terminal inputs return stable `job.post-terminal` rejection with no work.
Duplicates return `Outcome::Ignored` with no state change.

| Input | Valid source state(s) | Validation | Transition | Effects | Events |
|---|---|---|---|---|---|
| `start()` | `Created` | Config valid, `job:*` id, `http(s)` URL | `Created` -> `Discovering` | `acquire-resource` (`req:0`, metadata, default-header provenance) | `job-state:Discovering` |
| `ResourceBytes` | `Discovering` | `job` match, `req:*` equals outstanding, `bytes_len <= max_bytes`, not consumed | -> `AwaitingImageSelection` | — | `catalog` (`img:0`), `job-state` |
| `ResourceBytes` over-limit | `Discovering` | `bytes_len > max_bytes` | -> `CleaningUp` -> `Failed` | `release-bytes` | `job-state` chain, `failed:job.resource-limit` (terminal once) |
| `FetchFailure` | `Discovering` | `job` match, outstanding `req:*` | attempts `<= max_retries`: -> `AwaitingRecovery` (`discovery`); else -> `CleaningUp` -> `Failed` | `request-decision` (`rec:*`) or `release-bytes` | `recovery-requested` + `job-state`, or `failed:job.fetch-failed` |
| `SelectedImage` | `AwaitingImageSelection` | `job` match, `img:0` (same id replays as `Ignored`) | -> `AwaitingLevelSelection` | — | `levels` (`lvl:0`), `job-state` |
| `SelectedLevel` | `AwaitingLevelSelection` | `job` match, `lvl:0` (same id replays as `Ignored`) | -> `AwaitingDestination` | `request-destination` (`fx:*`, `png`) | `job-state` |
| `DestinationGranted` | `AwaitingDestination` | `job` match, `dst:*` | -> `Planning` -> `AcquiringTiles` (`tile:0`, `tile:1`); `2 > max_tiles`: -> `CleaningUp` -> `Failed` | `acquire-tile` up to `max_concurrent_fetches` in plan order | `job-state:Planning`, `progress:0/2`, `job-state:AcquiringTiles` or `failed:job.resource-limit` |
| `DestinationDenied` | `AwaitingDestination` | `job` match | -> `AwaitingRecovery` (`destination`) | `request-decision` | `recovery-requested`, `job-state` |
| `TileOutcome{ok:true}` | `AcquiringTiles` | `job` match, `tile:*` in plan; acquired replays as `Ignored` | Stay (emit next pending to fill concurrency) or last tile: `ProcessingTiles` -> `Encoding` -> `Finalizing` -> `Publishing` -> `CleaningUp` -> `Completed` | `acquire-tile` (next pending) or `decode-pixels` x2, `open-encoder`, `finalize-encoder`, `publish-output` (`out:0`), `release-bytes` | `progress:a/2`, then `job-state` chain + `completed` (terminal once) |
| `TileOutcome{ok:false}` | `AcquiringTiles` | `job` match, `tile:*` in plan | attempts `<= max_retries`: stay + retry `acquire-tile`; else -> `AwaitingPartialDecision` | `acquire-tile` (retry) or `request-decision` (`partial`) | `warning` + `progress`, or `missing-work` + `job-state` |
| `RetryReady` | `AwaitingRecovery` (`discovery`/`destination`/`tile`), `AwaitingPartialDecision` | `job` match, `att:*` | `discovery` -> `Discovering` (new `req:*`); `destination` -> `AwaitingDestination`; else -> `AcquiringTiles` | `acquire-resource` / `request-destination` / `acquire-tile` | `job-state` |
| `PartialKeep{keep:true}` | `AwaitingPartialDecision` | `job` match | Same pipeline as success but -> `PartiallyCompleted` | Same encode/finalize/publish/release | `job-state` chain + `partial-completed` (terminal once) |
| `PartialKeep{keep:false}` | `AwaitingPartialDecision` | `job` match | -> `CleaningUp` -> `Failed` | `release-bytes` | `job-state` chain, `failed:job.partial-discarded` |
| `Cancel` | Any non-terminal (incl. transient `Planning`/`ProcessingTiles`/`Encoding`/`Finalizing`/`Publishing`) | `job` match | -> `Cancelling` -> `CleaningUp` -> `Cancelled` | `cancel-work`, `release-bytes` | `job-state` chain + `cancelled` (terminal once; second `Cancel` is `post-terminal`) |
| Duplicate/stale | Same state, already-consumed `req:*` or acquired `tile:*` / same selection | Correlation already settled | No transition | — | — (`Ok(Ignored)`) |
| Wrong-job / wrong-state / bad id / post-terminal | Any | `job` mismatch, unknown id, invalid state, or terminal set | No transition, no work | — | — (`Err(job.wrong-job | job.invalid-state | job.invalid-id | job.post-terminal)`) |
