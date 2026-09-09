//! Real HTTP egress for the native runtime: rustls-based blocking client,
//! manual redirects with per-URL header rebuild, size/time limits, and
//! bounded retries. This is the only place the CLI touches the network.
//!
//! Non-HTTP URIs never reach the network: plain local paths and `file://`
//! URIs are read from the filesystem with the same outcome shape, so local
//! inputs and local tile URIs work without HTTP requirements.

use std::collections::BTreeMap;
use std::io::Read;
use std::time::{Duration, Instant};

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

    fn apply(&self, request: &mut EffectiveRequest) {
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
use crate::client::{build_request, rebuild_for_redirect, EffectiveRequest};
use crate::error::NativeError;

/// TLS policy for one logical fetch. `accept_invalid_certs` is a legacy
/// parity escape hatch, explicitly requested by the user via the CLI
/// `--accept-invalid-certs` flag; it is never enabled by default.
#[derive(Clone, Debug, Default)]
pub struct TlsPolicy {
    pub accept_invalid_certs: bool,
}

/// Transport limits for one logical fetch (including its redirects).
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
    pub retries: u32,
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
            retries: 1,
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
}

impl FetchOutcome {
    #[must_use]
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// One redirect hop beyond the limit, or a missing location.
const REDIRECT_CODES: [u16; 6] = [301, 302, 303, 307, 308, 300];

pub fn fetch(
    uri: &str,
    extra_headers: &BTreeMap<String, String>,
    user: Option<&UserHeaders>,
    auth: Option<&EphemeralAuthorization>,
    limits: &FetchLimits,
) -> Result<FetchOutcome, NativeError> {
    // Local files intentionally ignore HTTP requirements while preserving
    // the same URI behavior: the bytes come from the filesystem and the
    // final URI stays the input URI (reference `network.rs:34-84`). No
    // headers or credentials are sent anywhere on this path.
    if !uri.starts_with("http://") && !uri.starts_with("https://") {
        return fetch_local(uri, limits);
    }
    let mut request = build_request(uri, extra_headers, auth)?;
    if let Some(user) = user {
        user.apply(&mut request);
    }
    let deadline = Instant::now() + limits.timeout;
    let mut redirects: usize = 0;
    let mut builder = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_connect(Some(limits.connect_timeout))
        .max_idle_connections_per_host(limits.max_idle_per_host.max(1));
    if limits.tls.accept_invalid_certs {
        builder = builder.tls_config(
            ureq::tls::TlsConfig::builder()
                .disable_verification(true)
                .build(),
        );
    }
    let agent = builder.build().into();
    loop {
        let response = fetch_once(&agent, &request, limits, &deadline)?;
        let is_redirect = REDIRECT_CODES.contains(&response.status().as_u16())
            && response.headers().get("location").is_some();
        if !is_redirect {
            let status = response.status().as_u16();
            let final_uri = request.uri.clone();
            let body = read_body(response, limits)?;
            return Ok(FetchOutcome {
                status,
                final_uri,
                body,
            });
        }
        if redirects >= limits.max_redirects {
            return Err(NativeError::new(
                "transport.redirect-limit",
                format!("redirect limit of {} exceeded", limits.max_redirects),
            ));
        }
        redirects += 1;
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| NativeError::new("transport.bad-redirect", "missing location"))?;
        let next = resolve_redirect(&request.uri, location)?;
        request = rebuild_for_redirect(&request, &next, auth)?;
        if let Some(user) = user {
            user.apply(&mut request);
        }
    }
}

/// Map a non-HTTP URI to a filesystem path: `file://` URIs strip the
/// scheme (`file:///abs/path` and `file://localhost/abs/path` both name an
/// absolute path; any other `file://` host is rejected), while anything
/// else is already a local path and passes through unchanged.
fn local_path_for_uri(uri: &str) -> Result<&str, NativeError> {
    if let Some(rest) = uri.strip_prefix("file://") {
        if let Some(path) = rest.strip_prefix("localhost") {
            if path.is_empty() {
                return Ok("/");
            }
            if path.starts_with('/') {
                return Ok(path);
            }
        } else if rest.starts_with('/') {
            return Ok(rest);
        }
        return Err(NativeError::new(
            "transport.bad-url",
            "file uri must name a local absolute path",
        ));
    }
    Ok(uri)
}

/// Read a local resource (single inputs, bulk-adjacent metadata, and tile
/// URIs alike) with the same outcome shape as an HTTP 200: the final URI
/// stays the input URI. Oversize files report `transport.size-limit`;
/// unreadable paths report `transport.network-error` carrying only the OS
/// message (never the path text, which may name private directories).
fn fetch_local(uri: &str, limits: &FetchLimits) -> Result<FetchOutcome, NativeError> {
    let path = local_path_for_uri(uri)?;
    let body = std::fs::read(path).map_err(|e| {
        NativeError::new(
            "transport.network-error",
            format!("local file read failed: {e}"),
        )
    })?;
    if body.len() as u64 > limits.max_bytes {
        return Err(NativeError::new(
            "transport.size-limit",
            format!("local file exceeds {}-byte limit", limits.max_bytes),
        ));
    }
    Ok(FetchOutcome {
        status: 200,
        final_uri: uri.to_string(),
        body,
    })
}

fn fetch_once(
    agent: &ureq::Agent,
    request: &EffectiveRequest,
    limits: &FetchLimits,
    deadline: &Instant,
) -> Result<ureq::http::Response<ureq::Body>, NativeError> {
    let mut attempts = limits.retries.saturating_add(1);
    loop {
        attempts -= 1;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(NativeError::new(
                "transport.timeout",
                "fetch deadline exceeded",
            ));
        }
        let mut call = agent.get(&request.uri);
        for (name, value) in &request.headers {
            call = call.header(name.as_str(), value.as_str());
        }
        let result = call.config().timeout_global(Some(remaining)).build().call();
        match result {
            Ok(response) => return Ok(response),
            Err(ureq::Error::Timeout(_)) => {
                if attempts > 0 {
                    continue;
                }
                return Err(NativeError::new(
                    "transport.timeout",
                    "fetch request timed out",
                ));
            }
            Err(error) => {
                if attempts > 0 {
                    continue;
                }
                return Err(NativeError::new(
                    "transport.network-error",
                    format!("network failure: {error}"),
                ));
            }
        }
    }
}

fn read_body(
    response: ureq::http::Response<ureq::Body>,
    limits: &FetchLimits,
) -> Result<Vec<u8>, NativeError> {
    let body = response.into_parts().1;
    let mut reader = body.into_reader().take(limits.max_bytes.saturating_add(1));
    let mut body = Vec::new();
    reader.read_to_end(&mut body).map_err(|e| {
        NativeError::new("transport.network-error", format!("body read failed: {e}"))
    })?;
    if body.len() as u64 > limits.max_bytes {
        return Err(NativeError::new(
            "transport.size-limit",
            format!("response exceeds {}-byte limit", limits.max_bytes),
        ));
    }
    Ok(body)
}

fn resolve_redirect(base: &str, location: &str) -> Result<String, NativeError> {
    if location.is_empty() {
        return Err(NativeError::new("transport.bad-redirect", "empty location"));
    }
    let base = url::Url::parse(base)
        .map_err(|e| NativeError::new("transport.bad-url", format!("bad base url: {e}")))?;
    let next = base
        .join(location)
        .map_err(|e| NativeError::new("transport.bad-redirect", format!("bad location: {e}")))?;
    if matches!(next.scheme(), "http" | "https") && !next.cannot_be_a_base() {
        if next.username().is_empty() {
            Ok(next.to_string())
        } else {
            Err(NativeError::new(
                "transport.bad-redirect",
                "userinfo rejected",
            ))
        }
    } else {
        Err(NativeError::new(
            "transport.bad-redirect",
            "unsupported redirect scheme",
        ))
    }
}
