# Errors and recovery

All runtimes expose the same typed error model. An error identifies what failed without coupling callers to a Rust, JavaScript, browser, HTTP, or operating-system exception.

## Error shape

Each error includes:

- a stable namespaced code such as `fetch.cors_blocked` or `decode.unsupported`;
- the job phase and affected resource or tile when safe;
- the attempted and active transport when relevant and safe;
- whether retry is valid;
- a concise user message;
- an ordered set of permitted recovery actions;
- optional redacted request, transport, blocked-reason, and resource-kind context.

Codes are durable protocol API. Messages may improve without changing behavior. Secrets, cookies, authorization headers, signed query values, and local path details are redacted before logging or serialization.

Hosts may preserve host-specific error source chains internally, but only the typed shape crosses the protocol. Map errors to the typed model once at each boundary; never branch on display strings.

## Recovery actions

Recovery is typed data, not text that the UI must interpret. Each action carries an identifier, one coarse kind (`retry`, `edit-input`, `choose-output`, `grant-permission`, `change-transport`, `keep-partial`, `discard-partial`, `handoff-to-native`), a scope, and a rationale. Only the parameters valid for that error and current state are present. The job engine rejects stale or forged actions by job revision and action identifier.

On the website, a classified direct CORS or network failure, or a direct fetch that does not complete within the 1500 ms metadata window, automatically selects the metadata CORS proxy only for an eligible public, non-credential metadata request (never tiles). This transport transition is reported in state and shown by the app; there is no per-attempt consent action.

## User presentation

Messages are written for the person seeing them, following the layered rules in [Product](product.md#progressive-disclosure):

- Lead with what happened for this job, naming the step that failed, the image or resource involved, and the route that was attempted, then give the single best next action. Specific causes never share a generic template sentence.
- The first message is jargon-free. Technical vocabulary appears only in expandable details or linked documentation.
- The error's structured context (code, phase, transport, resource kind, blocked reason, redacted source origin) drives the wording, so identical causes read identically across apps.
- A transport-level fetch failure is the job outcome itself: the host reports its plain message and stable code, and the engine's raw diagnostics (for discovery, the per-format breakdown) appear only in the expandable technical details (`detail`), never in the first message.
- Technical and user wording never mix. Every failure carries two layers: a plain actionable sentence for the user, and a dense technical chain (transport, HTTP status, proxy or classifier outcome, full request URL, and a bounded single-line server signal) for engine diagnostics, logs, and bug reports. Hosts feed the technical chain into engine per-candidate diagnostics; user copy never enters them. A metadata-proxy technical chain names the relay code, the HTTP status, and the policy reason when the relay denied the request, so our policy denial never reads as an upstream refusal and an upstream refusal never reads as retryable policy guidance.
- Failure details stay on the user's device. They may name the full request URL and quote a bounded, markup-stripped server signal (at most 4 KiB read, 300 characters kept, ASCII punctuation only, control characters stripped). The prominent message never carries them, and a muted reminder in the error view asks the user to remove sign-in details and tokens before sharing. Copy diagnostics keeps the typed context, job and attempt identifiers, app and protocol versions, the request URL, and the bounded server signal; cookies and credentials never appear. Discovery diagnostics are typed: a format's URL-shape miss (`DidNotMatchUrl`, no fetch attempted) collapses to a count, while other rejections group by identical message under their format names, and a fetch failure (`FetchFailed`) names the request URL, HTTP status, and server signal.
- Every typed error has defined user wording. A code without user wording is a release defect. A genuinely unclassified internal failure may say the result is unexpected, but still names a next action and a diagnostics path. Only transient failures invite a retry ("try again shortly"); a policy denial or an upstream 4xx refusal is non-retryable and names the next app or address fix instead.

## Failure policy

Transient transport and service errors follow the configured [retry policy](job-engine.md#retry-and-progress). Before the website exposes a classified direct CORS or network failure, or a direct fetch that does not complete within the 1500 ms metadata window, it applies the eligible automatic proxy policy once; proxy-ineligible, authentication, authorization, and ordinary HTTP failures do not take that route. Remaining access failures require user action. Invalid metadata and deterministic decode failures stop affected work immediately. A tile failure reaches the configured partial policy only after retries are exhausted.

Internal errors expose a safe fallback action. Protocol incompatibility stops before job creation. Security-policy failures never offer a recovery that weakens the policy; see [Security](security.md).
