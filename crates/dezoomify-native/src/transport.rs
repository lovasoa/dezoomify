use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::auth::EphemeralAuthorization;
use crate::client::{build_request, rebuild_for_redirect, EffectiveRequest};
use crate::error::NativeError;
use crate::http::{FetchLimits, FetchOutcome, UserHeaders};

/// Redirect statuses followed manually, one hop at a time, so every hop can
/// revalidate the target and rescope credentials. Mirrors the previous
/// transport's list exactly (including `300`).
const REDIRECT_CODES: [u16; 6] = [301, 302, 303, 307, 308, 300];

/// Idle connections are kept per host for 15 s, matching the documented
/// native keep-alive behavior.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Worker threads driving sockets for one transport. Tile threads block on
/// their own threads; these workers only multiplex async I/O.
const RUNTIME_WORKERS: usize = 2;

/// One reusable HTTP scope: Tokio runtime plus a single connection-pooling
/// client. Create one per job attempt and share it for every fetch.
pub struct NativeTransport {
    pub(crate) diagnostics: Option<crate::diagnostics::Diagnostics>,
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
}

impl NativeTransport {
    /// Build a transport from the fetch limits. Timeouts, pool sizing, and
    /// the TLS hatch come from `limits`; per-fetch byte/deadline bounds stay
    /// per call so one transport serves a whole job.
    pub fn new(limits: &FetchLimits) -> Result<Self, NativeError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(RUNTIME_WORKERS)
            .thread_name("dezoomify-transport")
            .build()
            .map_err(|e| NativeError::new("native.internal", format!("transport runtime: {e}")))?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(limits.connect_timeout)
            .pool_idle_timeout(Some(POOL_IDLE_TIMEOUT))
            .pool_max_idle_per_host(limits.max_idle_per_host.max(1))
            .http1_only();
        if limits.tls.accept_invalid_certs {
            builder = builder.danger_accept_invalid_certs(true);
        } else {
            builder = builder.use_preconfigured_tls(tls_config());
        }
        let client = builder
            .build()
            .map_err(|e| NativeError::new("native.internal", format!("transport client: {e}")))?;
        Ok(Self {
            runtime,
            client,
            diagnostics: None,
        })
    }

    pub fn with_diagnostics(mut self, diagnostics: crate::diagnostics::Diagnostics) -> Self {
        self.diagnostics = Some(diagnostics);
        self
    }

    /// Ephemeral one-shot transport for out-of-band fetches (bulk-list reads).
    /// Hot paths must use a job-scoped transport so connections are reused.
    pub fn oneshot(limits: &FetchLimits) -> Result<Self, NativeError> {
        Self::new(limits)
    }

    pub fn fetch(
        &self,
        uri: &str,
        extra_headers: &BTreeMap<String, String>,
        user: Option<&UserHeaders>,
        auth: Option<&EphemeralAuthorization>,
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, NativeError> {
        self.runtime
            .block_on(self.fetch_async(uri, extra_headers, user, auth, limits))
    }

    pub async fn fetch_resource(
        &self,
        request: &dezoomify::model::ResourceRequest,
        user: Option<&UserHeaders>,
        auth: Option<&EphemeralAuthorization>,
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, NativeError> {
        let mut headers: BTreeMap<String, String> = dezoomify::default_headers()
            .into_iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value))
            .collect();
        for header in &request.headers {
            headers.insert(header.name.to_ascii_lowercase(), header.value.clone());
        }
        let started = Instant::now();
        let result = self
            .fetch_async(&request.uri, &headers, user, auth, limits)
            .await;
        if let Some(diagnostics) = &self.diagnostics {
            use dezoomify::model::DiagnosticLevel;
            diagnostics.count("requests", 1.0);
            let mut facts = serde_json::json!({"purpose": request.purpose, "url": request.uri, "transport": "native", "duration_ms": started.elapsed().as_secs_f64() * 1000.0});
            let level = match &result {
                Ok(outcome) => {
                    facts["http"] = outcome.status.into();
                    facts["final_url"] = outcome.final_uri.clone().into();
                    facts["bytes"] = outcome.body.len().into();
                    facts["content_type"] = serde_json::json!(outcome.content_type);
                    facts["retry_after_ms"] = serde_json::json!(outcome.retry_after_ms);
                    diagnostics.count("bytes_fetched", outcome.body.len() as f64);
                    if outcome.ok() {
                        if request.purpose == dezoomify::model::RequestPurpose::Metadata {
                            DiagnosticLevel::Debug
                        } else {
                            DiagnosticLevel::Trace
                        }
                    } else {
                        diagnostics.count("request_failures", 1.0);
                        facts["preview"] =
                            String::from_utf8_lossy(&outcome.body[..outcome.body.len().min(4096)])
                                .chars()
                                .take(300)
                                .collect::<String>()
                                .into();
                        facts["code"] = "TRANSPORT_HTTP_ERROR".into();
                        DiagnosticLevel::Warn
                    }
                }
                Err(error) => {
                    diagnostics.count("request_failures", 1.0);
                    facts["code"] = error.code.clone().into();
                    facts["message"] = error.message.clone().into();
                    DiagnosticLevel::Warn
                }
            };
            diagnostics.record(level, "request", facts);
        }
        result
    }

    /// Fetch readable bytes without blocking unrelated acquisitions.
    pub async fn fetch_async(
        &self,
        uri: &str,
        extra_headers: &BTreeMap<String, String>,
        user: Option<&UserHeaders>,
        auth: Option<&EphemeralAuthorization>,
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, NativeError> {
        if !is_http_uri(uri) {
            return fetch_local(uri, limits);
        }
        let mut request = build_request(uri, extra_headers, auth)?;
        reject_userinfo_uri(uri)?;
        if let Some(user) = user {
            user.apply(&mut request);
        }
        let deadline = Instant::now() + limits.timeout;
        fetch_loop(&self.client, request, auth, user, limits, &deadline).await
    }

    /// Block the calling (non-runtime) thread on one future. Never called
    /// from inside async tasks.
    pub fn block_on<F>(&self, future: F) -> F::Output
    where
        F: std::future::Future,
    {
        self.runtime.block_on(future)
    }
}

/// Mozilla roots plus the process-default provider (ring, per the workspace
/// rustls build): the same trust bundle the previous client used.
fn tls_config() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth()
}

fn is_http_uri(uri: &str) -> bool {
    uri.starts_with("http://") || uri.starts_with("https://")
}

/// Reject credential-bearing userinfo in the request URI itself, mirroring
/// the redirect-target rule.
fn reject_userinfo_uri(uri: &str) -> Result<(), NativeError> {
    let parsed = url::Url::parse(uri)
        .map_err(|e| NativeError::new("transport.bad-url", format!("bad url: {e}")))?;
    if !parsed.username().is_empty() {
        return Err(NativeError::new("transport.bad-url", "userinfo rejected"));
    }
    Ok(())
}

async fn fetch_loop(
    client: &reqwest::Client,
    mut request: EffectiveRequest,
    auth: Option<&EphemeralAuthorization>,
    user: Option<&UserHeaders>,
    limits: &FetchLimits,
    deadline: &Instant,
) -> Result<FetchOutcome, NativeError> {
    let mut redirects: usize = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(NativeError::new(
                "transport.timeout",
                "fetch deadline exceeded",
            ));
        }
        let response = fetch_once(client, &request, remaining).await?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !REDIRECT_CODES.contains(&status) || location.is_none() {
            let final_uri = request.uri.clone();
            let retry_after_ms = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_retry_after_ms);
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = if (200..300).contains(&status) {
                read_body_capped(response, limits).await?
            } else {
                read_error_prefix(response).await
            };
            return Ok(FetchOutcome {
                content_type,
                status,
                final_uri,
                body,
                retry_after_ms,
            });
        }
        if redirects >= limits.max_redirects {
            return Err(NativeError::new(
                "transport.redirect-limit",
                format!("redirect limit of {} exceeded", limits.max_redirects),
            ));
        }
        redirects += 1;
        let next = resolve_redirect(&request.uri, &location.unwrap_or_default())?;
        request = rebuild_for_redirect(&request, &next, auth)?;
        if let Some(user) = user {
            user.apply(&mut request);
        }
    }
}

// Diagnostic reads never replace an observed HTTP refusal with a body error.
async fn read_error_prefix(mut response: reqwest::Response) -> Vec<u8> {
    tokio::time::timeout(Duration::from_millis(500), async move {
        let mut prefix = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            let keep = chunk.len().min(4096 - prefix.len());
            prefix.extend_from_slice(&chunk[..keep]);
            if prefix.len() == 4096 {
                break;
            }
        }
        prefix
    })
    .await
    .unwrap_or_default()
}

async fn fetch_once(
    client: &reqwest::Client,
    request: &EffectiveRequest,
    timeout: Duration,
) -> Result<reqwest::Response, NativeError> {
    let mut call = client.get(request.uri.as_str()).timeout(timeout);
    for (name, value) in &request.headers {
        let parsed_name: reqwest::header::HeaderName = name
            .parse()
            .map_err(|_| NativeError::new("transport.network-error", "invalid request header"))?;
        let parsed_value: reqwest::header::HeaderValue = value
            .parse()
            .map_err(|_| NativeError::new("transport.network-error", "invalid request header"))?;
        call = call.header(parsed_name, parsed_value);
    }
    match call.send().await {
        Ok(response) => Ok(response),
        Err(error) if error.is_timeout() => Err(NativeError::new(
            "transport.timeout",
            "fetch request timed out",
        )),
        Err(error) if error.is_builder() => Err(NativeError::new(
            "transport.bad-url",
            "bad request url or header",
        )),
        Err(error) => Err(NativeError::new(
            "transport.network-error",
            format!("network failure: {error}"),
        )),
    }
}

/// Stream the body with a hard cap (`max_bytes + 1`): oversize responses fail
/// `transport.size-limit` without buffering the excess.
async fn read_body_capped(
    mut response: reqwest::Response,
    limits: &FetchLimits,
) -> Result<Vec<u8>, NativeError> {
    if let Some(declared) = response.content_length() {
        if declared > limits.max_bytes {
            return Err(NativeError::new(
                "transport.size-limit",
                format!("response exceeds {}-byte limit", limits.max_bytes),
            ));
        }
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() as u64 > limits.max_bytes {
                    return Err(NativeError::new(
                        "transport.size-limit",
                        format!("response exceeds {}-byte limit", limits.max_bytes),
                    ));
                }
            }
            Ok(None) => break,
            Err(e) => {
                return Err(NativeError::new(
                    "transport.network-error",
                    format!("body read failed: {e}"),
                ));
            }
        }
    }
    Ok(body)
}

fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let seconds: u64 = value.trim().parse().ok()?;
    Some(seconds.saturating_mul(1000).min(300_000))
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

/// Map a non-HTTP URI to a filesystem path: `file://` URIs strip the scheme
/// (`file:///abs/path` and `file://localhost/abs/path` both name an absolute
/// path; any other `file://` host is rejected), while anything else is
/// already a local path and passes through unchanged.
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

/// Read a local resource with the same outcome shape as an HTTP 200: the
/// final URI stays the input URI. Oversize files report
/// `transport.size-limit`; unreadable paths report `transport.network-error`
/// carrying only the OS message (never the path text).
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
        content_type: None,
        status: 200,
        final_uri: uri.to_string(),
        body,
        retry_after_ms: None,
    })
}
