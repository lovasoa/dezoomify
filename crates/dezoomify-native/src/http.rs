//! Real HTTP egress for the native runtime: rustls-based blocking client,
//! manual redirects with per-URL header rebuild, size/time limits, and
//! bounded retries. This is the only place the CLI touches the network.

use std::collections::BTreeMap;
use std::io::Read;
use std::time::{Duration, Instant};

use crate::auth::EphemeralAuthorization;
use crate::client::{build_request, rebuild_for_redirect, EffectiveRequest};
use crate::error::NativeError;

/// Transport limits for one logical fetch (including its redirects).
#[derive(Clone, Debug)]
pub struct FetchLimits {
    pub max_bytes: u64,
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_redirects: usize,
    pub retries: u32,
}

impl Default for FetchLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 << 20,
            timeout: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(15),
            max_redirects: 5,
            retries: 1,
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
    auth: Option<&EphemeralAuthorization>,
    limits: &FetchLimits,
) -> Result<FetchOutcome, NativeError> {
    let mut request = build_request(uri, extra_headers, auth)?;
    let deadline = Instant::now() + limits.timeout;
    let mut redirects: usize = 0;
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(limits.connect_timeout)
        .build();
    loop {
        let response = fetch_once(&agent, &request, limits, &deadline)?;
        let is_redirect =
            REDIRECT_CODES.contains(&response.status()) && response.header("location").is_some();
        if !is_redirect {
            let status = response.status();
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
            .header("location")
            .ok_or_else(|| NativeError::new("transport.bad-redirect", "missing location"))?;
        let next = resolve_redirect(&request.uri, location)?;
        request = rebuild_for_redirect(&request, &next, auth)
            .map_err(|m| NativeError::new("transport.bad-redirect", m))?;
    }
}

fn fetch_once(
    agent: &ureq::Agent,
    request: &EffectiveRequest,
    limits: &FetchLimits,
    deadline: &Instant,
) -> Result<ureq::Response, NativeError> {
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
            call = call.set(name, value);
        }
        let result = call.timeout(remaining).call();
        match result {
            Ok(response) => return Ok(response),
            Err(ureq::Error::Status(_status, response)) => return Ok(response),
            Err(ureq::Error::Transport(transport)) => {
                if attempts > 0 {
                    continue;
                }
                return Err(NativeError::new(
                    "transport.network-error",
                    format!("network failure: {}", transport),
                ));
            }
        }
    }
}

fn read_body(response: ureq::Response, limits: &FetchLimits) -> Result<Vec<u8>, NativeError> {
    let mut reader = response
        .into_reader()
        .take(limits.max_bytes.saturating_add(1));
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
