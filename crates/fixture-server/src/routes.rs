//! Scenario route table: loading, matching, and payload rendering.

use axum::http::{HeaderMap, HeaderValue};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct ScenarioRoute {
    pub route_id: String,
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
    pub status: u16,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub generator: Option<GeneratorSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum GeneratorSpec {
    #[serde(rename = "arts-tile")]
    ArtsTile { image: String },
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

impl RouteTable {
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
            for route in file.routes {
                if let Some(payload) = &route.payload {
                    if payload.contains("..") || payload.starts_with('/') {
                        return Err(format!(
                            "unsafe payload path in {}: {payload}",
                            route.route_id
                        ));
                    }
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
        self.entries.iter().find_map(|(scenario, route, compiled)| {
            if !route.method.eq_ignore_ascii_case("GET") {
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
        let join_under = |name: &str| -> Option<std::path::PathBuf> {
            if name.contains("..") || name.starts_with('/') {
                return None;
            }
            let full = scenario_dir.join(name);
            if full.starts_with(&scenario_dir) {
                Some(full)
            } else {
                None
            }
        };
        let bytes = if let Some(gen) = &self.generator {
            render_generator(
                gen,
                &scenario_dir,
                &original.path,
                original.query.as_deref(),
            )?
        } else if let Some(payload) = &self.payload {
            let full = join_under(payload).ok_or(axum::http::StatusCode::FORBIDDEN)?;
            let mut bytes =
                std::fs::read(&full).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
            if is_text(&headers) {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                let replaced = text
                    .replace("{{origin}}", &state.origin)
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
                || ct.contains("javascript")
                || ct.contains("svg")
        })
}

fn render_generator(
    gen: &GeneratorSpec,
    scenario_dir: &Path,
    path: &str,
    query: Option<&str>,
) -> Result<Vec<u8>, axum::http::StatusCode> {
    match gen {
        GeneratorSpec::ArtsTile { image } => {
            let full = if image.contains("..") || image.starts_with('/') {
                return Err(axum::http::StatusCode::FORBIDDEN);
            } else {
                scenario_dir.join(image)
            };
            if !full.starts_with(scenario_dir) {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
            let bytes =
                std::fs::read(&full).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
            super::arts::verify_and_decrypt(path, &bytes).ok_or(axum::http::StatusCode::FORBIDDEN)
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
            let full = if image.contains("..") || image.starts_with('/') {
                return Err(axum::http::StatusCode::FORBIDDEN);
            } else {
                scenario_dir.join(image)
            };
            if !full.starts_with(scenario_dir) {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
            let bytes =
                std::fs::read(&full).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(bytes)
        }
        GeneratorSpec::GenericJpg { image } => {
            let full = if image.contains("..") || image.starts_with('/') {
                return Err(axum::http::StatusCode::FORBIDDEN);
            } else {
                scenario_dir.join(image)
            };
            if !full.starts_with(scenario_dir) {
                return Err(axum::http::StatusCode::FORBIDDEN);
            }
            let bytes =
                std::fs::read(&full).map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
            super::svg::generic_jpg(&bytes, query).ok_or(axum::http::StatusCode::NOT_FOUND)
        }
    }
}
