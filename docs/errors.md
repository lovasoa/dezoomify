# Errors and recovery

Every runtime reports failures the same way: a typed error naming what failed, never a raw Rust, JavaScript, browser, HTTP, or OS exception.

## Error shape

The error type is one closed enum declared once in [`model.rs`](../crates/dezoomify/src/model.rs) and projected to TypeScript. Its named-field variants are grouped by domain: transport and fetch, discovery, job and planning, tiles, output, control, internals, plus one composition variant.

- `kind`, the kebab-case variant name (`http-error`, `no-image-found`, `limit-exceeded`, ...), is the single stable machine identifier: the serde tag, `Error::kind()` in Rust, `error.kind` in TypeScript. No other error code exists anywhere in the contract, and callers never branch on display strings.
- Display messages are plain sentences rendered by `#[error(...)]` templates from structured fields only. No message text is stored, so identical causes read identically everywhere and prose can never be parsed.
- Structured facts per failure: HTTP status, `retry-after` hint, bounded server preview, the policy reason for policy denials, the attempted transport on fetch failures, and structured limit facts (limit reason, dimensions, required and available bytes) for output-limit refusals.
- Every variant carries one flattened `Failure` context instead of per-variant fields: `request` preserves the exact URI when known and `detail` holds bounded diagnostic text, usually the preserved cause chain. The context serializes inline, so the wire shape is flat.
- `resource` composes request context (exact URI and resource kind) over any underlying failure, and `discovery-failed` retains a representative cause; both keep their underlying error through `#[source]`, so the real chain stays reachable (`Error::cause()` in Rust, the `source`/`cause` fields in TypeScript).

The retry verdict is derived, never stored. `Error::retryable` and `Error::retry_after_ms` are pure functions of the variant and its facts: HTTP 408/425/429/5xx and transient transport/service failures retry, everything else fails closed so novel failures never burn the retry budget. Aggregates (`no-usable-tiles`, `partial-discarded`) derive from their retained failure sets: any transient constituent keeps retry available, and retention is a bounded sample that keeps a transient constituent and the largest hint, so the derived verdicts stay exact over the complete set. `resource` and the discovery aggregate delegate to their cause. The policy exists once in Rust and is exposed at each host boundary (`isRetryable`/`is_retryable`); the shared UI reads the boundary-stamped `retryable` hint as plain data and holds no copy. Missing tiles retain the complete errors from every failed attempt, and output failures do not inherit fetch retry policy.

Hosts keep their own error chains internally; only the typed shape crosses the contract. Both sides raise the same shapes: browser hosts throw plain objects matching variant shapes and the boundary round-trips them through serde. Host operations attach the URI and kind from their `ResourceRequest` exactly once; the algorithm preserves this context when reporting failed discovery and missing tiles. Output failures are their own variants and never read as acquisition failures.

Extension HTTP responses are classified once at the fetch boundary into the same enum, and source-script results carry that payload unchanged through validation and transport choice. HTTP status and request context remain intact; only unclassified host exceptions require classification. The metadata CORS proxy's relay protocol keeps its own response codes, mapped once in `classifyProxyFailure`; a proxy policy denial stays a `policy-denied` and never reads as an upstream refusal.

## Recovery actions

Products choose recovery controls from the typed `kind`, the structured context, and available capabilities. They never parse user-facing text. The algorithm awaits the Host's keep, discard, or retry choice when tiles remain missing, and pending interactions belong to one invocation and close when it retires.

- Transient transport failures retry the same request; address or input failures invite editing the input; output or destination failures invite choosing output.
- Missing host grants lead to the grant action; no readable browser route leads to a transport change.
- Tiles missing after retries enter the partial policy: keep the partial sibling, discard the partial, or a user keep/discard/retry choice.

The website transport transition is automatic for eligible metadata (no per-attempt consent action); see [Browser runtime](browser-runtime.md#request-order).

## User presentation

Messages follow the presentation rules in [Product](product.md#progressive-disclosure):

- A fetch failure is the job outcome: plain message plus the stable `kind` up front; discovery diagnostics (for discovery, the headline-free per-format bullets) only inside expandable details.
- User and technical wording never mix. Fetch failures preserve kind, HTTP status, transport, policy reason, and diagnostic detail in the generated domain types. Product wording is a plain sentence derived from those facts by the shared display dispatch (`plainMessageFor`), which is exhaustive over the union: a new variant must choose its wording before it compiles. Discovery diagnostics group by kind, HTTP status, transport, and policy reason, never by rendered text. A proxy denial retains its policy reason and transport, so policy denials never read as upstream refusals and vice versa.
- Details stay on the device in the diagnostic report: full request URL, observed HTTP status, bounded server signal, and discovery failure context. Format URL-shape misses (`DidNotMatchUrl`, nothing fetched) collapse to a count; fetch rejections group by their structured facts under format names; other rejections group by `(kind, detail)`.
- Every variant has user wording; a variant without wording cannot compile past the display dispatch. Only transient failures invite retry; policy denials and upstream 4xx name the next app or address fix instead. Retry re-runs the same request, never a reset. Start over exists only where a new address is accepted (website, desktop); the extension job tab stays bound to the scanned page.

## Failure policy

Transient transport and service errors follow the [retry policy](algorithm.md#retry-and-progress). Proxy-ineligible, auth, and ordinary HTTP failures never take the proxy route. Invalid metadata and deterministic decode failures stop at once. A tile failure reaches partial handling only after retries run out. Browser canvas output failures (allocation, 2D context, PNG encoding) stop the job typed at once, never as one tile's failure, and their report always carries the desktop-app action.

Internal errors offer a safe fallback. Security-policy failures never offer a recovery that weakens the policy; see [Security](security.md).

## Diagnostic reports

Each product attempt owns a versioned `DiagnosticReport`, independent of console verbosity. It includes input, settings, build context, selected geometry, counters, bounded events, grouped first/last failures, and a protected terminal outcome. Successful tile requests count without filling the timeline; debug retains discovery, trace prints individual successful requests when explicitly enabled. The pure core performs no ambient logging.

Reports cap the timeline at 1,000 records and the entire serialized report at 1 MiB, including context, failure samples, and outcome. Strings and field counts are bounded before retention; omitted records and truncated fields are counted. Graphical products retain at most ten retired reports in memory, capped at 10 MiB, and expose the current report after success, cancellation, and failure. Clipboard rejection never claims success. Issue drafts respect an encoded URL limit; the complete report remains available to copy or save.

Native callers keep the recorder even when validation or execution fails. Desktop reads it through `get_job_diagnostics`; the CLI uses its existing `--logging` levels to filter diagnostic events on stderr, independently of `--json` stdout. Human progress prints on phase changes and at most once per second within a phase.
