//! Deterministic loopback fixture server.
//!
//! Loads every `testdata/scenarios/*/routes.json` plus referenced payloads and
//! serves them by exact method/host/path match. The directory mirror is the
//! default route table: a payload at `payloads/{host}{url-path}` serves at
//! `{host}{url-path}` with a type inferred from its extension, so `routes.json`
//! only spells out exceptions. No public network access is
//! possible by construction: unknown resources get a stable fixture-missing
//! response and there is no passthrough mode.

mod arts;
mod b64;
mod routes;
mod svg;

pub use routes::{derive_route_id, Lookup, RouteTable, ScenarioRoute};

use axum::body::Body;
use axum::extract::{Path, Query, State};
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
        // Test-only discovery path: the outer path can carry the original
        // fixture URL, so URL-shape discovery sees its real suffix. A `url`
        // query remains supported and takes precedence for existing tests.
        .route("/fetch/{*path}", any(handle_fetch_path))
        .route("/proxy", any(handle_proxy))
        .route("/", any(handle_static_root))
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

/// One gateway request's context: method, headers, original URL, and route
/// flavor (`fetch` gateway or `proxy`).
#[derive(Clone, Copy)]
struct Call<'a> {
    method: &'a Method,
    headers: &'a HeaderMap,
    original: &'a str,
    via: &'a str,
}

async fn handle_fetch(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Query(params): Query<FetchParams>,
) -> Response {
    serve_original_url(
        &state,
        Call {
            method: &method,
            headers: &headers,
            original: &params.url,
            via: "fetch",
        },
    )
    .await
}

async fn handle_fetch_path(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    (Path(path), Query(params)): (Path<String>, Query<HashMap<String, String>>),
) -> Response {
    let original = params
        .get("url")
        .map(String::as_str)
        .unwrap_or(path.as_str());
    serve_original_url(
        &state,
        Call {
            method: &method,
            headers: &headers,
            original,
            via: "fetch",
        },
    )
    .await
}

async fn handle_proxy(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(target) = params.get("url") else {
        return text_response(StatusCode::BAD_REQUEST, "missing url", false);
    };
    serve_original_url(
        &state,
        Call {
            method: &method,
            headers: &headers,
            original: target,
            via: "proxy",
        },
    )
    .await
}

async fn serve_original_url(state: &AppState, call: Call<'_>) -> Response {
    let Call {
        method,
        headers,
        original,
        via,
    } = call;
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
            match b64::decode(payload) {
                Some(b) => b,
                None => {
                    record(
                        state,
                        serde_json::json!({"via": via, "url": original, "status": 400, "route": "data"}),
                    );
                    return text_response(StatusCode::BAD_REQUEST, "bad data url", head_only);
                }
            }
        } else {
            payload.as_bytes().to_vec()
        };
        record(
            state,
            serde_json::json!({"via": via, "url": original, "status": 200, "route": "data"}),
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
                serde_json::json!({"via": via, "url": original, "status": 400, "route": null}),
            );
            return text_response(StatusCode::BAD_REQUEST, "bad url", head_only);
        }
    };
    match state.routes.lookup(&Lookup {
        host: &parsed.method_host(),
        path: &parsed.path,
        query: parsed.query.as_deref(),
    }) {
        Some(hit) => {
            if let Some(cookie) = hit.route.missing_required_cookie(headers) {
                record(
                    state,
                    serde_json::json!({
                        "via": via,
                        "url": original,
                        "status": 403,
                        "route": hit.route.route_id,
                        "scenario": hit.scenario,
                        "auth": "missing-required-cookie",
                        "cookie_name": cookie,
                    }),
                );
                return text_response(
                    StatusCode::FORBIDDEN,
                    &format!("fixture auth required: missing cookie {cookie}"),
                    head_only,
                );
            }
            if let Some(header) = hit.route.missing_required_header(headers, &state.origin) {
                record(
                    state,
                    serde_json::json!({"via": via, "url": original, "status": 403, "route": hit.route.route_id, "missing_header": header}),
                );
                return text_response(
                    StatusCode::FORBIDDEN,
                    &format!("fixture requires header {header}"),
                    head_only,
                );
            }
            let body = match hit.route.render(state, hit.scenario, &parsed) {
                Ok(b) => b,
                Err(status) => {
                    record(
                        state,
                        serde_json::json!({"via": via, "url": original, "status": status.as_u16(), "route": hit.route.route_id, "scenario": hit.scenario}),
                    );
                    return text_response(status, "fixture error", head_only);
                }
            };
            record(
                state,
                serde_json::json!({"via": via, "url": original, "status": hit.route.status, "route": hit.route.route_id, "scenario": hit.scenario}),
            );
            bytes_response(hit.route.status, body.headers, body.bytes, head_only)
        }
        None => {
            record(
                state,
                serde_json::json!({"via": via, "url": original, "status": 404, "route": null}),
            );
            let mut map = HeaderMap::new();
            cors_headers(&mut map);
            map.insert("content-type", HeaderValue::from_static("application/json"));
            let body = serde_json::json!({"error": "fixture-missing", "url": original}).to_string();
            bytes_response(404, map, body.into_bytes(), head_only)
        }
    }
}

pub struct UrlParts {
    host: String,
    // 6.1: `port` is parsed and retained so gateway URLs keep an
    // explicit non-default port through redirects; no route reads it
    // yet, which is why the field (not the parsing) is exempt.
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

/// One direct static request's context: method, path, headers, and raw
/// query text.
struct StaticRequest<'a> {
    method: Method,
    path: String,
    headers: &'a HeaderMap,
    query: axum::extract::RawQuery,
}

async fn handle_static_root(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
) -> Response {
    serve_static(
        &state,
        StaticRequest {
            method,
            path: String::new(),
            headers: &headers,
            query: raw_query,
        },
    )
    .await
}

async fn handle_static(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    (axum::extract::Path(path), raw_query): (axum::extract::Path<String>, axum::extract::RawQuery),
) -> Response {
    serve_static(
        &state,
        StaticRequest {
            method,
            path,
            headers: &headers,
            query: raw_query,
        },
    )
    .await
}

async fn serve_static(state: &AppState, request: StaticRequest<'_>) -> Response {
    let StaticRequest {
        method,
        path,
        headers,
        query: raw_query,
    } = request;
    let head_only = method == Method::HEAD;
    if method != Method::GET && method != Method::HEAD {
        return text_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "method not allowed",
            head_only,
        );
    }
    // Direct deterministic route serving (loopback only): scenario routes
    // with host `127.0.0.1` are servable without the `/fetch?url=` gateway,
    // so URL-shape discovery gates see the true path (`/zoomify/...`,
    // `/xl/*.imgi`, `/arcgis/MapServer`, ...) and tile URLs derived as
    // direct `{{origin}}/...` stay fetchable. Host matching ignores the
    // ephemeral port, mirroring the gateway path. Routes win over static
    // files (no `dist/` path collides with scenario tile paths); unknown
    // direct paths fall through to the static handler below, preserving
    // the stable `not found` contract.
    {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .map(|authority| match authority.rsplit_once(':') {
                Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
                _ => authority,
            })
            .unwrap_or("127.0.0.1")
            .to_lowercase();
        let full_path = if path.is_empty() {
            "/".to_string()
        } else {
            format!("/{path}")
        };
        let query = raw_query.0.clone();
        if let Some(hit) = state.routes.lookup(&Lookup {
            host: &host,
            path: &full_path,
            query: query.as_deref(),
        }) {
            let parts = UrlParts {
                host: host.clone(),
                port: None,
                path: full_path.clone(),
                query: query.clone(),
            };
            if let Some(cookie) = hit.route.missing_required_cookie(headers) {
                record(
                    state,
                    serde_json::json!({
                        "via": "direct",
                        "host": host,
                        "path": full_path,
                        "query": query,
                        "status": 403,
                        "route": hit.route.route_id,
                        "scenario": hit.scenario,
                        "auth": "missing-required-cookie",
                        "cookie_name": cookie,
                    }),
                );
                return text_response(
                    StatusCode::FORBIDDEN,
                    &format!("fixture auth required: missing cookie {cookie}"),
                    head_only,
                );
            }
            if let Some(header) = hit.route.missing_required_header(headers, &state.origin) {
                record(
                    state,
                    serde_json::json!({"via": "direct", "path": full_path, "status": 403, "route": hit.route.route_id, "missing_header": header}),
                );
                return text_response(
                    StatusCode::FORBIDDEN,
                    &format!("fixture requires header {header}"),
                    head_only,
                );
            }
            let body = match hit.route.render(state, hit.scenario, &parts) {
                Ok(b) => b,
                Err(status) => {
                    record(
                        state,
                        serde_json::json!({"via": "direct", "host": host, "path": full_path, "status": status.as_u16(), "route": hit.route.route_id, "scenario": hit.scenario}),
                    );
                    return text_response(status, "fixture error", head_only);
                }
            };
            record(
                state,
                serde_json::json!({"via": "direct", "host": host, "path": full_path, "query": query, "status": hit.route.status, "route": hit.route.route_id, "scenario": hit.scenario}),
            );
            return bytes_response(hit.route.status, body.headers, body.bytes, head_only);
        }
        // Log direct misses like gateway misses so hermetic E2E failures
        // name the unserved tile URL (the static fallback below still
        // returns the stable `not found` contract).
        record(
            state,
            serde_json::json!({"via": "direct", "host": host, "path": full_path, "query": query, "status": 404, "route": null}),
        );
    }
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
            let ctype = content_type(&full.to_string_lossy());
            headers.insert("content-type", HeaderValue::from_str(ctype).expect("ctype"));
            bytes_response(200, headers, bytes, head_only)
        }
        Err(_) => text_response(StatusCode::NOT_FOUND, "not found", head_only),
    }
}

/// Content type inferred from the final path segment's extension. The single
/// mapping for static files, mirrored payload routes, and the xtask fixture
/// tooling (capture), so none of them can drift from the others.
/// `.xml`/`.dzi` are `application/xml`, the convention documented in
/// `testdata/scenarios/README.md`.
pub fn content_type(path: &str) -> &'static str {
    let file = path.rsplit('/').next().unwrap_or(path);
    let ext = file.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "xml" | "dzi" => "application/xml",
        "txt" => "text/plain",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "yaml" | "yml" => "application/yaml",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Scenario corpus access: this test-tool crate owns testdata/scenarios.
// ---------------------------------------------------------------------------

/// The shared scenario corpus under `testdata/scenarios`.
#[must_use]
pub fn scenarios_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios")
}

/// One scenario's corpus entry: its documented `scenario.json` with the
/// `expected/result.json` golden attached under `expected`.
#[must_use]
pub fn scenario(id: &str) -> serde_json::Value {
    let dir = scenarios_dir().join(id);
    let mut entry: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("scenario.json")).expect("scenario"),
    )
    .expect("scenario json");
    entry["expected"] = serde_json::from_str(
        &std::fs::read_to_string(dir.join("expected/result.json")).expect("expected result"),
    )
    .expect("expected json");
    entry
}

/// One completed job as its golden records it. Each driver adapts its own
/// observation (native publication, CLI event JSON) into this shape once.
#[derive(Clone, Debug)]
pub struct GoldenResult {
    /// Assembled image size `(width, height)`.
    pub image_size: (u64, u64),
    /// Tiles the job acquired.
    pub tile_count: u64,
    /// Output format name as the model spells it (`png`, `jpeg`, ...).
    pub output_format: String,
    /// Whether the published output is partial.
    pub partial: bool,
}

/// Success-golden mismatches: image size, tile count, output format, and
/// (when the golden pins one) the partial disposition and the `ok` code.
/// Empty when the run matches its golden. `recovery` in success goldens
/// documents the mechanism in prose and is never a typed fact.
#[must_use]
pub fn result_golden_mismatches(entry: &serde_json::Value, result: &GoldenResult) -> Vec<String> {
    let id = entry["id"].as_str().unwrap_or("<scenario>");
    let golden = &entry["expected"];
    let mut mismatches = Vec::new();
    let width = golden["imageSize"]["x"].as_u64().expect("golden width");
    let height = golden["imageSize"]["y"].as_u64().expect("golden height");
    if result.image_size != (width, height) {
        mismatches.push(format!(
            "{id} image size: {:?} != golden ({width}, {height})",
            result.image_size
        ));
    }
    let tile_count = golden["tileCount"].as_u64().expect("golden tile count");
    if result.tile_count != tile_count {
        mismatches.push(format!(
            "{id} tile count: {} != golden {tile_count}",
            result.tile_count
        ));
    }
    let format = golden["outputFormat"].as_str().expect("golden format");
    if result.output_format != format {
        mismatches.push(format!(
            "{id} output format: {} != golden {format}",
            result.output_format
        ));
    }
    if let Some(partial) = golden.get("partial") {
        if partial.as_bool() != Some(result.partial) {
            mismatches.push(format!(
                "{id} partial disposition: {} != golden {partial}",
                result.partial
            ));
        }
    }
    if let Some(code) = golden.get("code") {
        if code != "ok" {
            mismatches.push(format!("{id} success outcome: golden code {code} != ok"));
        }
    }
    mismatches
}

/// Failure-golden mismatches: the run failed and the golden's `code`
/// records the typed error's stable kind (the same identifier the CLI
/// human line prints). `underlying`/`note`/`recovery` are documentation
/// prose, never typed facts.
#[must_use]
pub fn failure_golden_mismatches(entry: &serde_json::Value, kind: &str) -> Vec<String> {
    let id = entry["id"].as_str().unwrap_or("<scenario>");
    let golden = &entry["expected"];
    let mut mismatches = Vec::new();
    if golden["outcome"].as_str() != Some("failed") {
        mismatches.push(format!(
            "{id} outcome: golden pins a failure, found {}",
            golden["outcome"]
        ));
    }
    if golden["code"].as_str().unwrap_or_default() != kind {
        mismatches.push(format!("{id} code: {kind} != golden {}", golden["code"]));
    }
    mismatches
}

/// Assert [`result_golden_mismatches`] is empty. Drivers that report a
/// batch of scenarios at once call the mismatch form and collect.
pub fn assert_result_golden(entry: &serde_json::Value, result: GoldenResult) {
    let mismatches = result_golden_mismatches(entry, &result);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// Assert [`failure_golden_mismatches`] is empty.
pub fn assert_failure_golden(entry: &serde_json::Value, kind: &str) {
    let mismatches = failure_golden_mismatches(entry, kind);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
