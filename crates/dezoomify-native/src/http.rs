//! Native fetch façade: typed limits, scoped user headers, and outcomes.
//!
//! All HTTP goes through [`crate::transport::NativeTransport`] (one reusable
//! reqwest client per job scope). [`fetch`] is the one-shot path for
//! out-of-band reads (bulk-list fetches); the driver hot paths (discovery,
//! probes, tiles) take a job-scoped transport directly so connections are
//! reused across tiles instead of rebuilding a client per fetch.
//!
//! Single-attempt semantics: the transport performs exactly one HTTP exchange
//! per call and never retries. The engine owns the whole retry budget, so
//! transport retries can no longer multiply it. Non-HTTP URIs never reach
//! the network: plain local paths and `file://` URIs are read from the
//! filesystem with the same outcome shape.

use std::collections::BTreeMap;
use std::time::Duration;

/// Trusted user headers (CLI `-H`). They are native-memory only, redacted
/// from diagnostics, and credential headers (`cookie`, `authorization`) are
/// sent exclusively to the input origin and its same-host redirects.
#[derive(Clone, Debug, Default)]
pub struct UserHeaders {
    pub map: BTreeMap<String, String>,
    /// Host of the input URL, for credential scoping.
    pub origin_host: Option<String>,
}

impl UserHeaders {
    #[must_use]
    pub fn new(map: BTreeMap<String, String>, origin_host: Option<String>) -> Self {
        Self { map, origin_host }
    }

    fn is_credential(name: &str) -> bool {
        name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("authorization")
    }

    pub(crate) fn apply(&self, request: &mut crate::client::EffectiveRequest) {
        for (name, value) in &self.map {
            if Self::is_credential(name) {
                // Credentials only ever reach the matching origin.
                let same_host = url::Url::parse(&request.uri)
                    .ok()
                    .and_then(|parsed| parsed.host_str().map(str::to_string))
                    .is_some_and(|host| {
                        self.origin_host
                            .as_deref()
                            .is_some_and(|origin| origin.eq_ignore_ascii_case(&host))
                    });
                if same_host {
                    request
                        .headers
                        .insert(name.to_ascii_lowercase(), value.clone());
                }
            } else {
                request
                    .headers
                    .insert(name.to_ascii_lowercase(), value.clone());
            }
        }
    }
}

use crate::auth::EphemeralAuthorization;
use crate::error::NativeError;

/// TLS policy for one logical fetch. `accept_invalid_certs` is a legacy
/// parity escape hatch, explicitly requested by the user via the CLI
/// `--accept-invalid-certs` flag; it is never enabled by default.
#[derive(Clone, Debug, Default)]
pub struct TlsPolicy {
    pub accept_invalid_certs: bool,
}

/// Transport limits for one logical fetch (including its redirects).
///
/// There is deliberately no retry count here: the transport performs exactly
/// one attempt per call and the engine owns the whole retry budget, so a
/// transport retry loop can no longer multiply engine retries.
#[derive(Clone, Debug)]
pub struct FetchLimits {
    pub max_bytes: u64,
    /// Max time for one logical fetch including redirects (default 30s,
    /// matching the reference `--timeout` default).
    pub timeout: Duration,
    /// Max time to establish a connection (default 6s, matching the
    /// reference `--connect-timeout` default).
    pub connect_timeout: Duration,
    pub max_redirects: usize,
    /// Max idle connections kept per host (default 32, matching the
    /// reference `--max-idle-per-host` default).
    pub max_idle_per_host: usize,
    pub tls: TlsPolicy,
}

impl Default for FetchLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 << 20,
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(6),
            max_redirects: 5,
            max_idle_per_host: 32,
            tls: TlsPolicy::default(),
        }
    }
}

/// Result of one logical fetch: final (post-redirect) URI plus body bytes.
#[derive(Clone, Debug)]
pub struct FetchOutcome {
    pub status: u16,
    pub final_uri: String,
    pub body: Vec<u8>,
    /// Host-observed `retry-after` hint in milliseconds, parsed from the
    /// final response when present (numeric-seconds form only, clamped to 5
    /// minutes). The engine honors it on transient failures; `None` means no
    /// hint was observed.
    pub retry_after_ms: Option<u64>,
}

impl FetchOutcome {
    #[must_use]
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// One-shot fetch for out-of-band reads. Builds an ephemeral transport per
/// call, so hot paths must prefer a job-scoped [`crate::transport::NativeTransport`]
/// to reuse connections. Behavior (redirects, scoping, limits, local reads)
/// is identical: one implementation serves both.
pub fn fetch(
    uri: &str,
    extra_headers: &BTreeMap<String, String>,
    user: Option<&UserHeaders>,
    auth: Option<&EphemeralAuthorization>,
    limits: &FetchLimits,
) -> Result<FetchOutcome, NativeError> {
    crate::transport::NativeTransport::oneshot(limits)?.fetch(
        uri,
        extra_headers,
        user,
        auth,
        limits,
    )
}
