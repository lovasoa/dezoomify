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
- optional redacted request, transport, blocked-reason, resource-kind, HTTP status, bounded server signal, and diagnostic detail.

Codes are durable protocol API. Messages may improve without changing behavior. Secrets, cookies, authorization headers, signed query values, and local path details are redacted before logging or serialization.

Hosts may preserve host-specific error source chains internally, but only the typed shape crosses the contract. Browser products classify a host failure once, and the shared browser runtime creates the generated `ErrorDto`. Its phase is derived from the effect being answered: metadata is `discovery`, tile/probe work is `acquisition`, and output completion is `output`. Never branch on display strings.

Adapter faults are not job failures. Invalid external objects or invalid session state return the error branch of `DispatchResult` and produce an internal contract-failure screen. They cannot replace a transport failure already accepted by the job engine.

## Recovery actions

Recovery is typed data, not text that the UI must interpret. Each action carries an identifier, one coarse kind (`retry`, `edit-input`, `choose-output`, `grant-permission`, `change-transport`, `keep-partial`, `discard-partial`, `handoff-to-native`), a scope, and a rationale. Only the parameters valid for that error and current state are present. The job engine rejects stale or forged actions by job revision and action identifier.

On the website, a classified direct CORS or network failure, or a direct fetch that does not complete within the 1500 ms metadata window, automatically selects the metadata CORS proxy only for an eligible public, non-credential metadata request (never tiles). This transport transition is reported in state and shown by the app; there is no per-attempt consent action.

## User presentation

Messages are written for the person seeing them, following the layered rules in [Product](product.md#progressive-disclosure):

- Lead with what happened for this job, naming the step that failed, the image or resource involved, and the route that was attempted, then give the single best next action. Specific causes never share a generic template sentence.
- The first message is jargon-free. Technical vocabulary appears only in expandable details or linked documentation.
- The error's structured context (code, phase, transport, resource kind, blocked reason, redacted source origin) drives the wording, so identical causes read identically across apps.
- A transport-level fetch failure is the job outcome itself: the host reports its plain message and stable code, and the engine's raw diagnostics (for discovery, the headline-free per-format bullet block) appear only in the expandable technical details (`detail`), never in the first message.
- Technical and user wording never mix. Every fetch failure carries a plain actionable sentence for the user plus a typed cause (`FetchCause`: code, HTTP status, transport kind, policy reason) for the engine. The engine groups discovery diagnostics on the typed `(kind, cause)` key and never on rendered text; user copy never enters the engine. A metadata-proxy cause names the relay code, the HTTP status, and the policy reason when the relay denied the request, so our policy denial never reads as an upstream refusal and an upstream refusal never reads as retryable policy guidance.
- Failure details stay on the user's device. The technical-details section has one shape across products: the full request URL rendered verbatim, the HTTP status when the failure is an HTTP refusal, an optional bounded server signal (at most 4 KiB read, 300 characters kept, markup-stripped, control characters stripped), the engine block, and one trailing context line (`code:… category:… retryable:… transport:… phase:…[ http:…]`). The `http` line and token are omitted entirely when there is no status. The prominent message never carries any of these, and a muted reminder in the error view asks the user to remove sign-in details and tokens before sharing. Copy diagnostics keeps the typed context, job and attempt identifiers, app and protocol versions, the request URL, and the bounded server signal; cookies and credentials never appear. Discovery diagnostics are typed: a format's URL-shape miss (`DidNotMatchUrl`, no fetch attempted) collapses to a count, fetch rejections group by their typed `(kind, cause)` key under their format names (distinct code, HTTP status, transport, or policy reason never merge), and other rejections group by `(kind, detail)`.
- Every typed error has defined user wording. A code without user wording is a release defect. A genuinely unclassified internal failure may say the result is unexpected, but still names a next action and a diagnostics path. Only transient failures invite a retry ("try again shortly"); a policy denial or an upstream 4xx refusal is non-retryable and names the next app or address fix instead.
- The error view offers a retry action only for a retryable error and only when the host can repeat the request, and that action re-runs the same request rather than falling through to a reset. Start over is offered only by products that accept a new address (the website and desktop app); the extension job tab is bound to the scanned page and never shows it.

## Failure policy

Transient transport and service errors follow the configured [retry policy](job-engine.md#retry-and-progress). Before the website exposes a classified direct CORS or network failure, or a direct fetch that does not complete within the 1500 ms metadata window, it applies the eligible automatic proxy policy once; proxy-ineligible, authentication, authorization, and ordinary HTTP failures do not take that route. Remaining access failures require user action. Invalid metadata and deterministic decode failures stop affected work immediately. A tile failure reaches the configured partial policy only after retries are exhausted.

Internal errors expose a safe fallback action. Native Messaging incompatibility stops before job creation. Security-policy failures never offer a recovery that weakens the policy; see [Security](security.md).
