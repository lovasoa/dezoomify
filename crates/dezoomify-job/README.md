# dezoomify-job

- **Responsibility:** Run the portable download job state machine, including
  discovery, selection, scheduling, progress, retries, cancellation, and result
  accounting through injected host capabilities.
- **Allowed dependencies:** `dezoomify-core`, `dezoomify-protocol`, and small
  platform-neutral libraries.
- **Forbidden responsibilities:** No direct HTTP, filesystem, image codec,
  browser, native runtime, CLI, or UI access and no host-specific errors.
- **Interfaces and tests:** Expose command/event-driven job control and host
  capability traits. Test deterministic state transitions, bounded retries,
  cancellation, backpressure, partial completion, and replayable event order.
- **Migration source:** Extract orchestration from
  `migration-sources/dezoomify-rs/src` and scheduling behavior from
  `migration-sources/dezoomify-web/zoommanager.js` without importing host I/O.
