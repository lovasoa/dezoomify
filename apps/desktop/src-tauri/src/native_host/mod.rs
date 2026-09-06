// Native Messaging host modules: framed transport, one-use sessions,
// redacted diagnostics, wire envelopes, stateful handoff execution, and
// scoped cookie handling.
//
// Browser enforcement of the manifest allowed extension IDs authenticates the
// channel sender; this crate never authenticates anyone from a self-asserted
// ID, challenge, nonce, or payload. Challenge + one-use nonce bind one
// consent/credential exchange to one job and block replay; they are session
// binding, not signatures.

pub mod envelope;
pub mod framing;
pub mod host;
pub mod redaction;
pub mod session;
