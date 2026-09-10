//! Shared fixture-corpus types and read-only helpers.
//!
//! The `fixtures` command surface re-exports `verify`, `serve`, and
//! `capture` from their stage modules; this module holds what they share:
//! the manifest/routes documents, schema and traversal checks, directory
//! collection, and hex encoding. Verification and capture stay read-only
//! except for their declared outputs (see each stage module).

use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) version: u32,
    pub(crate) scenarios: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ManifestEntry {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
    pub(crate) source_snapshot: String,
    pub(crate) source_path: String,
    pub(crate) license_provenance: String,
    pub(crate) sensitive: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RoutesFile {
    pub(crate) routes: Vec<Route>,
}

fn default_method() -> String {
    "GET".to_string()
}

fn default_status() -> u16 {
    200
}

#[derive(Debug, Deserialize)]
pub(crate) struct Route {
    #[serde(default)]
    pub(crate) route_id: String,
    #[serde(default = "default_method")]
    pub(crate) method: String,
    #[allow(dead_code)]
    pub(crate) host: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) path_prefix: Option<String>,
    #[allow(dead_code)]
    pub(crate) path_regex: Option<String>,
    #[allow(dead_code)]
    pub(crate) query: Option<String>,
    #[serde(default = "default_status")]
    pub(crate) status: u16,
    #[allow(dead_code)]
    pub(crate) headers: Option<std::collections::HashMap<String, String>>,
    pub(crate) payload: Option<String>,
    pub(crate) generator: Option<serde_json::Value>,
}

impl Route {
    /// A stable id for a route that omitted `route_id`; mirrors the server's
    /// derivation so duplicate detection stays meaningful.
    pub(crate) fn effective_id(&self) -> String {
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
        format!("{host}-{target}")
    }
}

pub(crate) fn check_schemas(dir: &Path) -> Result<(), String> {
    for name in [
        "manifest.schema.json",
        "scenario.schema.json",
        "routes.schema.json",
        "transcript.schema.json",
    ] {
        let p = dir.join("schema").join(name);
        let text =
            std::fs::read_to_string(&p).map_err(|e| format!("cannot read schema {name}: {e}"))?;
        serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|e| format!("bad schema {name}: {e}"))?;
    }
    Ok(())
}

pub(crate) fn load_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|e| format!("cannot read manifest.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("bad manifest.json: {e}"))
}

pub(crate) fn check_traversal(p: &str) -> Result<(), String> {
    let path = Path::new(p);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("unsafe path: {p}"));
    }
    Ok(())
}

pub(crate) fn collect_files(
    base: &Path,
    dir: &Path,
    out: &mut BTreeSet<String>,
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
            collect_files(base, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip prefix: {e}"))?
                .to_str()
                .ok_or("non-utf8 path")?
                .to_string();
            out.insert(rel);
        }
    }
    Ok(())
}

pub(crate) mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
