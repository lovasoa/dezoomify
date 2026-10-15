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

/// Build one classified domain error carrying the preserved cause chain as
/// its failure detail: the single spelling of cause attachment across the
/// platform conversions below. Each conversion keeps its classification
/// (the chosen variant and its facts) visible at its call site.
fn caused(
    classify: impl FnOnce(Failure) -> Error,
    cause: &(dyn std::error::Error + 'static),
) -> TransportError {
    TransportError(classify(dezoomify::model::chain_text(cause).into()))
}

impl From<reqwest::Error> for TransportError {
    fn from(error: reqwest::Error) -> Self {
        caused(
            |failure| {
                if error.is_timeout() {
                    Error::Timeout {
                        transport: ErrorTransport::Native,
                        failure,
                    }
                } else if error.is_builder() {
                    Error::BadUrl(failure)
                } else {
                    Error::NetworkFailure {
                        transport: ErrorTransport::Native,
                        failure,
                    }
                }
            },
            &error,
        )
    }
}

impl From<url::ParseError> for TransportError {
    fn from(error: url::ParseError) -> Self {
        caused(Error::BadUrl, &error)
    }
}

impl From<reqwest::header::InvalidHeaderName> for TransportError {
    fn from(error: reqwest::header::InvalidHeaderName) -> Self {
        caused(
            |failure| Error::NetworkFailure {
                transport: ErrorTransport::Native,
                failure,
            },
            &error,
        )
    }
}

impl From<reqwest::header::InvalidHeaderValue> for TransportError {
    fn from(error: reqwest::header::InvalidHeaderValue) -> Self {
        caused(
            |failure| Error::NetworkFailure {
                transport: ErrorTransport::Native,
                failure,
            },
            &error,
        )
    }
}

impl From<std::io::Error> for TransportError {
    fn from(error: std::io::Error) -> Self {
        caused(
            |failure| Error::NetworkFailure {
                transport: ErrorTransport::Native,
                failure,
            },
            &error,
        )
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
            .map_err(|e| {
                Error::Internal(
                    format!(
                        "transport runtime could not start: {}",
                        dezoomify::model::chain_text(&e)
                    )
                    .into(),
                )
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
        let client = builder.build().map_err(|e| {
            Error::Internal(
                format!(
                    "transport client could not be built: {}",
                    dezoomify::model::chain_text(&e)
                )
                .into(),
            )
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
        reject_duplicate_ranges(request.headers.iter().map(|header| header.name.as_str()))?;
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
        reject_duplicate_ranges(extra_headers.keys().map(String::as_str))?;
        if !is_http_uri(uri) {
            let range = extra_headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("range"))
                .map(|(_, value)| ByteRange::parse(value))
                .transpose()?;
            return fetch_local(uri, range, limits);
        }
        let mut request = build_request(uri, extra_headers)?;
        reject_userinfo_uri(uri)?;
        if let Some(user) = user {
            user.apply(&mut request);
        }
        if extra_headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("range"))
            .is_some_and(|(_, range)| request.headers.get("range") != Some(range))
        {
            return Err(Error::BadUrl(
                "user Range header conflicts with the resource byte range".into(),
            ));
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

fn reject_duplicate_ranges<'a>(names: impl Iterator<Item = &'a str>) -> Result<(), Error> {
    if names
        .filter(|name| name.eq_ignore_ascii_case("range"))
        .take(2)
        .count()
        > 1
    {
        return Err(Error::BadUrl(
            "expected at most one Range request header".into(),
        ));
    }
    Ok(())
}

/// Reject credential-bearing userinfo in the request URI itself, matching
/// the redirect-target rule.
fn reject_userinfo_uri(uri: &str) -> Result<(), Error> {
    let parsed = url::Url::parse(uri).map_err(TransportError::from)?;
    if !parsed.username().is_empty() {
        return Err(Error::BadUrl("userinfo rejected".to_string().into()));
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
        let range = request
            .headers
            .get("range")
            .map(|value| ByteRange::parse(value))
            .transpose()?;
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
                if let Some(range) = range {
                    range.validate_response(status, response.headers(), &final_uri)?;
                }
                read_body_capped(response, limits, range.map(ByteRange::len), &final_uri).await?
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

/// Container readers request one finite interval and receive only those bytes.
#[derive(Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn parse(value: &str) -> Result<Self, Error> {
        let parse = || {
            let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
            let (start, end) = (decimal(start)?, decimal(end)?);
            end.checked_sub(start)?.checked_add(1)?;
            Some(Self { start, end })
        };
        parse()
            .ok_or_else(|| Error::BadUrl("expected one finite byte range (bytes=start-end)".into()))
    }

    fn len(self) -> u64 {
        self.end - self.start + 1
    }

    fn validate_response(
        self,
        status: u16,
        headers: &reqwest::header::HeaderMap,
        uri: &str,
    ) -> Result<(), Error> {
        let content_range = headers
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let valid = status == 206
            && headers
                .get_all(reqwest::header::CONTENT_RANGE)
                .iter()
                .count()
                == 1
            && content_range
                .strip_prefix("bytes ")
                .and_then(|value| value.split_once('/'))
                .is_some_and(|(interval, total)| {
                    Self::parse(&format!("bytes={interval}"))
                        .is_ok_and(|range| range.start == self.start && range.end == self.end)
                        && decimal(total).is_some_and(|total| total > self.end)
                });
        if !valid {
            return Err(range_response_error(
                uri,
                &format!("expected HTTP 206 and Content-Range for bytes={}-{}; received HTTP {status}, Content-Range: {}", self.start, self.end, content_range.chars().take(256).collect::<String>()),
            ));
        }
        Ok(())
    }
}

fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn range_response_error(uri: &str, detail: &str) -> Error {
    Error::BadUrl(Failure {
        request: Some(bounded_uri(uri.to_owned())),
        detail: Some(detail.to_owned()),
    })
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

/// Stream within the resource cap and any declared byte interval, rejecting
/// excess bytes before retaining them.
async fn read_body_capped(
    mut response: reqwest::Response,
    limits: &FetchLimits,
    range_length: Option<u64>,
    uri: &str,
) -> Result<Vec<u8>, Error> {
    if let Some(declared) = response.content_length() {
        if range_length.is_some_and(|length| length != declared) {
            return Err(range_response_error(
                uri,
                "byte range body length does not match the requested range",
            ));
        }
        if declared > limits.max_bytes {
            return Err(Error::SizeLimit {
                max_bytes: limits.max_bytes,
            });
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(TransportError::from)? {
        let received = (body.len() as u64).saturating_add(chunk.len() as u64);
        if range_length.is_some_and(|length| received > length) {
            return Err(range_response_error(
                uri,
                "byte range body length exceeds the requested range",
            ));
        }
        if received > limits.max_bytes {
            return Err(Error::SizeLimit {
                max_bytes: limits.max_bytes,
            });
        }
        body.extend_from_slice(&chunk);
    }
    if range_length.is_some_and(|length| body.len() as u64 != length) {
        return Err(range_response_error(
            uri,
            "byte range body length does not match the requested range",
        ));
    }
    Ok(body)
}

fn parse_retry_after_ms(value: &str) -> Option<u64> {
    let seconds: u64 = value.trim().parse().ok()?;
    Some(seconds.saturating_mul(1000).min(300_000))
}

fn resolve_redirect(base: &str, location: &str) -> Result<String, Error> {
    if location.is_empty() {
        return Err(Error::BadRedirect("empty location".to_string().into()));
    }
    let base = url::Url::parse(base)
        .map_err(|e| Error::BadUrl(dezoomify::model::chain_text(&e).into()))?;
    let next = base
        .join(location)
        .map_err(|e| Error::BadRedirect(format!("bad location: {e}").into()))?;
    if matches!(next.scheme(), "http" | "https") && !next.cannot_be_a_base() {
        if next.username().is_empty() {
            Ok(next.to_string())
        } else {
            Err(Error::BadRedirect("userinfo rejected".to_string().into()))
        }
    } else {
        Err(Error::BadRedirect(
            "unsupported redirect scheme".to_string().into(),
        ))
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
        return Err(Error::BadUrl(
            "file uri must name a local absolute path"
                .to_string()
                .into(),
        ));
    }
    Ok(uri)
}

/// Read a local resource or seek to one finite byte interval; the final URI
/// stays the input URI. Oversize resources report `size-limit`;
/// unreadable paths report `network-failure` carrying only the OS message
/// (never the path text).
fn fetch_local(
    uri: &str,
    range: Option<ByteRange>,
    limits: &FetchLimits,
) -> Result<FetchOutcome, Error> {
    use std::io::{Read, Seek, SeekFrom};
    let path = local_path_for_uri(uri)?;
    let local_error = |e| Error::NetworkFailure {
        transport: ErrorTransport::Native,
        failure: format!("local file read failed: {e}").into(),
    };
    let mut file = std::fs::File::open(path).map_err(local_error)?;
    let file_len = file.metadata().map_err(local_error)?.len();
    if range.is_some_and(|range| range.end >= file_len) {
        return Err(range_response_error(
            uri,
            "requested byte range exceeds the local file",
        ));
    }
    let length = range.map_or(file_len, ByteRange::len);
    if length > limits.max_bytes {
        return Err(Error::SizeLimit {
            max_bytes: limits.max_bytes,
        });
    }
    if let Some(range) = range {
        file.seek(SeekFrom::Start(range.start))
            .map_err(local_error)?;
    }
    let mut body = Vec::new();
    file.take(range.map_or(limits.max_bytes.saturating_add(1), ByteRange::len))
        .read_to_end(&mut body)
        .map_err(local_error)?;
    if body.len() as u64 > limits.max_bytes {
        return Err(Error::SizeLimit {
            max_bytes: limits.max_bytes,
        });
    }
    if range.is_some() && body.len() as u64 != length {
        return Err(range_response_error(
            uri,
            "local file ended before the requested bytes were read",
        ));
    }
    Ok(FetchOutcome {
        content_type: None,
        status: if range.is_some() { 206 } else { 200 },
        final_uri: uri.to_string(),
        body,
        retry_after_ms: None,
    })
}
