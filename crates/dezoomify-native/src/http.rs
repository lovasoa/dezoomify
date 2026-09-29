use std::collections::BTreeMap;
use std::time::Duration;

/// Trusted user headers (CLI `-H`). They are native-memory only; credential
/// headers (`cookie`, `authorization`) are sent exclusively to the input
/// origin and its same-host redirects.
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

use dezoomify::model::Error;

/// TLS policy for one logical fetch. `accept_invalid_certs` is
/// explicitly requested by the user via the CLI
/// `--accept-invalid-certs` flag; it is never enabled by default.
#[derive(Clone, Debug, Default)]
pub struct TlsPolicy {
    pub accept_invalid_certs: bool,
}

#[derive(Clone, Debug)]
pub struct FetchLimits {
    pub max_bytes: u64,
    /// Max time for one logical fetch including redirects (default 30s).
    pub timeout: Duration,
    /// Max time to establish a connection (default 6s).
    pub connect_timeout: Duration,
    pub max_redirects: usize,
    /// Max idle connections kept per host (default 32).
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
    pub content_type: Option<String>,
    pub status: u16,
    pub final_uri: String,
    pub body: Vec<u8>,
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
    limits: &FetchLimits,
) -> Result<FetchOutcome, Error> {
    crate::transport::NativeTransport::new(limits)?.fetch(uri, extra_headers, user, limits)
}
