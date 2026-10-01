use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::client::{build_request, rebuild_for_redirect, EffectiveRequest};
use crate::http::{FetchLimits, FetchOutcome, UserHeaders};
use dezoomify::model::{bounded_uri, Error, ErrorTransport, Failure};

/// Local carrier enabling `?`-chaining from platform error types into the
/// pure domain [`Error`]: the orphan rule reserves those `From` conversions
/// for the domain crate, so each platform error type classifies itself here
/// once, preserves its cause chain in `detail`, and converts at the
/// boundary. Never flatten causes into display messages.
pub struct TransportError(pub Error);

impl From<reqwest::Error> for TransportError {
    fn from(error: reqwest::Error) -> Self {
        let detail = dezoomify::model::chain_text(&error);
        let error = if error.is_timeout() {
            Error::Timeout {
                transport: ErrorTransport::Native,
                failure: detail.into(),
            }
        } else if error.is_builder() {
            Error::BadUrl {
                failure: detail.into(),
            }
        } else {
            Error::NetworkFailure {
                transport: ErrorTransport::Native,
                failure: detail.into(),
            }
        };
        Self(error)
    }
}

impl From<url::ParseError> for TransportError {
    fn from(error: url::ParseError) -> Self {
        Self(Error::BadUrl {
            failure: dezoomify::model::chain_text(&error).into(),
        })
    }
}

impl From<reqwest::header::InvalidHeaderName> for TransportError {
    fn from(error: reqwest::header::InvalidHeaderName) -> Self {
        Self(Error::NetworkFailure {
            transport: ErrorTransport::Native,
            failure: dezoomify::model::chain_text(&error).into(),
        })
    }
}

impl From<reqwest::header::InvalidHeaderValue> for TransportError {
    fn from(error: reqwest::header::InvalidHeaderValue) -> Self {
        Self(Error::NetworkFailure {
            transport: ErrorTransport::Native,
            failure: dezoomify::model::chain_text(&error).into(),
        })
    }
}

impl From<std::io::Error> for TransportError {
    fn from(error: std::io::Error) -> Self {
        Self(Error::NetworkFailure {
            transport: ErrorTransport::Native,
            failure: dezoomify::model::chain_text(&error).into(),
        })
    }
}

impl From<TransportError> for Error {
    fn from(error: TransportError) -> Self {
        error.0
    }
}

/// Redirect statuses followed manually, one hop at a time, so every hop can
/// revalidate the target and rescope credentials.
const REDIRECT_CODES: [u16; 6] = [301, 302, 303, 307, 308, 300];

/// Idle connections are kept per host for 15 s, matching the documented
/// native keep-alive behavior.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Worker threads multiplexing sockets for one invocation.
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
    pub fn new(limits: &FetchLimits) -> Result<Self, Error> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(RUNTIME_WORKERS)
            .thread_name("dezoomify-transport")
            .build()
            .map_err(|e| Error::Internal {
                failure: format!(
                    "transport runtime could not start: {}",
                    dezoomify::model::chain_text(&e)
                )
                .into(),
            })?;
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
        let client = builder.build().map_err(|e| Error::Internal {
            failure: format!(
                "transport client could not be built: {}",
                dezoomify::model::chain_text(&e)
            )
            .into(),
        })?;
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

    pub fn fetch(
        &self,
        uri: &str,
        extra_headers: &BTreeMap<String, String>,
        user: Option<&UserHeaders>,
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, Error> {
        self.runtime
            .block_on(self.fetch_async(uri, extra_headers, user, limits))
    }

    pub async fn fetch_resource(
        &self,
        request: &dezoomify::model::ResourceRequest,
        user: Option<&UserHeaders>,
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, Error> {
        let mut headers: BTreeMap<String, String> = dezoomify::default_headers()
            .into_iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value))
            .collect();
        for header in &request.headers {
            headers.insert(header.name.to_ascii_lowercase(), header.value.clone());
        }
        let started = Instant::now();
        let result = self.fetch_async(&request.uri, &headers, user, limits).await;
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
                        facts["kind"] = "http-error".into();
                        DiagnosticLevel::Warn
                    }
                }
                Err(error) => {
                    diagnostics.count("request_failures", 1.0);
                    facts["kind"] = error.cause().kind().into();
                    facts["message"] = error.to_string().into();
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
        limits: &FetchLimits,
    ) -> Result<FetchOutcome, Error> {
        if !is_http_uri(uri) {
            return fetch_local(uri, limits);
        }
        let mut request = build_request(uri, extra_headers)?;
        reject_userinfo_uri(uri)?;
        if let Some(user) = user {
            user.apply(&mut request);
        }
        let deadline = Instant::now() + limits.timeout;
        fetch_loop(&self.client, request, user, limits, &deadline).await
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
/// rustls build).
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
fn reject_userinfo_uri(uri: &str) -> Result<(), Error> {
    let parsed = url::Url::parse(uri).map_err(TransportError::from)?;
    if !parsed.username().is_empty() {
        return Err(Error::BadUrl {
            failure: "userinfo rejected".to_string().into(),
        });
    }
    Ok(())
}

async fn fetch_loop(
    client: &reqwest::Client,
    mut request: EffectiveRequest,
    user: Option<&UserHeaders>,
    limits: &FetchLimits,
    deadline: &Instant,
) -> Result<FetchOutcome, Error> {
    let mut redirects: usize = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::Timeout {
                transport: ErrorTransport::Native,
                failure: Failure {
                    request: Some(bounded_uri(request.uri.clone())),
                    detail: Some("fetch deadline exceeded".into()),
                },
            });
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
            return Err(Error::RedirectLimit {
                max: u32::try_from(limits.max_redirects).unwrap_or(u32::MAX),
            });
        }
        redirects += 1;
        let next = resolve_redirect(&request.uri, &location.unwrap_or_default())?;
        request = rebuild_for_redirect(&request, &next);
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
) -> Result<reqwest::Response, Error> {
    let mut call = client.get(request.uri.as_str()).timeout(timeout);
    for (name, value) in &request.headers {
        let parsed_name: reqwest::header::HeaderName =
            name.parse().map_err(TransportError::from)?;
        let parsed_value: reqwest::header::HeaderValue =
            value.parse().map_err(TransportError::from)?;
        call = call.header(parsed_name, parsed_value);
    }
    Ok(call.send().await.map_err(TransportError::from)?)
}

/// Stream the body with a hard cap (`max_bytes + 1`): oversize responses fail
/// `transport.size-limit` without buffering the excess.
async fn read_body_capped(
    mut response: reqwest::Response,
    limits: &FetchLimits,
) -> Result<Vec<u8>, Error> {
    if let Some(declared) = response.content_length() {
        if declared > limits.max_bytes {
            return Err(Error::SizeLimit {
                max_bytes: limits.max_bytes,
            });
        }
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() as u64 > limits.max_bytes {
                    return Err(Error::SizeLimit {
                        max_bytes: limits.max_bytes,
                    });
                }
            }
            Ok(None) => break,
            Err(e) => {
                return Err(Error::NetworkFailure {
                    transport: ErrorTransport::Native,
                    failure: dezoomify::model::chain_text(&e).into(),
                });
            }
        }
    }
    Ok(body)
}

fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let seconds: u64 = value.trim().parse().ok()?;
    Some(seconds.saturating_mul(1000).min(300_000))
}

fn resolve_redirect(base: &str, location: &str) -> Result<String, Error> {
    if location.is_empty() {
        return Err(Error::BadRedirect {
            failure: "empty location".to_string().into(),
        });
    }
    let base = url::Url::parse(base).map_err(|e| Error::BadUrl {
        failure: dezoomify::model::chain_text(&e).into(),
    })?;
    let next = base.join(location).map_err(|e| Error::BadRedirect {
        failure: format!("bad location: {e}").into(),
    })?;
    if matches!(next.scheme(), "http" | "https") && !next.cannot_be_a_base() {
        if next.username().is_empty() {
            Ok(next.to_string())
        } else {
            Err(Error::BadRedirect {
                failure: "userinfo rejected".to_string().into(),
            })
        }
    } else {
        Err(Error::BadRedirect {
            failure: "unsupported redirect scheme".to_string().into(),
        })
    }
}

/// Map a non-HTTP URI to a filesystem path: `file://` URIs strip the scheme
/// (`file:///abs/path` and `file://localhost/abs/path` both name an absolute
/// path; any other `file://` host is rejected), while anything else is
/// already a local path and passes through unchanged.
fn local_path_for_uri(uri: &str) -> Result<&str, Error> {
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
        return Err(Error::BadUrl {
            failure: "file uri must name a local absolute path"
                .to_string()
                .into(),
        });
    }
    Ok(uri)
}

/// Read a local resource with the same outcome shape as an HTTP 200: the
/// final URI stays the input URI. Oversize files report `size-limit`;
/// unreadable paths report `network-failure` carrying only the OS message
/// (never the path text).
fn fetch_local(uri: &str, limits: &FetchLimits) -> Result<FetchOutcome, Error> {
    let path = local_path_for_uri(uri)?;
    let body = std::fs::read(path).map_err(|e| Error::NetworkFailure {
        transport: ErrorTransport::Native,
        failure: format!("local file read failed: {e}").into(),
    })?;
    if body.len() as u64 > limits.max_bytes {
        return Err(Error::SizeLimit {
            max_bytes: limits.max_bytes,
        });
    }
    Ok(FetchOutcome {
        content_type: None,
        status: 200,
        final_uri: uri.to_string(),
        body,
        retry_after_ms: None,
    })
}
