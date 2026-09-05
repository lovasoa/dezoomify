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

Hosts may preserve host-specific error source chains internally, but only the typed shape crosses the protocol. Map errors to the typed model once at each boundary; never branch on display strings.

## Recovery actions

Recovery is typed data, not text that the UI must interpret. Actions include:

- `retry_now` and `retry_after`;
- `edit_source` or `provide_headers`;
- `choose_image`, `choose_level`, or `choose_output`;
- `use_direct`, `use_extension`, or `open_native`;
- `grant_permission` or `confirm_credential_handoff`;
- `reduce_size` or `change_format`;
- `keep_partial`, `discard_partial`, or `cancel_job`.

Each action carries only the parameters valid for that error and current state. The job engine rejects stale or forged actions by job revision and action identifier.

On the website, a classified direct CORS or network failure automatically selects the metadata CORS proxy only for an eligible public, non-credential metadata request (never tiles) and only while proxy use is enabled. This transport transition is reported in state and shown by the app rather than exposed as a per-attempt consent action. Opting out prevents new proxy requests; changing that preference does not authorize credentials or make an ineligible resource eligible.

## User presentation

Messages are written for the person seeing them, following the layered rules in [Product](product.md#progressive-disclosure):

- Lead with what happened for this job — which step failed, which image or resource was involved, which route was attempted — and the single best next action. Specific causes never share a generic template sentence.
- The first message is jargon-free. Technical vocabulary appears only in expandable details or linked documentation.
- The error's structured context (code, class, phase, transport, resource kind, blocked reason, redacted source origin) drives the wording, so identical causes read identically across apps.
- Copy diagnostics includes the typed context, job and attempt identifiers, app and protocol versions, and the redacted source origin; never cookies, credentials, full URLs with sensitive queries, or response content.
- Every typed error has defined user wording. A code without user wording is a release defect. A genuinely unclassified internal failure may say the result is unexpected, but still names a next action and a diagnostics path.

## Failure policy

Transient transport and service errors follow the configured [retry policy](job-engine.md#retry-and-progress). Before the website exposes a classified direct CORS or network failure, it applies the eligible automatic proxy policy once; proxy-disabled, proxy-ineligible, authentication, authorization, and ordinary HTTP failures do not take that route. Remaining access failures require user action. Invalid metadata and deterministic decode failures stop affected work immediately. A tile failure reaches the configured partial policy only after retries are exhausted.

Internal errors preserve a correlation identifier for diagnostics and expose a safe fallback action. Protocol incompatibility stops before job creation. Security-policy failures never offer a recovery that weakens the policy; see [Security](security.md).
