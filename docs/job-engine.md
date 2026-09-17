# Job engine

`crates/dezoomify-job` is the deterministic effect/state machine used by the browser runtime through the WASM adapter and by the native runtime through `crates/dezoomify-native/src/job_driver.rs`. It decides what must happen next; it never performs I/O, decodes pixels, reads time, or writes output. Both runtimes execute its effects and feed results back; shared scenarios assert equivalent behavior across both runtimes.

## Model

A job contains immutable input intent and evolving state. State records discovery, selection, planning, tile acquisition, outstanding numeric request and decision keys, finalization, failure, and cancellation. Output destinations and codec/save progress are host-owned. Product routing tokens remain outside the job.

The engine accepts a typed `JobCommand` and appends typed `JobEffect` and
`JobEvent` values to one FIFO `JobMessage` queue. Every message has a checked
`u32` sequence. Requests, tiles, and decision generations are numeric and
scoped to the job instance, so late, duplicate, and out-of-order replies can
be rejected without parsing JSON or validating prefixed strings. The host
supplies clock-derived retry wakeups explicitly, so replaying the same inputs
produces the same state and messages.

## Phases

Jobs move through discovery, selection, planning, tile acquisition, and one awaited finalization phase. The engine exposes only phases it can observe; hosts may report codec and save progress through product-local UI events.

Selection is explicit when discovery returns multiple images or levels. Commands carry zero-based positions into the retained normalized catalog, so no catalog object or synthetic ID is copied back into Rust. Headless callers may provide a deterministic selection rule in the initial command; the engine never guesses silently.

## Retry and progress

Retry policy defines attempts, backoff inputs, and retryable error classes. The
engine schedules retries; the host implements the delay and request. The web
integration evaluates the first classified direct CORS or network failure, or a
direct fetch that does not complete within the 1500 ms metadata window, as an
application-specific transport transition before ordinary same-transport retry:
an eligible public, non-credential metadata request supplies a metadata CORS
proxy effect, and the active-transport event makes
that transition visible. Ineligibility prohibits that effect.
Authentication failures, invalid metadata, unsupported formats, and
deterministic decode failures are not retried automatically.

Progress is structured by phase and reports completed, active, queued, failed, and total units where known. Byte counts supplement work-unit counts but do not replace them. Monotonic progress survives retries and cache hits without claiming that unknown totals are complete.

## Cancel and partial output

Cancellation is a command, not an abrupt state mutation. The engine stops issuing new work and emits one idempotent `cancel-work` instruction before reaching `cancelled`.

The selected partial policy is one of:

- `fail`: no final output is published when required tiles are missing;
- `keep`: a marked partial result is encoded with missing regions;
- `prompt`: the job pauses and exposes typed choices before encoding.

Partial results list every missing tile and preserve the errors that caused each omission. The engine publishes a kept partial only after successful encoding and finalization; otherwise it directs cleanup. The policy never converts metadata, permission, destination, encoding, or publication failures into partial success.

See [Errors](errors.md) for recovery behavior and [Testing](testing.md) for deterministic state-machine scenarios.

## Pause v1 (suspend-acquisition)

Pause is an orthogonal overlay, not a new state, and `Job::is_paused` reports it. `Pause` is valid in any
non-terminal state (post-terminal inputs stay `job.post-terminal`);
duplicate pause returns `Ignored`; `Resume` without pause is
`job.invalid-state`. Cancel wins while paused.

While paused the engine stops scheduling new `acquire-tile` effects,
finishes in-flight work, retains decoded output, preserves FIFO
effect/event queues, preserves retry wakeups (deferred in `pending_tiles`
until resume), and still lets hosts own clocks. `TileOutcome{ok:true}` while
paused records progress but defers completion; retry-eligible failures queue
their retry without emitting; retry-exhausted failures still transition to
`AwaitingPartialDecision`. Probe planning and discovery continue while
paused (documented limit: only tile acquisition suspends). `Resume` clears
the overlay, emits `resumed`, and re-drives: pending tiles up to the
concurrency gate, or completion when every tile already arrived while
paused.

## Behavior table (implemented)

`dezoomify-job` is synchronous with monotonic `seq` (checked
arithmetic), one FIFO typed message queue, and exactly one terminal event.
`Terminal` = `Completed` / `PartiallyCompleted` / `Failed` / `Cancelled`.
Post-terminal inputs return stable `job.post-terminal` rejection with no work.
Duplicates return `Outcome::Ignored` with no state change.

## Host-effect contract

Effects are host-neutral and carry everything a host needs to execute them;
no host re-derives job policy or tile geometry.

- `acquire-tile` carries the request (URI, headers, purpose), the engine
  tile id, and the complete output placement: top-left position, planned
  extent when declared, the declared output canvas, and the processing
  recipe id. Native assembly and browser canvas hosts consume the same
  values. Hosts decode during acquisition (the native model), so decode
  failures surface through the tile outcome.
- `finalize-output` carries the partial marker, output format, and declared
  canvas size. The host validates its destination, assembles and encodes the
  retained tiles, saves or displays the result, and replies once with typed
  success or failure. Completion is emitted only after success.
- `cancel-work` is idempotent and tells the host to cancel work and release
  retained resources after cancellation or failure.

Discovery delegates to the core registry: the engine emits one
`acquire-resource` effect per outstanding core request and forwards host
results to the core operation, which owns candidate ordering and fallback.
Core discovery is a poll: the same request stays outstanding until its
outcome is provided, so the engine never loops on unanswered fetches.

Adaptive planning may mark a probe as `ProbeAndOutput`. Hosts retain a
successfully decoded probe with its tile placement, and the resolved plan's
`previously_output` positions let the engine count that tile as acquired
without fetching it again. Missing or unselected probes remain advisory and
never enter tile retry or partial-output recovery.

| Input | Valid source state(s) | Validation | Transition | Effects | Events |
|---|---|---|---|---|---|
| `start()` | `Created` | Config valid (`max_retries` 0..=1024, 0 is first attempt only), `http(s)`/`file://`/local-path URL (≤2048B, `file://` only local absolute), known format (`None`/`auto` or registered name, else `Err(job.unknown-dezoomer)` with no transition) | `Created` -> `Discovering` | `acquire-resource` per outstanding discovery request (real URIs, metadata purpose, header names) | `job-state:Discovering` |
| `ResourceBytes` | `Discovering` | outstanding request sequence, `bytes.len() <= max_bytes`, non-empty | Stay (core asks for more resources) or -> `AwaitingImageSelection` | further `acquire-resource` or none | `job-state`, then `catalog` (projected real catalog) |
| `ResourceBytes` late (sibling fetch after a winner finished discovery) | Any non-`Discovering` with still-pending request sequence | request sequence still pending | No transition (winning catalog survives) | none | none (`Ok(Ignored)`) |
| `ResourceBytes` over-limit/empty | `Discovering` | `bytes.len() > max_bytes` / empty | -> `Failed` | `cancel-work` | `failed:job.resource-limit` / `failed:job.empty-resource` (terminal once) |
| `FetchFailure` | `Discovering` | outstanding request sequence | Core owns fallback: stay `Discovering` (other candidates' `acquire-resource`) or -> `Failed` | `acquire-resource` or `cancel-work` | `job-state`, or `failed:job.discovery-failed` |
| `FetchFailure` late (sibling fetch after discovery finished) | Any non-`Discovering` with still-pending request sequence | request sequence still pending | No transition | none | none (`Ok(Ignored)`) |
| `SelectedImage` | `AwaitingImageSelection` | image position in range and ready (same position replays as `Ignored`) | -> `AwaitingLevelSelection` | none | `levels` (positions), `job-state` |
| `SelectedLevel` | `AwaitingLevelSelection` | level position in range for the selected image | -> `Planning` -> `AcquiringTiles` | `acquire-tile` up to the concurrency limit, or one probe | `job-state`, `progress` |
| `ProbeOutcome` | `Planning` | outstanding probe ordinal; available observations need positive width/height | One core probe step: next probe (stay `Planning`) or resolved plan -> `AcquiringTiles` | `acquire-tile` (next probe or first plan tiles) | `progress:0/total`, `job-state` |
| `TileOutcome{ok:true}` on a probe tile | `AcquiringTiles` | probe tiles are answered with `ProbeOutcome` only | No transition | none | none (`Err(job.invalid-state)`) |
| `TileOutcome{ok:true}` | `AcquiringTiles` | tile ordinal in plan | Stay or last tile -> `Finalizing` | next `acquire-tile` or one `finalize-output` | `progress`, `job-state:Finalizing` |
| `TileOutcome{ok:false}` | `AcquiringTiles` | tile ordinal in plan | attempts `<= max_retries` (0..=1024, 0 fails immediately with no refetch): stay + retry `acquire-tile`; else -> `AwaitingPartialDecision` | `acquire-tile` (retry) or `request-decision` (`partial`) | `warning` + `progress`, or `missing-work` + `job-state` |
| `RecoveryChoice{generation,Retry}` | `AwaitingPartialDecision` | outstanding generation | -> `AcquiringTiles` | `acquire-tile` | `job-state` |
| `RecoveryChoice{generation,Keep}` | `AwaitingPartialDecision` | outstanding generation | -> `Finalizing` | `finalize-output{partial:true}` | `job-state` |
| `RecoveryChoice{generation,Discard}` | `AwaitingPartialDecision` | outstanding generation | -> `Failed` | `cancel-work` | `failed:job.partial-discarded` |
| `FinalizationSucceeded` | `Finalizing` | one output pending | -> `Completed` or `PartiallyCompleted` | none | exactly one terminal event |
| `FinalizationFailed` | `Finalizing` | one output pending | -> `Failed` | `cancel-work` | typed failure |
| `Cancel` | Any non-terminal |  | -> `Cancelling` -> `Cancelled` | `cancel-work` | terminal `cancelled` |
| `Pause` | Any non-terminal |  | Overlay on (no state change) | none | `paused` (replayable; duplicate is `Ignored`) |
| `Resume` | Paused only | paused | Overlay off, re-drive pending or complete | `acquire-tile` (pending) or `finalize-output` when all arrived paused | `resumed`, then `progress`/`job-state` chain |
| `TileOutcome{ok:true}` while paused | `AcquiringTiles` + paused | `tile:*` in plan | Stay (no new scheduling, completion deferred) | none | `progress:a/total` only |
| Duplicate/stale | Same state, already-consumed request sequence or acquired tile ordinal / same selection | Correlation already settled | No transition | none | none (`Ok(Ignored)`) |
| Wrong-state / unknown correlation / post-terminal | Any | unknown numeric correlation, invalid state, resume-without-pause, or terminal set | No transition, no work | none | none (`Err(job.invalid-state | job.post-terminal)`) |
