//! Deterministic loopback fixture server.
//!
//! Loads every `testdata/scenarios/*/routes.json` plus referenced payloads and
//! serves them by exact method/host/path match. No public network access is
//! possible by construction: unknown resources get a stable fixture-missing
//! response and there is no passthrough mode.

mod arts;
mod routes;
mod svg;

pub use routes::{RouteTable, ScenarioRoute};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub routes: Arc<RouteTable>,
    pub scenarios_dir: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub origin: String,
    pub log: Arc<Mutex<Vec<serde_json::Value>>>,
    pub log_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct FetchParams {
    url: String,
}

pub fn router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/fetch", any(handle_fetch))
        .route("/proxy", any(handle_proxy))
        .route("/", any(handle_static))
        .route("/{*path}", any(handle_static))
        .with_state(state)
}

fn cors_headers(map: &mut HeaderMap) {
    // Test-only deterministic origin emulator on loopback: permissive CORS
    // is intentional so same-server fixtures can exercise both readable
    // (`cors-readable`) and denied (`cors-denied-*`) paths per-route.
    // This is NOT the website metadata CORS proxy (phase 09 owns its
    // restrictive CORS, SSRF, and credential policy).
    map.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    map.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("X-Set-Cookie"),
    );
}

/// Redact credential-bearing URL parts before request-log persistence or
/// error-body echo. Strips userinfo and replaces sensitive query values.
fn redact_url_for_log(original: &str) -> String {
    let Some(without_scheme) = original
        .strip_prefix("http://")
        .or_else(|| original.strip_prefix("https://"))
    else {
        return "invalid-url".to_string();
    };
    let (authority, path_query) = match without_scheme.find('/') {
        Some(i) => (&without_scheme[..i], &without_scheme[i..]),
        None => (without_scheme, "/"),
    };
    let host = authority.rsplit(':').next().unwrap_or(authority);
    let (path, query) = match path_query.find('?') {
        Some(i) => (&path_query[..i], Some(&path_query[i + 1..])),
        None => (path_query, None),
    };
    let redacted_query = query.map(|q| {
        q.split('&')
            .map(|pair| {
                let (k, _) = pair.split_once('=').unwrap_or((pair, ""));
                let lower = k.to_ascii_lowercase();
                if [
                    "apikey",
                    "api_key",
                    "token",
                    "auth",
                    "session",
                    "signature",
                    "secret",
                    "password",
                    "cookie",
                ]
                .iter()
                .any(|n| lower.contains(n))
                {
                    format!("{k}=REDACTED")
                } else {
                    pair.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("&")
    });
    match redacted_query {
        Some(q) if !q.is_empty() => format!("{host}{path}?{q}"),
        _ => format!("{host}{path}"),
    }
}

fn record(state: &AppState, entry: serde_json::Value) {
    let mut log = state.log.lock().expect("request log lock");
    log.push(entry);
    if let Some(path) = &state.log_path {
        let mut text = String::new();
        for e in log.iter() {
            text.push_str(&serde_json::to_string(e).expect("log serialize"));
            text.push('\n');
        }
        let _ = std::fs::write(path, text);
    }
}

async fn handle_fetch(
    State(state): State<AppState>,
    method: Method,
    Query(params): Query<FetchParams>,
) -> Response {
    serve_original_url(&state, &method, &params.url, "fetch").await
}

async fn handle_proxy(
    State(state): State<AppState>,
    method: Method,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(target) = params.get("url") else {
        return text_response(StatusCode::BAD_REQUEST, "missing url", false);
    };
    serve_original_url(&state, &method, target, "proxy").await
}

async fn serve_original_url(
    state: &AppState,
    method: &Method,
    original: &str,
    via: &str,
) -> Response {
    if *method != Method::GET && *method != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed", false);
    }
    let head_only = *method == Method::HEAD;
    if let Some(data) = original.strip_prefix("data:") {
        // Legacy-compatible data: targets (used by proxy contract checks).
        let (meta, payload) = data.split_once(',').unwrap_or(("", data));
        let (mime, is_b64) = match meta.split_once(';') {
            Some((m, _)) => (if m.is_empty() { "text/plain" } else { m }, true),
            None => (if meta.is_empty() { "text/plain" } else { meta }, false),
        };
        let bytes = if is_b64 {
            match base64_body(payload) {
                Some(b) => b,
                None => {
                    record(
                        state,
                        serde_json::json!({"via": via, "url": "data:<redacted>", "status": 400, "route": "data"}),
                    );
                    return text_response(StatusCode::BAD_REQUEST, "bad data url", head_only);
                }
            }
        } else {
            payload.as_bytes().to_vec()
        };
        record(
            state,
            serde_json::json!({"via": via, "url": "data:<redacted>", "status": 200, "route": "data"}),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_str(mime).unwrap_or(HeaderValue::from_static("text/plain")),
        );
        return bytes_response(200, headers, bytes, head_only);
    }
    let parsed = match url_parts(original) {
        Some(p) => p,
        None => {
            record(
                state,
                serde_json::json!({"via": via, "url": redact_url_for_log(original), "status": 400, "route": null}),
            );
            return text_response(StatusCode::BAD_REQUEST, "bad url", head_only);
        }
    };
    match state
        .routes
        .lookup(&parsed.method_host(), &parsed.path, parsed.query.as_deref())
    {
        Some(hit) => {
            let body = match hit.route.render(state, hit.scenario, &parsed) {
                Ok(b) => b,
                Err(status) => {
                    record(
                        state,
                        serde_json::json!({"via": via, "url": redact_url_for_log(original), "status": status.as_u16(), "route": hit.route.route_id, "scenario": hit.scenario}),
                    );
                    return text_response(status, "fixture error", head_only);
                }
            };
            record(
                state,
                serde_json::json!({"via": via, "url": redact_url_for_log(original), "status": hit.route.status, "route": hit.route.route_id, "scenario": hit.scenario}),
            );
            bytes_response(hit.route.status, body.headers, body.bytes, head_only)
        }
        None => {
            record(
                state,
                serde_json::json!({"via": via, "url": redact_url_for_log(original), "status": 404, "route": null}),
            );
            let mut map = HeaderMap::new();
            cors_headers(&mut map);
            map.insert("content-type", HeaderValue::from_static("application/json"));
            // Never echo the full attacker URL cross-origin; log redacted host+path only.
            let body = serde_json::json!({"error": "fixture-missing", "url": redact_url_for_log(original)}).to_string();
            bytes_response(404, map, body.into_bytes(), head_only)
        }
    }
}

pub struct UrlParts {
    host: String,
    #[allow(dead_code)]
    port: Option<u16>,
    path: String,
    query: Option<String>,
}

impl UrlParts {
    fn method_host(&self) -> String {
        self.host.clone()
    }
}

fn base64_body(input: &str) -> Option<Vec<u8>> {
    let mut vals = Vec::with_capacity(input.len());
    for b in input.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        vals.push(v);
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        let mut n: u32 = 0;
        for (i, v) in chunk.iter().enumerate() {
            n |= (*v as u32) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

fn url_parts(original: &str) -> Option<UrlParts> {
    let rest = original
        .strip_prefix("http://")
        .or_else(|| original.strip_prefix("https://"))?;
    let (authority, path_query) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains(' ') || authority.contains('@') {
        return None;
    }
    // Match routes on hostname only: ephemeral test ports must not affect
    // fixture identity (mirrors legacy hostname-based lookup).
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            (h.to_lowercase(), p.parse::<u16>().ok())
        }
        _ => (authority.to_lowercase(), None),
    };
    if host.is_empty() {
        return None;
    }
    let (path, query) = match path_query.find('?') {
        Some(i) => (
            path_query[..i].to_string(),
            Some(path_query[i + 1..].to_string()),
        ),
        None => (path_query.to_string(), None),
    };
    if path.contains("..") {
        return None;
    }
    Some(UrlParts {
        host,
        port,
        path,
        query,
    })
}

pub struct Rendered {
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}

fn bytes_response(
    status: u16,
    mut headers: HeaderMap,
    bytes: Vec<u8>,
    head_only: bool,
) -> Response {
    cors_headers(&mut headers);
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    (status, headers, body).into_response()
}

fn text_response(status: StatusCode, text: &str, head_only: bool) -> Response {
    let mut headers = HeaderMap::new();
    cors_headers(&mut headers);
    headers.insert("content-type", HeaderValue::from_static("text/plain"));
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(text.to_string())
    };
    (status, headers, body).into_response()
}

async fn handle_static(
    State(state): State<AppState>,
    method: Method,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "method not allowed", false);
    }
    let head_only = method == Method::HEAD;
    let Some(dir) = &state.static_dir else {
        return text_response(StatusCode::NOT_FOUND, "not found", head_only);
    };
    let rel = if path.is_empty() {
        "index.html".to_string()
    } else {
        path
    };
    if rel.contains("..") {
        return text_response(StatusCode::FORBIDDEN, "forbidden", head_only);
    }
    let full = dir.join(&rel);
    // Canonical-prefix traversal guard (symlink-aware): the joined path must
    // remain under the canonical static dir.
    let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let canonical_full = full.canonicalize().unwrap_or_else(|_| full.clone());
    // For not-yet-existing paths canonicalize fails; fall back to lexical
    // check plus prefix comparison on the joined path.
    if canonical_full != full && !canonical_full.starts_with(&canonical_dir)
        || !full.starts_with(dir)
    {
        return text_response(StatusCode::FORBIDDEN, "forbidden", head_only);
    }
    let full = if full.is_dir() {
        full.join("index.html")
    } else {
        full
    };
    match std::fs::read(&full) {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            let ctype = content_type(full.extension().and_then(|e| e.to_str()).unwrap_or(""));
            headers.insert("content-type", HeaderValue::from_str(ctype).expect("ctype"));
            bytes_response(200, headers, bytes, head_only)
        }
        Err(_) => text_response(StatusCode::NOT_FOUND, "not found", head_only),
    }
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html",
        "js" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "xml" | "dzi" => "text/xml",
        "txt" => "text/plain",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}
