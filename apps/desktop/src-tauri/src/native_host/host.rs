//! Stateful handoff execution for the Native Messaging host.
//!
//! Pure state machine over [`crate::native_host::session`],
//! [`crate::native_host::envelope`], and [`crate::jobs`]. I/O (clock,
//! randomness, stdio) stays in the binary; this module takes `now_ms` and
//! caller-supplied freshness so unit tests are deterministic.
//!
//! Trust model (do not weaken):
//! - Browser enforcement of the manifest allowlist authenticates the channel
//!   sender. A self-asserted `extensionId` payload field never authenticates
//!   anyone; it is validated for shape only and passed to the injected
//!   allowlist for tests. Production allowlists always admit the channel
//!   (the browser already enforced it).
//! - Challenge + one-use nonce bind one consent/credential exchange to one
//!   job and block replay. They are session binding, not signatures.
//! - Cookies appear only in the single inbound `credential` message, are
//!   scoped to the consented origins/names, never leave in responses or
//!   diagnostics, and are best-effort overwritten after transfer (no
//!   universal-zeroization claim).

use std::collections::{BTreeMap, HashMap};

use crate::jobs::JobTable;
use crate::native_host::envelope::{self, CookieEntry, HostRequest, MAX_COOKIES, MAX_TOKEN_LEN};
use crate::native_host::redaction;
use crate::native_host::session::{
    self, HandoffSession, ReplayTable, SessionError, CURRENT_NATIVE_PROTOCOL, MIN_NATIVE_PROTOCOL,
};

/// Native host identity (matches manifests and capabilities).
pub const HOST_NAME: &str = "dev.ophir.dezoomify.native_host";
/// Host application version.
pub const HOST_VERSION: &str = "3.0.2";
/// Dezoomify protocol version spoken on this channel.
pub const HOST_PROTOCOL: &str = "1.0";

/// Allowlist check for the channel extension id. Production hosts always
/// admit (the browser enforced the manifest); tests inject denials.
pub type Allowlist = fn(&str) -> bool;

/// Always admit: the browser enforced the manifest allowlist before the
/// channel existed. The payload id is informational only.
pub fn admit_channel(_extension_id: &str) -> bool {
    true
}

/// Map a session error to a stable wire code.
#[must_use]
pub fn session_error_code(err: &SessionError) -> &'static str {
    match err {
        SessionError::IdNotAllowed => "id-not-allowed",
        SessionError::IncompatibleVersion { .. } => "protocol.incompatible",
        SessionError::BadJob => "bad-job",
        SessionError::UnknownChallenge => "unknown-challenge",
        SessionError::BadNonce => "bad-nonce",
        SessionError::WrongJob => "wrong-job",
        SessionError::Expired => "expired",
        SessionError::Replay => "replay",
        SessionError::ConsentRequired => "consent-required",
        SessionError::ConfirmationRequired => "confirmation-required",
        SessionError::BadOrigins => "bad-origins",
        SessionError::BadCookies => "bad-cookies",
    }
}

/// Stateful host: pending one-use sessions, spent nonces, and jobs.
pub struct HostState {
    sessions: HashMap<String, HandoffSession>,
    replay: ReplayTable,
    jobs: JobTable,
    is_allowed: Allowlist,
}

impl HostState {
    /// Create empty state with the given allowlist.
    #[must_use]
    pub fn new(is_allowed: Allowlist) -> Self {
        Self {
            sessions: HashMap::new(),
            replay: ReplayTable::new(),
            jobs: JobTable::new(),
            is_allowed,
        }
    }

    /// Create with the production allowlist (always admit; browser enforced).
    #[must_use]
    pub fn production() -> Self {
        Self::new(admit_channel)
    }

    /// Number of pending sessions (for tests).
    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.sessions.len()
    }

    /// Canonical handshake acknowledgement (no secrets).
    #[must_use]
    pub fn handshake_ack() -> serde_json::Value {
        serde_json::json!({
            "kind": "handshake-ack",
            "name": HOST_NAME,
            "version": HOST_VERSION,
            "protocol": HOST_PROTOCOL,
            "nativeProtocol": {"min": MIN_NATIVE_PROTOCOL, "max": CURRENT_NATIVE_PROTOCOL},
            "capabilities": {"encoders": ["png", "jpeg", "tiff", "zif", "webp"], "handoff": true},
        })
    }

    /// Fail-closed error envelope (codes/messages only, never values).
    #[must_use]
    pub fn error_envelope(code: &str, message: &str) -> serde_json::Value {
        let safe: String = message.chars().take(128).collect();
        serde_json::json!({"error": {"code": code, "message": safe}})
    }

    /// Handle one framed JSON body. Returns the response JSON bytes plus an
    /// optional redacted stderr diagnostic (names/scopes only, never values).
    ///
    /// `now_ms` is the caller clock; `fresh` supplies one fresh
    /// `(challenge, nonce)` pair per `negotiate` (16 random bytes hex each in
    /// production, deterministic in tests).
    pub fn handle(
        &mut self,
        body: &[u8],
        now_ms: u64,
        fresh: &mut dyn FnMut() -> (String, String),
    ) -> (Vec<u8>, Option<String>) {
        let request = match envelope::parse_request(body) {
            Ok(req) => req,
            Err((code, message)) => {
                return (json_bytes(&Self::error_envelope(&code, &message)), None);
            }
        };
        match request {
            HostRequest::Handshake {
                protocol,
                client_version,
            } => {
                if let Some(p) = protocol {
                    if p != HOST_PROTOCOL && p != "1" {
                        return (
                            json_bytes(&Self::error_envelope(
                                "protocol.incompatible",
                                "unsupported protocol version",
                            )),
                            None,
                        );
                    }
                }
                if let Some(v) = client_version {
                    if !(MIN_NATIVE_PROTOCOL..=CURRENT_NATIVE_PROTOCOL).contains(&v) {
                        return (
                            json_bytes(&Self::error_envelope(
                                "protocol.incompatible",
                                "unsupported native protocol version",
                            )),
                            None,
                        );
                    }
                }
                (json_bytes(&Self::handshake_ack()), None)
            }
            HostRequest::Negotiate {
                client_version,
                job_id,
                extension_id,
            } => {
                let (challenge, nonce) = fresh();
                let ext = extension_id.unwrap_or_default();
                if !ext.is_empty() && !is_plausible_extension_id(&ext) {
                    return (
                        json_bytes(&Self::error_envelope(
                            "handoff.rejected",
                            "malformed extension id",
                        )),
                        None,
                    );
                }
                let allowed = (self.is_allowed)(&ext);
                match session::begin_session(
                    allowed,
                    client_version,
                    &job_id,
                    &ext,
                    &challenge,
                    &nonce,
                    now_ms,
                ) {
                    Ok(sess) => {
                        let negotiated = sess.negotiated_version;
                        let expires = sess.expires_at_ms;
                        self.sessions.insert(challenge.clone(), sess);
                        (
                            json_bytes(&serde_json::json!({
                                "kind": "negotiated",
                                "negotiatedVersion": negotiated,
                                "challenge": challenge,
                                "nonce": nonce,
                                "expiresAt": expires,
                            })),
                            None,
                        )
                    }
                    Err(e) => {
                        let code = session_error_code(&e).to_string();
                        let message = session_error_message(&e);
                        (json_bytes(&Self::error_envelope(&code, &message)), None)
                    }
                }
            }
            HostRequest::Consent {
                challenge,
                nonce,
                job_id,
                origins,
                cookie_names,
                confirmed,
            } => {
                if self.replay.is_used(&nonce) {
                    return (
                        json_bytes(&Self::error_envelope("replay", "nonce already spent")),
                        None,
                    );
                }
                let Some(sess) = self.sessions.get_mut(&challenge) else {
                    return (
                        json_bytes(&Self::error_envelope(
                            "unknown-challenge",
                            "unknown challenge",
                        )),
                        None,
                    );
                };
                let origin_refs: Vec<&str> = origins.iter().map(String::as_str).collect();
                let name_refs: Vec<&str> = cookie_names.iter().map(String::as_str).collect();
                match session::bind_consent(
                    sess,
                    &self.replay,
                    &nonce,
                    &job_id,
                    &origin_refs,
                    &name_refs,
                    confirmed,
                    now_ms,
                ) {
                    Ok(()) => (json_bytes(&serde_json::json!({"kind": "consented"})), None),
                    Err(e) => {
                        let code = session_error_code(&e).to_string();
                        let message = session_error_message(&e);
                        (json_bytes(&Self::error_envelope(&code, &message)), None)
                    }
                }
            }
            HostRequest::Credential {
                challenge,
                nonce,
                job_id,
                source_url,
                origins,
                mut cookies,
            } => self.handle_credential(
                &challenge,
                &nonce,
                &job_id,
                &source_url,
                &origins,
                &mut cookies,
                now_ms,
            ),
            HostRequest::Decline { challenge } => {
                self.sessions.remove(&challenge);
                (
                    json_bytes(&serde_json::json!({
                        "kind": "declined",
                        "continuedCookieless": true,
                    })),
                    None,
                )
            }
        }
    }

    /// Validate a credential message against its consented session, start one
    /// job with origin-scoped `UserHeaders` cookies, overwrite cookie values,
    /// and report the redacted outcome.
    ///
    /// Cookies are memory-only: the inbound values are best-effort
    /// overwritten after transfer and the driver's copy lives in the job's
    /// `PipelineConfig::user_headers` RAM only (never logged, never cached,
    /// never serialized). Only cookies scoped to the source URL origin reach
    /// the driver; sibling entries are dropped and never sent elsewhere.
    // 6.1: credential handling takes explicit scalar params so no secret
    // bundle struct can leak across the consent boundary; grouping them
    // would widen what a caller can pass by mistake.
    #[allow(clippy::too_many_arguments)]
    fn handle_credential(
        &mut self,
        challenge: &str,
        nonce: &str,
        job_id: &str,
        source_url: &str,
        origins: &[String],
        cookies: &mut [CookieEntry],
        now_ms: u64,
    ) -> (Vec<u8>, Option<String>) {
        if challenge.is_empty()
            || challenge.len() > MAX_TOKEN_LEN
            || nonce.is_empty()
            || nonce.len() > MAX_TOKEN_LEN
        {
            return (
                json_bytes(&Self::error_envelope("bad-nonce", "malformed challenge")),
                None,
            );
        }
        if self.replay.is_used(nonce) {
            return (
                json_bytes(&Self::error_envelope("replay", "nonce already spent")),
                None,
            );
        }
        // Scope checks need the consented session; clone the needed scope so
        // the mutable redeem borrow below does not conflict.
        let (sess_nonce, sess_job, sess_origins, sess_names, consented, expired) =
            match self.sessions.get(challenge) {
                Some(s) => (
                    s.nonce.clone(),
                    s.job_id.clone(),
                    s.origins.clone(),
                    s.cookie_names.clone(),
                    s.consented,
                    s.is_expired(now_ms),
                ),
                None => {
                    return (
                        json_bytes(&Self::error_envelope(
                            "unknown-challenge",
                            "unknown challenge",
                        )),
                        None,
                    );
                }
            };
        if sess_nonce != nonce {
            return (
                json_bytes(&Self::error_envelope("bad-nonce", "nonce mismatch")),
                None,
            );
        }
        if sess_job != job_id {
            return (
                json_bytes(&Self::error_envelope("wrong-job", "job mismatch")),
                None,
            );
        }
        if expired {
            return (
                json_bytes(&Self::error_envelope("expired", "session expired")),
                None,
            );
        }
        if !consented {
            return (
                json_bytes(&Self::error_envelope(
                    "consent-required",
                    "explicit consent required",
                )),
                None,
            );
        }
        if !envelope::validate_source_url(source_url) {
            return (
                json_bytes(&Self::error_envelope(
                    "handoff.rejected",
                    "invalid source url",
                )),
                None,
            );
        }
        if cookies.len() > MAX_COOKIES {
            return (
                json_bytes(&Self::error_envelope("bad-cookies", "too many cookies")),
                None,
            );
        }
        for cookie in cookies.iter() {
            if !envelope::validate_cookie_shape(cookie) {
                return (
                    json_bytes(&Self::error_envelope(
                        "bad-cookies",
                        "malformed cookie entry",
                    )),
                    None,
                );
            }
        }
        // Credential origins must equal the consented set (order-insensitive).
        // This binds the credential message to the exact consent session.
        let mut want: Vec<&str> = sess_origins.iter().map(String::as_str).collect();
        want.sort_unstable();
        let mut got: Vec<&str> = origins.iter().map(String::as_str).collect();
        got.sort_unstable();
        if want != got {
            return (
                json_bytes(&Self::error_envelope(
                    "bad-origins",
                    "origins differ from consent",
                )),
                None,
            );
        }
        // Sibling isolation: every cookie origin must be consented, and every
        // cookie name must have been disclosed at consent time. Cookieless
        // handoffs (zero cookies) are always allowed.
        for cookie in cookies.iter() {
            if !sess_origins.iter().any(|o| o == &cookie.origin) {
                return (
                    json_bytes(&Self::error_envelope(
                        "bad-origins",
                        "cookie origin outside consent",
                    )),
                    None,
                );
            }
            if !sess_names.iter().any(|n| n == &cookie.name) {
                return (
                    json_bytes(&Self::error_envelope(
                        "bad-cookies",
                        "cookie name outside consent",
                    )),
                    None,
                );
            }
        }
        // The source URL must live inside the consented scope: its host must
        // match at least one consented origin host. Otherwise consented
        // cookies could be attached to a job fetching an unconsented sibling.
        if !source_in_scope(source_url, &sess_origins) {
            return (
                json_bytes(&Self::error_envelope(
                    "bad-origins",
                    "source outside consent",
                )),
                None,
            );
        }
        // Origin-scoped driver headers: only cookies whose origin host matches
        // the source URL host reach the driver (as one `Cookie` header, the
        // native `UserHeaders` credential shape). Sibling entries are dropped
        // here and never sent elsewhere. Empty means a cookieless job.
        let mut values: Vec<String> = cookies.iter().map(|c| c.value.clone()).collect();
        let mut user_headers = BTreeMap::new();
        if let Some(header) = cookie_header_for_source(source_url, cookies) {
            user_headers.insert("cookie".to_string(), header);
        }
        // All checks passed: redeem exactly once before any job effect, then
        // start the job. Any failure below still consumed the nonce.
        let mark = {
            let Some(sess) = self.sessions.get_mut(challenge) else {
                overwrite_owned(&mut values);
                overwrite_cookie_values(cookies);
                return (
                    json_bytes(&Self::error_envelope(
                        "unknown-challenge",
                        "unknown challenge",
                    )),
                    None,
                );
            };
            session::redeem_once(sess, &mut self.replay, nonce, job_id, now_ms)
        };
        if let Err(e) = mark {
            let code = session_error_code(&e).to_string();
            let message = session_error_message(&e);
            overwrite_owned(&mut values);
            overwrite_cookie_values(cookies);
            // Drop any header copy built above (it holds joined secrets).
            overwrite_header_map(&mut user_headers);
            return (json_bytes(&Self::error_envelope(&code, &message)), None);
        }
        self.sessions.remove(challenge);
        let job = match self
            .jobs
            .start_job_with_user_headers(source_url, user_headers)
        {
            Ok(id) => id,
            Err(_) => {
                overwrite_owned(&mut values);
                overwrite_cookie_values(cookies);
                return (
                    json_bytes(&Self::error_envelope(
                        "handoff.rejected",
                        "invalid source url",
                    )),
                    None,
                );
            }
        };
        // Redacted diagnostic: names and scopes only, never values. Values are
        // sanitized out defensively even though they are never formatted in.
        let names: Vec<&str> = cookies.iter().map(|c| c.name.as_str()).collect();
        let mut diagnostic =
            redaction::scoped_cookie_diagnostic(&names, &sess_origins.join(","), &job);
        diagnostic = redaction::sanitize_line(
            &diagnostic,
            &values.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        overwrite_owned(&mut values);
        overwrite_cookie_values(cookies);
        let response = serde_json::json!({
            "kind": "job-started",
            "job": job,
            "cookieNames": sess_names,
            "origins": sess_origins,
        });
        (json_bytes(&response), Some(diagnostic))
    }
}

/// Short safe message for a session error (no values).
fn session_error_message(err: &SessionError) -> String {
    match err {
        SessionError::IdNotAllowed => "extension id not allowlisted".to_string(),
        SessionError::IncompatibleVersion { got } => {
            format!("unsupported native protocol version {got}")
        }
        SessionError::BadJob => "invalid job id".to_string(),
        SessionError::UnknownChallenge => "unknown challenge".to_string(),
        SessionError::BadNonce => "nonce mismatch".to_string(),
        SessionError::WrongJob => "job mismatch".to_string(),
        SessionError::Expired => "session expired".to_string(),
        SessionError::Replay => "nonce already spent".to_string(),
        SessionError::ConsentRequired => "explicit consent required".to_string(),
        SessionError::ConfirmationRequired => "explicit confirmation required".to_string(),
        SessionError::BadOrigins => "invalid origins".to_string(),
        SessionError::BadCookies => "invalid cookie scope".to_string(),
    }
}

/// Plausible extension-id shape (exact, no wildcards). Informational only:
/// the browser enforced the allowlist; this only rejects malformed payloads.
fn is_plausible_extension_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_TOKEN_LEN {
        return false;
    }
    if id.contains(['*', '?']) || id.contains(char::is_whitespace) {
        return false;
    }
    true
}

fn json_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"error\":{\"code\":\"handoff.rejected\"}}".to_vec())
}

/// Best-effort overwrite of owned secret buffers, then drop. Only affects
/// these allocations; allocator/OS/transport copies cannot be wiped.
fn overwrite_owned(values: &mut [String]) {
    for value in values.iter_mut() {
        let mut bytes = std::mem::take(value).into_bytes();
        redaction::best_effort_overwrite(&mut bytes);
        *value = String::new();
    }
}

/// Best-effort overwrite of inbound credential values in place. The driver's
/// own header copy (moved into `JobTable`) is a separate allocation and is
/// intentionally retained for the job lifetime; everything else holding the
/// values is wiped here.
fn overwrite_cookie_values(cookies: &mut [CookieEntry]) {
    for cookie in cookies.iter_mut() {
        let mut bytes = std::mem::take(&mut cookie.value).into_bytes();
        redaction::best_effort_overwrite(&mut bytes);
        cookie.value = String::new();
    }
}

/// Best-effort overwrite of a header map built but never handed to the driver
/// (redeem-failure path). The successfully started job keeps its own map.
fn overwrite_header_map(headers: &mut BTreeMap<String, String>) {
    for value in headers.values_mut() {
        let mut bytes = std::mem::take(value).into_bytes();
        redaction::best_effort_overwrite(&mut bytes);
    }
    headers.clear();
}

/// Lowercased host of an http(s) URL or origin string, without port.
/// Pure string parsing (no DNS, no network); `None` on malformed input.
fn host_of(url_or_origin: &str) -> Option<String> {
    let after_scheme = url_or_origin.split("://").nth(1)?;
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => authority,
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// True when the source URL host matches at least one consented origin host
/// (case-insensitive). Ports/paths are ignored: consent scopes the host, and
/// per-cookie origin membership is enforced separately above.
fn source_in_scope(source_url: &str, consented_origins: &[String]) -> bool {
    let Some(source_host) = host_of(source_url) else {
        return false;
    };
    consented_origins
        .iter()
        .filter_map(|o| host_of(o))
        .any(|h| h == source_host)
}

/// Build the origin-scoped `Cookie` header value for the driver.
///
/// Keeps only cookies whose origin host matches the source URL host; sibling
/// entries are dropped (never sent to another origin). Pairs sort by name
/// for determinism. Returns `None` when no cookie applies (cookieless job).
fn cookie_header_for_source(source_url: &str, cookies: &[CookieEntry]) -> Option<String> {
    let source_host = host_of(source_url)?;
    let mut pairs: Vec<(&str, &str)> = cookies
        .iter()
        .filter(|c| host_of(&c.origin).is_some_and(|h| h == source_host))
        .map(|c| (c.name.as_str(), c.value.as_str()))
        .collect();
    if pairs.is_empty() {
        return None;
    }
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    Some(
        pairs
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_pair(tag: &str) -> (String, String) {
        (format!("ch-{tag}"), format!("n-{tag}"))
    }

    fn negotiate(state: &mut HostState, tag: &str, job: &str, now: u64) -> (String, String) {
        let (ch, n) = fresh_pair(tag);
        let body = serde_json::json!({
            "kind": "negotiate",
            "clientVersion": 2,
            "jobId": job,
            "extensionId": "ext-allowed",
        });
        let (res, _) = state.handle(&serde_json::to_vec(&body).unwrap(), now, &mut || {
            (ch.clone(), n.clone())
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("kind").and_then(|k| k.as_str()),
            Some("negotiated"),
            "negotiate failed: {value}"
        );
        assert_eq!(
            value.get("challenge").and_then(|v| v.as_str()),
            Some(ch.as_str())
        );
        (ch, n)
    }

    #[test]
    fn handshake_reports_handoff_capability() {
        let mut state = HostState::production();
        let (res, diag) = state.handle(
            br#"{"kind":"handshake","protocol":"1.0","clientVersion":2}"#,
            0,
            &mut || fresh_pair("x"),
        );
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("kind").and_then(|k| k.as_str()),
            Some("handshake-ack")
        );
        assert_eq!(
            value
                .pointer("/capabilities/handoff")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(diag.is_none());
        // N-1 accepted, future rejected.
        let (res, _) = state.handle(
            br#"{"kind":"handshake","protocol":"1.0","clientVersion":1}"#,
            0,
            &mut || fresh_pair("x"),
        );
        assert!(serde_json::from_slice::<serde_json::Value>(&res)
            .unwrap()
            .get("kind")
            .is_some());
        let (res, _) = state.handle(
            br#"{"kind":"handshake","protocol":"1.0","clientVersion":9}"#,
            0,
            &mut || fresh_pair("x"),
        );
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.pointer("/error/code").and_then(|v| v.as_str()),
            Some("protocol.incompatible")
        );
    }

    #[test]
    fn full_consented_cookie_handoff_starts_one_job() {
        let mut state = HostState::production();
        let (challenge, nonce) = negotiate(&mut state, "a", "job:ext-1", 1000);
        let consent = serde_json::json!({
            "kind": "consent",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-1",
            "origins": ["https://protected.example/"],
            "cookieNames": ["session"],
            "confirmed": true,
        });
        let (res, _) = state.handle(&serde_json::to_vec(&consent).unwrap(), 1000, &mut || {
            fresh_pair("x")
        });
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&res)
                .unwrap()
                .get("kind")
                .and_then(|k| k.as_str()),
            Some("consented")
        );
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-1",
            "sourceUrl": "https://protected.example/item",
            "origins": ["https://protected.example/"],
            "cookies": [{"name": "session", "value": "CANARY-abc123", "origin": "https://protected.example/"}],
        });
        let (res, diag) =
            state.handle(&serde_json::to_vec(&credential).unwrap(), 1000, &mut || {
                fresh_pair("x")
            });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("kind").and_then(|k| k.as_str()),
            Some("job-started")
        );
        let text = serde_json::to_string(&value).unwrap();
        assert!(
            !text.contains("CANARY-abc123"),
            "value leaked into response"
        );
        let diag = diag.expect("redacted diagnostic");
        assert!(diag.contains("session"), "names only diagnostic");
        assert!(!diag.contains("CANARY-abc123"), "value leaked into stderr");
        assert_eq!(state.pending_count(), 0);
        // The driver job carries the origin-scoped cookie in memory-only
        // `UserHeaders` (never in the response/diagnostic/Debug).
        let driver_job = value
            .get("job")
            .and_then(|j| j.as_str())
            .expect("driver job id")
            .to_string();
        let config = state
            .jobs
            .config_for(&driver_job)
            .expect("driver config for handoff job");
        assert_eq!(
            config.user_headers.get("cookie").map(String::as_str),
            Some("session=CANARY-abc123"),
            "consented cookie must reach the driver"
        );
        let debug = format!("{:?}", state.jobs);
        assert!(
            !debug.contains("CANARY-abc123"),
            "cookie value leaked into Debug"
        );
        // Replay with the same nonce is rejected without a new job.
        let (res, diag) =
            state.handle(&serde_json::to_vec(&credential).unwrap(), 1000, &mut || {
                fresh_pair("x")
            });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert!(value.get("error").is_some());
        assert!(diag.is_none());
    }

    #[test]
    fn decline_continues_cookieless_and_sibling_gets_no_cookie() {
        let mut state = HostState::production();
        let (challenge, nonce) = negotiate(&mut state, "d", "job:ext-d", 0);
        let decline = serde_json::json!({"kind": "decline", "challenge": challenge});
        let (res, _) = state.handle(&serde_json::to_vec(&decline).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("continuedCookieless").and_then(|v| v.as_bool()),
            Some(true)
        );
        // A sibling origin outside consent is rejected.
        let (challenge2, nonce2) = negotiate(&mut state, "s", "job:ext-s", 0);
        let consent = serde_json::json!({
            "kind": "consent",
            "challenge": challenge2,
            "nonce": nonce2,
            "jobId": "job:ext-s",
            "origins": ["https://protected.example/"],
            "cookieNames": ["session"],
            "confirmed": true,
        });
        let _ = state.handle(&serde_json::to_vec(&consent).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge2,
            "nonce": nonce2,
            "jobId": "job:ext-s",
            "sourceUrl": "https://protected.example/item",
            "origins": ["https://protected.example/"],
            "cookies": [{"name": "session", "value": "CANARY", "origin": "https://sibling.example/"}],
        });
        let (res, _) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert!(value.get("error").is_some());
        assert!(!serde_json::to_string(&value).unwrap().contains("CANARY"));
        let _ = (challenge, nonce);
    }

    #[test]
    fn unconsented_and_expired_redeem_rejected_without_job() {
        let mut state = HostState::production();
        let (challenge, nonce) = negotiate(&mut state, "u", "job:ext-u", 0);
        // No consent yet: credential requires consent.
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-u",
            "sourceUrl": "https://protected.example/item",
            "origins": ["https://protected.example/"],
            "cookies": [],
        });
        let (res, _) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.pointer("/error/code").and_then(|v| v.as_str()),
            Some("consent-required")
        );
        // Consent then expire: redeem is expired without network.
        let consent = serde_json::json!({
            "kind": "consent",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-u",
            "origins": ["https://protected.example/"],
            "cookieNames": [],
            "confirmed": true,
        });
        let _ = state.handle(&serde_json::to_vec(&consent).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let (res, _) = state.handle(
            &serde_json::to_vec(&credential).unwrap(),
            session::HANDOFF_TTL_MS + 1,
            &mut || fresh_pair("x"),
        );
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.pointer("/error/code").and_then(|v| v.as_str()),
            Some("expired")
        );
    }

    #[test]
    fn secret_source_and_unknown_challenge_rejected() {
        let mut state = HostState::production();
        let (challenge, nonce) = negotiate(&mut state, "sec", "job:ext-sec", 0);
        let consent = serde_json::json!({
            "kind": "consent",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-sec",
            "origins": ["https://protected.example/"],
            "cookieNames": [],
            "confirmed": true,
        });
        let _ = state.handle(&serde_json::to_vec(&consent).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        for bad in [
            "https://example.com/x?token=secret",
            "https://user:pass@example.com/x",
            "file:///etc/passwd",
        ] {
            let credential = serde_json::json!({
                "kind": "credential",
                "challenge": challenge,
                "nonce": nonce,
                "jobId": "job:ext-sec",
                "sourceUrl": bad,
                "origins": ["https://protected.example/"],
                "cookies": [],
            });
            let (res, _) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
                fresh_pair("x")
            });
            let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
            assert!(
                value.get("error").is_some(),
                "source {bad:?} must be rejected"
            );
        }
        let (res, _) = state.handle(
            br#"{"kind":"consent","challenge":"nope","nonce":"n","jobId":"job:x","origins":["https://a.example/"],"cookieNames":[],"confirmed":true}"#,
            0,
            &mut || fresh_pair("x"),
        );
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.pointer("/error/code").and_then(|v| v.as_str()),
            Some("unknown-challenge")
        );
    }

    fn consented_state(
        state: &mut HostState,
        tag: &str,
        job: &str,
        origins: &[&str],
        names: &[&str],
        now: u64,
    ) -> (String, String) {
        let (challenge, nonce) = negotiate(state, tag, job, now);
        let consent = serde_json::json!({
            "kind": "consent",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": job,
            "origins": origins,
            "cookieNames": names,
            "confirmed": true,
        });
        let (res, _) = state.handle(&serde_json::to_vec(&consent).unwrap(), now, &mut || {
            fresh_pair("x")
        });
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&res)
                .unwrap()
                .get("kind")
                .and_then(|k| k.as_str()),
            Some("consented")
        );
        (challenge, nonce)
    }

    #[test]
    fn source_outside_consent_rejected_without_job() {
        let mut state = HostState::production();
        let (challenge, nonce) = consented_state(
            &mut state,
            "scope",
            "job:ext-scope",
            &["https://protected.example/"],
            &["session"],
            0,
        );
        let jobs_before = state.jobs.len();
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-scope",
            "sourceUrl": "https://sibling.example/item",
            "origins": ["https://protected.example/"],
            "cookies": [{"name": "session", "value": "CANARY-scope", "origin": "https://protected.example/"}],
        });
        let (res, diag) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.pointer("/error/code").and_then(|v| v.as_str()),
            Some("bad-origins"),
            "source outside consent must be rejected: {value}"
        );
        assert!(diag.is_none());
        assert!(!serde_json::to_string(&value)
            .unwrap()
            .contains("CANARY-scope"));
        assert_eq!(state.jobs.len(), jobs_before, "no job on scope rejection");
    }

    #[test]
    fn sibling_cookie_filtered_from_driver_header() {
        let mut state = HostState::production();
        let (challenge, nonce) = consented_state(
            &mut state,
            "multi",
            "job:ext-multi",
            &["https://a.example/", "https://b.example/"],
            &["session", "theme"],
            0,
        );
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-multi",
            "sourceUrl": "https://a.example/item",
            "origins": ["https://a.example/", "https://b.example/"],
            "cookies": [
                {"name": "session", "value": "CANARY-A", "origin": "https://a.example/"},
                {"name": "theme", "value": "CANARY-B", "origin": "https://b.example/"},
            ],
        });
        let (res, diag) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("kind").and_then(|k| k.as_str()),
            Some("job-started"),
            "multi-origin handoff must start: {value}"
        );
        let driver_job = value
            .get("job")
            .and_then(|j| j.as_str())
            .expect("driver job id");
        let config = state.jobs.config_for(driver_job).expect("driver config");
        // Only the source-origin cookie reaches the driver; the sibling is
        // dropped and never sent to another origin.
        assert_eq!(
            config.user_headers.get("cookie").map(String::as_str),
            Some("session=CANARY-A"),
            "sibling cookie must never reach the source job"
        );
        let text = serde_json::to_string(&value).unwrap();
        assert!(!text.contains("CANARY-A") && !text.contains("CANARY-B"));
        let diag = diag.expect("diagnostic");
        assert!(!diag.contains("CANARY-A") && !diag.contains("CANARY-B"));
    }

    #[test]
    fn cookieless_handoff_starts_job_without_cookie_header() {
        let mut state = HostState::production();
        let (challenge, nonce) = consented_state(
            &mut state,
            "free",
            "job:ext-free",
            &["https://protected.example/"],
            &[],
            0,
        );
        let credential = serde_json::json!({
            "kind": "credential",
            "challenge": challenge,
            "nonce": nonce,
            "jobId": "job:ext-free",
            "sourceUrl": "https://protected.example/item",
            "origins": ["https://protected.example/"],
            "cookies": [],
        });
        let (res, _) = state.handle(&serde_json::to_vec(&credential).unwrap(), 0, &mut || {
            fresh_pair("x")
        });
        let value: serde_json::Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(
            value.get("kind").and_then(|k| k.as_str()),
            Some("job-started"),
            "cookieless handoff must start: {value}"
        );
        let driver_job = value.get("job").and_then(|j| j.as_str()).unwrap();
        let config = state.jobs.config_for(driver_job).unwrap();
        assert!(
            !config.user_headers.contains_key("cookie"),
            "cookieless job must carry no cookie header"
        );
    }

    #[test]
    fn cookie_header_scoping_helpers() {
        assert_eq!(
            host_of("https://Example.com/item"),
            Some("example.com".into())
        );
        assert_eq!(
            host_of("https://example.com:8443/x"),
            Some("example.com".into())
        );
        assert!(host_of("file:///etc/passwd").is_none());
        assert!(host_of("https://user:pass@example.com/").is_none());
        let cookies = vec![
            CookieEntry {
                name: "b".into(),
                value: "2".into(),
                origin: "https://a.example/".into(),
            },
            CookieEntry {
                name: "a".into(),
                value: "1".into(),
                origin: "https://a.example/".into(),
            },
        ];
        assert_eq!(
            cookie_header_for_source("https://a.example/item", &cookies).as_deref(),
            Some("a=1; b=2")
        );
        assert!(source_in_scope(
            "https://a.example/item",
            &["https://a.example/".to_string()]
        ));
        assert!(!source_in_scope(
            "https://sibling.example/item",
            &["https://a.example/".to_string()]
        ));
    }
}
