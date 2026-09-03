# Errors and recovery

All runtimes expose the same typed error model. An error identifies what failed without coupling callers to a Rust, JavaScript, browser, HTTP, or operating-system exception.

## Error shape

Each error includes:

- a stable namespaced code such as `fetch.cors_blocked` or `decode.unsupported`;
- a class such as input, access, transport, discovery, decode, resource, output, cancelled, internal, or protocol;
- the job phase and affected resource or tile when safe;
- the attempted and active transport when relevant and safe;
- whether retry is valid and any host-provided delay;
- a concise user message and optional redacted diagnostics;
- an ordered set of permitted recovery actions.

Codes are durable protocol API. Messages may improve without changing behavior. Secrets, cookies, authorization headers, signed query values, and local path details are redacted before logging or serialization.

## Recovery actions

Recovery is typed data, not text that Studio must interpret. Actions include:

- `retry_now` and `retry_after`;
- `edit_source` or `provide_headers`;
- `choose_image`, `choose_level`, or `choose_output`;
- `use_direct`, `use_extension`, or `open_native`;
- `grant_permission` or `confirm_credential_handoff`;
- `reduce_size` or `change_format`;
- `keep_partial`, `discard_partial`, or `cancel_job`.

Each action carries only the parameters valid for that error and current state. The job engine rejects stale or forged actions by job revision and action identifier.

On Web Studio, a classified direct CORS or network failure automatically selects the restricted proxy only for an eligible public, non-credential resource and only while proxy use is enabled. This transport transition is reported in state and shown by Studio rather than exposed as a per-attempt consent action. Opting out prevents new proxy requests; changing that preference does not authorize credentials or make an ineligible resource eligible.

## Failure policy

Transient transport and service errors follow the configured [retry policy](job-engine.md#retry-and-progress). Before Web Studio exposes a classified direct CORS or network failure, it applies the eligible automatic proxy policy once; proxy-disabled, proxy-ineligible, authentication, authorization, and ordinary HTTP failures do not take that route. Remaining access failures require user action. Invalid metadata and deterministic decode failures stop affected work immediately. A tile failure reaches the configured partial policy only after retries are exhausted.

Internal errors preserve a correlation identifier for diagnostics and expose a safe fallback action. Protocol incompatibility stops before job creation. Security-policy failures never offer a recovery that weakens the policy; see [Security](security.md).
