//! One-use native handoff sessions (Phase 12).
//!
//! Pure session binding for cookie handoff over Native Messaging:
//! - The browser enforces the host manifest's allowed extension IDs; that
//!   enforcement authenticates the channel sender. This module never claims
//!   to authenticate anyone from a self-asserted ID, challenge, or nonce.
//! - Challenge + one-use nonce bind ONE consent/credential message to ONE
//!   job and block replay. They are session binding, not signatures.
//! - Pure functions over injected `now_ms` + caller-supplied randomness so
//!   unit tests are deterministic. No `std::net`, no clock reads, no I/O.
//!
//! Typical flow: `negotiate_version` -> fresh `HandoffSession` ->
//! `bind_consent` (explicit UI confirmation) -> `redeem_once` (single
//! network-capable step). Any replay/expired/wrong-job reuse is rejected
//! before any network activity.

use std::collections::HashSet;

/// Current and minimum (N-1) native protocol versions.
pub const CURRENT_NATIVE_PROTOCOL: u32 = 2;
/// Minimum supported (N-1).
pub const MIN_NATIVE_PROTOCOL: u32 = 1;
/// One-use session lifetime (ms).
pub const HANDOFF_TTL_MS: u64 = 5 * 60 * 1000;
/// Maximum origins per handoff consent.
pub const MAX_ORIGINS: usize = 8;

/// Session errors. Never carries secret values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    IdNotAllowed,
    IncompatibleVersion { got: u32 },
    BadJob,
    UnknownChallenge,
    BadNonce,
    WrongJob,
    Expired,
    Replay,
    ConsentRequired,
    ConfirmationRequired,
    BadOrigins,
}

/// A pending one-use handoff session. Holds names/scopes only, never cookie
/// values (values travel in the single bounded credential message and are
/// released + best-effort overwritten after transfer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffSession {
    /// Fresh per-handoff challenge (hex).
    pub challenge: String,
    /// One-use nonce (hex).
    pub nonce: String,
    /// Job this session is bound to.
    pub job_id: String,
    /// Channel extension id (browser-enforced, informational here).
    pub extension_id: String,
    /// Negotiated protocol version.
    pub negotiated_version: u32,
    /// Creation time (caller clock, ms).
    pub created_at_ms: u64,
    /// Expiry time (min of handoff TTL / cookie deadline, ms).
    pub expires_at_ms: u64,
    /// Explicit UI confirmation recorded.
    pub consented: bool,
    /// Already redeemed (single-use).
    pub redeemed: bool,
}

impl HandoffSession {
    /// True when `now_ms` is past expiry.
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms > self.expires_at_ms
    }
}

/// Replay table: remembers spent nonces. Single-use only.
#[derive(Debug, Default)]
pub struct ReplayTable {
    used: HashSet<String>,
}

impl ReplayTable {
    /// Create an empty table.
    pub fn new() -> Self {
        Self {
            used: HashSet::new(),
        }
    }

    /// True when the nonce was already spent.
    pub fn is_used(&self, nonce: &str) -> bool {
        self.used.contains(nonce)
    }

    /// Mark a nonce spent. Returns false when it was already spent (replay).
    pub fn mark_used(&mut self, nonce: &str) -> bool {
        self.used.insert(nonce.to_string())
    }
}

/// Negotiate current/N-1 and issue session parameters.
///
/// Callers supply fresh `challenge`/`nonce` (e.g. 16 random bytes hex each),
/// `now_ms`, and whether the browser-enforced allowlist admits `extension_id`.
/// Returns the session to hold server-side until `redeem_once`.
#[allow(clippy::too_many_arguments)]
pub fn begin_session(
    extension_allowed: bool,
    client_version: u32,
    job_id: &str,
    extension_id: &str,
    challenge: &str,
    nonce: &str,
    now_ms: u64,
) -> Result<HandoffSession, SessionError> {
    if !extension_allowed {
        return Err(SessionError::IdNotAllowed);
    }
    if client_version < MIN_NATIVE_PROTOCOL || client_version > CURRENT_NATIVE_PROTOCOL {
        return Err(SessionError::IncompatibleVersion { got: client_version });
    }
    if job_id.is_empty() || job_id.len() > 128 {
        return Err(SessionError::BadJob);
    }
    if challenge.is_empty() || nonce.is_empty() {
        return Err(SessionError::BadNonce);
    }
    Ok(HandoffSession {
        challenge: challenge.to_string(),
        nonce: nonce.to_string(),
        job_id: job_id.to_string(),
        extension_id: extension_id.to_string(),
        negotiated_version: client_version.min(CURRENT_NATIVE_PROTOCOL),
        created_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(HANDOFF_TTL_MS),
        consented: false,
        redeemed: false,
    })
}

/// Record explicit UI consent on a pending session (no network).
pub fn bind_consent(
    session: &mut HandoffSession,
    replay: &ReplayTable,
    nonce: &str,
    job_id: &str,
    origins: &[&str],
    confirmed: bool,
    now_ms: u64,
) -> Result<(), SessionError> {
    if replay.is_used(nonce) || session.redeemed {
        return Err(SessionError::Replay);
    }
    if session.nonce != nonce {
        return Err(SessionError::BadNonce);
    }
    if session.job_id != job_id {
        return Err(SessionError::WrongJob);
    }
    if session.is_expired(now_ms) {
        return Err(SessionError::Expired);
    }
    if !confirmed {
        return Err(SessionError::ConfirmationRequired);
    }
    if origins.is_empty() || origins.len() > MAX_ORIGINS {
        return Err(SessionError::BadOrigins);
    }
    session.consented = true;
    Ok(())
}

/// Redeem exactly once. Callers must only perform network activity on `Ok`.
pub fn redeem_once(
    session: &mut HandoffSession,
    replay: &mut ReplayTable,
    nonce: &str,
    job_id: &str,
    now_ms: u64,
) -> Result<(), SessionError> {
    if session.redeemed || replay.is_used(nonce) {
        return Err(SessionError::Replay);
    }
    if session.nonce != nonce {
        return Err(SessionError::BadNonce);
    }
    if session.job_id != job_id {
        return Err(SessionError::WrongJob);
    }
    if session.is_expired(now_ms) {
        return Err(SessionError::Expired);
    }
    if !session.consented {
        return Err(SessionError::ConsentRequired);
    }
    session.redeemed = true;
    replay.mark_used(nonce);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(now: u64) -> (HandoffSession, ReplayTable) {
        let s = begin_session(true, 2, "job-1", "ext-id", "ch-1", "n-1", now).unwrap();
        (s, ReplayTable::new())
    }

    #[test]
    fn version_negotiation_current_and_n_minus_1() {
        assert!(begin_session(true, 2, "j", "e", "c", "n", 0).is_ok());
        assert!(begin_session(true, 1, "j", "e", "c", "n", 0).is_ok());
        assert_eq!(
            begin_session(true, 0, "j", "e", "c", "n", 0),
            Err(SessionError::IncompatibleVersion { got: 0 })
        );
        assert_eq!(
            begin_session(true, 3, "j", "e", "c", "n", 0),
            Err(SessionError::IncompatibleVersion { got: 3 })
        );
    }

    #[test]
    fn replay_expired_wrong_job_rejected() {
        let (mut s, mut replay) = sess(1000);
        bind_consent(&mut s, &replay, "n-1", "job-1", &["https://a.example/"], true, 1000).unwrap();
        assert!(redeem_once(&mut s, &mut replay, "n-1", "job-1", 1000).is_ok());
        // Second redeem is replay, no network.
        assert_eq!(
            redeem_once(&mut s, &mut replay, "n-1", "job-1", 1000),
            Err(SessionError::Replay)
        );
        let (mut s2, replay2) = sess(0);
        assert_eq!(
            bind_consent(&mut s2, &replay2, "wrong", "job-1", &["https://a.example/"], true, 0),
            Err(SessionError::BadNonce)
        );
        assert_eq!(
            bind_consent(&mut s2, &replay2, "n-1", "other-job", &["https://a.example/"], true, 0),
            Err(SessionError::WrongJob)
        );
        assert_eq!(
            bind_consent(
                &mut s2,
                &replay2,
                "n-1",
                "job-1",
                &["https://a.example/"],
                true,
                HANDOFF_TTL_MS + 1
            ),
            Err(SessionError::Expired)
        );
    }
}
