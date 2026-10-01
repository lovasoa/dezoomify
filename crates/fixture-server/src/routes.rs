//! Scenario route table: loading, matching, and payload rendering.

use axum::http::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

fn default_method() -> String {
    "GET".to_string()
}

fn default_status() -> u16 {
    200
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScenarioRoute {
    /// Optional: derived from the host/path when omitted. Routes are almost
    /// always `GET`, a `200`, and a file served at `payloads/{host}{path}`;
    /// only the interesting exceptions spell these out.
    #[serde(default)]
    pub route_id: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub path_regex: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default = "default_status")]
    pub status: u16,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Cookie name/value pairs required before this route serves its payload.
    /// The fixture server evaluates this condition without logging request
    /// cookie values, so browser-session tests can assert outcomes only.
    #[serde(default)]
    pub required_cookies: HashMap<String, String>,
    /// Exact request headers required for session/referrer regression fixtures.
    #[serde(default)]
    pub required_headers: HashMap<String, String>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub generator: Option<GeneratorSpec>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum GeneratorSpec {
    #[serde(rename = "arts-tile")]
    ArtsTile { image: String },
    /// Verifies the Google Arts tile signature of the request path and serves
    /// the stored bytes verbatim (still encrypted): the client-side wasm
    /// pipeline owns the decryption, as it does in production.
    #[serde(rename = "arts-signed-tile")]
    ArtsSignedTile { image: String },
    #[serde(rename = "generic-svg")]
    GenericSvg { shape: String },
    #[serde(rename = "assembly-tile")]
    AssemblyTile,
    #[serde(rename = "jpeg-stub")]
    JpegStub { image: String },
    #[serde(rename = "generic-jpg")]
    GenericJpg { image: String },
}

#[derive(Debug, Deserialize)]
struct RoutesFile {
    routes: Vec<ScenarioRoute>,
}

pub struct RouteHit<'a> {
    pub scenario: &'a str,
    pub route: &'a ScenarioRoute,
}

pub struct RouteTable {
    entries: Vec<(String, ScenarioRoute, Option<regex::Regex>)>,
}

pub struct RenderedRoute {
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
}

/// Canonical route-id derivation, shared by the server (derived ids for logs
/// and error messages), the xtask fixture tooling (duplicate detection and
/// capture), so the three cannot drift from one another. Stable and
/// human-readable: lowercase ASCII alphanumerics with runs of anything else
/// collapsed to a single dash, trimmed, and truncated to 100 characters.
pub fn derive_route_id(host: &str, target: &str) -> String {
    let mut id = String::new();
    for ch in format!("{host}-{target}").chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else if !id.is_empty() && !id.ends_with('-') {
            id.push('-');
        }
    }
    while id.ends_with('-') {
        id.pop();
    }
    if id.is_empty() {
        return "route".to_string();
    }
    id.chars().take(100).collect()
}

/// Directory-mirror convention: any payload laid out as
/// `{scenario}/payloads/{host}/{url-path}` is served at `{host}{url-path}`
/// unless an explicit route already claims it. A fixture that follows the
/// layout needs no `routes.json` entry at all.
fn mirror_routes(
    scenarios_dir: &Path,
    claimed: &HashSet<(String, String)>,
    served: &HashSet<(String, String, String)>,
) -> Result<Vec<(String, ScenarioRoute, Option<regex::Regex>)>, String> {
    let mut payloads = Vec::new();
    collect_payloads(scenarios_dir, scenarios_dir, &mut payloads)?;
    payloads.sort();
    let mut routes = Vec::new();
    let mut mirrored: HashSet<(String, String)> = HashSet::new();
    for (scenario, payload) in payloads {
        if claimed.contains(&(scenario.clone(), payload.clone())) {
            continue;
        }
        let Some(rest) = payload.strip_prefix("payloads/") else {
            continue;
        };
        let Some((host, tail)) = rest.split_once('/') else {
            continue;
        };
        if host.is_empty() || tail.is_empty() || rest.contains("..") {
            continue;
        }
        let url_path = format!("/{tail}");
        if served.contains(&(host.to_string(), url_path.clone(), "GET".to_string()))
            || !mirrored.insert((host.to_string(), url_path.clone()))
        {
            continue;
        }
        let mut headers = HashMap::new();
        headers.insert(
            "Content-Type".to_string(),
            super::content_type(&url_path).to_string(),
        );
        routes.push((
            scenario,
            ScenarioRoute {
                route_id: format!("mirror-{host}-{tail}"),
                method: "GET".to_string(),
                host: Some(host.to_string()),
                path: Some(url_path),
                path_prefix: None,
                path_regex: None,
                query: None,
                status: 200,
                headers,
                required_cookies: HashMap::new(),
                required_headers: HashMap::new(),
                payload: Some(payload),
                generator: None,
            },
            None,
        ));
    }
    Ok(routes)
}

fn collect_payloads(
    base: &Path,
    dir: &Path,
    out: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<_> = entries
        .map(|e| e.map_err(|e| format!("dir entry: {e}")))
        .collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_payloads(base, &path, out)?;
        } else {
            // Normalize to `/` so the `{scenario}/payloads/{host}/{path}`
            // convention matches on Windows, where `strip_prefix` yields `\`.
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip prefix: {e}"))?
                .to_str()
                .ok_or("non-utf8 payload path")?
                .replace('\\', "/");
            if let Some(idx) = rel.find("/payloads/") {
                out.push((rel[..idx].to_string(), rel[idx + 1..].to_string()));
            }
        }
    }
    Ok(())
}

impl RouteTable {
    /// Number of loaded route entries, for startup diagnostics.
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Unique scenario ids backing the loaded routes, for startup diagnostics.
    pub fn scenario_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.entries.iter().map(|(id, _, _)| id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    pub fn load(scenarios_dir: &Path) -> Result<Self, String> {
        // Discover scenario dirs by walking for routes.json files; the manifest
        // is a verification artifact, not the load list.
        let mut dirs: Vec<(String, std::path::PathBuf)> = Vec::new();
        let mut stack = vec![scenarios_dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let entries =
                std::fs::read_dir(&d).map_err(|e| format!("cannot list {}: {e}", d.display()))?;
            let mut entries: Vec<_> = entries
                .map(|e| e.map_err(|e| format!("dir entry: {e}")))
                .collect::<Result<_, _>>()?;
            entries.sort_by_key(|e| e.path());
            for entry in entries {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("routes.json") {
                    let dir = path.parent().expect("parent").to_path_buf();
                    let rel = dir
                        .strip_prefix(scenarios_dir)
                        .map_err(|e| format!("strip prefix: {e}"))?
                        .to_str()
                        .ok_or("non-utf8 scenario dir")?
                        .to_string();
                    dirs.push((rel, dir));
                }
            }
        }
        dirs.sort();
        let mut entries = Vec::new();
        // Explicit routes win over the directory-mirror convention, so track
        // which payloads and served URLs they claim before mirroring.
        let mut claimed: HashSet<(String, String)> = HashSet::new();
        let mut served: HashSet<(String, String, String)> = HashSet::new();
        for (id, dir) in &dirs {
            let path = dir.join("routes.json");
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            let file: RoutesFile =
                serde_json::from_str(&text).map_err(|e| format!("bad {}: {e}", path.display()))?;
            if file.routes.len() > 1000 {
                return Err(format!(
                    "too many routes in {}: {}",
                    path.display(),
                    file.routes.len()
                ));
            }
            for mut route in file.routes {
                if route.route_id.is_empty() {
                    route.route_id = route.effective_id();
                }
                if let Some(payload) = &route.payload {
                    if !is_safe_payload_rel(payload) {
                        return Err(format!(
                            "unsafe payload path in {}: {payload}",
                            route.route_id
                        ));
                    }
                    claimed.insert((id.clone(), payload.clone()));
                }
                if let (Some(host), Some(path)) = (&route.host, &route.path) {
                    served.insert((host.clone(), path.clone(), route.method.clone()));
                }
                let compiled = match &route.path_regex {
                    Some(re) => {
                        if re.len() > 500 {
                            return Err(format!("path_regex too long in {}", route.route_id));
                        }
                        Some(
                            regex::Regex::new(re)
                                .map_err(|e| format!("bad regex in {}: {e}", route.route_id))?,
                        )
                    }
                    None => None,
                };
                entries.push((id.clone(), route, compiled));
            }
        }
        entries.extend(mirror_routes(scenarios_dir, &claimed, &served)?);
        Ok(RouteTable { entries })
    }

    pub fn lookup(&self, host: &str, path: &str, query: Option<&str>) -> Option<RouteHit<'_>> {
        if let Some(hit) = self.lookup_exact(host, path, query) {
            return Some(hit);
        }
        // Legacy-compatible suffix/index fallback for fixture-style routes.
        for suffix in [".html", ".json", ".xml", ".txt"] {
            let candidate = if path.ends_with('/') {
                format!("{path}index{suffix}")
            } else {
                format!("{path}{suffix}")
            };
            if let Some(hit) = self.lookup_exact(host, &candidate, query) {
                return Some(hit);
            }
        }
        None
    }

    fn lookup_exact(&self, host: &str, path: &str, query: Option<&str>) -> Option<RouteHit<'_>> {
        // Exact path matches beat prefix/regex wildcards, regardless of load
        // order: directory-mirror routes are appended last, and a concrete
        // payload must not be shadowed by an earlier wildcard fallback.
        self.match_entries(host, path, query, true)
            .or_else(|| self.match_entries(host, path, query, false))
    }

    fn match_entries(
        &self,
        host: &str,
        path: &str,
        query: Option<&str>,
        exact_path: bool,
    ) -> Option<RouteHit<'_>> {
        self.entries.iter().find_map(|(scenario, route, compiled)| {
            if !route.method.eq_ignore_ascii_case("GET") {
                return None;
            }
            if route.path.is_some() != exact_path {
                return None;
            }
            if let Some(h) = &route.host {
                if !h.eq_ignore_ascii_case(host) {
                    return None;
                }
            }
            if let Some(p) = &route.path {
                if p != path {
                    return None;
                }
            } else if let Some(prefix) = &route.path_prefix {
                if !path.starts_with(prefix.as_str()) {
                    return None;
                }
            } else if let Some(re) = compiled {
                if !re.is_match(path) {
                    return None;
                }
            } else {
                return None;
            }
            if let Some(q) = &route.query {
                if query != Some(q.as_str()) {
                    return None;
                }
            }
            Some(RouteHit { scenario, route })
        })
    }
}

impl ScenarioRoute {
    /// A stable id for a route that omitted `route_id`: derived from its
    /// match shape by the shared [`derive_route_id`], the same derivation the
    /// xtask fixture tooling uses, so duplicate detection stays meaningful
    /// across the server and the tooling.
    pub fn effective_id(&self) -> String {
        if !self.route_id.is_empty() {
            return self.route_id.clone();
        }
        let host = self.host.as_deref().unwrap_or("any");
        let target = self
            .path
            .as_deref()
            .or(self.path_prefix.as_deref())
            .or(self.path_regex.as_deref())
            .unwrap_or("route");
        derive_route_id(host, target)
    }

    pub fn missing_required_header<'a>(
        &'a self,
        headers: &HeaderMap,
        origin: &str,
    ) -> Option<&'a str> {
        self.required_headers.iter().find_map(|(name, expected)| {
            let expected = expected.replace("{{origin}}", origin);
            (headers.get(name).and_then(|value| value.to_str().ok()) != Some(expected.as_str()))
                .then_some(name.as_str())
        })
    }

    /// Return the first missing or mismatched cookie name for auth diagnostics.
    pub fn missing_required_cookie<'a>(&'a self, headers: &HeaderMap) -> Option<&'a str> {
        let raw = headers
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let present: HashMap<&str, &str> = raw
            .split(';')
            .filter_map(|pair| pair.trim().split_once('='))
            .collect();
        self.required_cookies.iter().find_map(|(name, expected)| {
            (present.get(name.as_str()) != Some(&expected.as_str())).then_some(name.as_str())
        })
    }

    pub fn render(
        &self,
        state: &super::AppState,
        scenario: &str,
        original: &super::UrlParts,
    ) -> Result<RenderedRoute, axum::http::StatusCode> {
        let mut headers = HeaderMap::new();
        for (k, v) in &self.headers {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.to_lowercase().as_bytes())
                    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?,
                HeaderValue::from_str(v)
                    .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?,
            );
        }
        let scenario_dir = state.scenarios_dir.join(scenario);
        let bytes = if let Some(gen) = &self.generator {
            render_generator(
                gen,
                &scenario_dir,
                &original.path,
                original.query.as_deref(),
            )?
        } else if let Some(payload) = &self.payload {
            let mut bytes = read_payload(&scenario_dir, payload)?;
            if is_text(&headers) {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                let localhost_origin = state.origin.replacen("127.0.0.1", "localhost", 1);
                let replaced = text
                    .replace("{{origin}}", &state.origin)
                    .replace("{{localhost_origin}}", &localhost_origin)
                    .replace("{{host}}", &original.host);
                bytes = replaced.into_bytes();
            }
            bytes
        } else {
            Vec::new()
        };
        Ok(RenderedRoute { headers, bytes })
    }
}

fn is_text(headers: &HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.starts_with("text/")
                || ct.contains("json")
                || ct.contains("xml")
                || ct.contains("yaml")
                || ct.contains("javascript")
                || ct.contains("svg")
        })
}

/// Fixture-relative payload names only: traversal and absolute paths are
/// refused. Every payload resolution goes through this family of helpers:
/// one spelling of the guard, not one per call site.
fn is_safe_payload_rel(name: &str) -> bool {
    !name.contains("..") && !name.starts_with('/')
}

fn safe_payload(scenario_dir: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    if !is_safe_payload_rel(name) {
        return None;
    }
    let full = scenario_dir.join(name);
    full.starts_with(scenario_dir).then_some(full)
}

fn read_payload(
    scenario_dir: &std::path::Path,
    name: &str,
) -> Result<Vec<u8>, axum::http::StatusCode> {
    let full = safe_payload(scenario_dir, name).ok_or(axum::http::StatusCode::FORBIDDEN)?;
    std::fs::read(&full).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn render_generator(
    gen: &GeneratorSpec,
    scenario_dir: &Path,
    path: &str,
    query: Option<&str>,
) -> Result<Vec<u8>, axum::http::StatusCode> {
    match gen {
        GeneratorSpec::ArtsTile { image } => {
            let bytes = read_payload(scenario_dir, image)?;
            super::arts::verify_and_decrypt(path, &bytes).ok_or(axum::http::StatusCode::FORBIDDEN)
        }
        GeneratorSpec::ArtsSignedTile { image } => {
            let bytes = read_payload(scenario_dir, image)?;
            super::arts::verify_signature(path).ok_or(axum::http::StatusCode::FORBIDDEN)?;
            Ok(bytes)
        }
        GeneratorSpec::GenericSvg { shape } => {
            super::svg::generic_tile(shape, query).ok_or(axum::http::StatusCode::NOT_FOUND)
        }
        GeneratorSpec::AssemblyTile => {
            super::svg::assembly_tile(query).ok_or(axum::http::StatusCode::BAD_REQUEST)
        }
        GeneratorSpec::JpegStub { image } => {
            // Legacy serves the shared 256x256 fixture photo for stub tile
            // URLs; exact bytes matter (clients refine tile size from them).
            let bytes = read_payload(scenario_dir, image)?;
            Ok(bytes)
        }
        GeneratorSpec::GenericJpg { image } => {
            let bytes = read_payload(scenario_dir, image)?;
            super::svg::generic_jpg(&bytes, query).ok_or(axum::http::StatusCode::NOT_FOUND)
        }
    }
}
