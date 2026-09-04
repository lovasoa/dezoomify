//! `cargo xtask fixtures verify|serve`.
//!
//! Verification is read-only: schemas, route/payload references, byte hashes,
//! sizes, duplicate IDs, incompatible duplicate served URLs, unlisted/missing
//! files, unsafe traversal, provenance, and sensitive flags. Serve spawns the
//! deterministic fixture server on loopback.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct Manifest {
    version: u32,
    scenarios: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    id: String,
    path: String,
    sha256: String,
    size: u64,
    source_snapshot: String,
    source_path: String,
    license_provenance: String,
    sensitive: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct RoutesFile {
    routes: Vec<Route>,
}

#[derive(Debug, Deserialize)]
struct Route {
    route_id: String,
    method: String,
    #[allow(dead_code)]
    host: Option<String>,
    path: Option<String>,
    path_prefix: Option<String>,
    #[allow(dead_code)]
    path_regex: Option<String>,
    #[allow(dead_code)]
    query: Option<String>,
    status: u16,
    #[allow(dead_code)]
    headers: Option<std::collections::HashMap<String, String>>,
    payload: Option<String>,
    generator: Option<serde_json::Value>,
}

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask fixtures verify (no options)".to_string());
    }
    let root = super::repo_root();
    let dir = root.join("testdata/scenarios");
    check_schemas(&dir)?;
    let manifest = load_manifest(&dir)?;
    if manifest.version != 1 {
        return Err("manifest version must be 1".to_string());
    }
    let mut seen_files = BTreeSet::new();
    let mut served: BTreeMap<(String, String, String), Vec<(String, String)>> = BTreeMap::new();
    let mut scenario_ids = BTreeSet::new();
    for entry in &manifest.scenarios {
        if !scenario_ids.insert(entry.id.clone()) {
            return Err(format!("duplicate scenario id '{}'", entry.id));
        }
        check_traversal(&entry.id)?;
        check_traversal(&entry.path)?;
        let full = dir.join(&entry.path);
        let bytes =
            std::fs::read(&full).map_err(|e| format!("missing file {}: {e}", entry.path))?;
        if bytes.len() as u64 != entry.size {
            return Err(format!("size mismatch for {}", entry.path));
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(hasher.finalize());
        if hash != entry.sha256 {
            return Err(format!("sha256 mismatch for {}", entry.path));
        }
        if entry.source_snapshot.is_empty()
            || entry.source_path.is_empty()
            || entry.license_provenance.is_empty()
        {
            return Err(format!("missing provenance for {}", entry.path));
        }
        if !entry.sensitive.is_boolean() && !entry.sensitive.is_string() {
            return Err(format!("bad sensitive flag for {}", entry.path));
        }
        seen_files.insert(entry.path.clone());
    }
    // Per-scenario checks: routes reference payloads; collect served URLs.
    // Scenario dirs are discovered by walking for scenario.json files.
    let mut scenario_dirs: BTreeSet<String> = BTreeSet::new();
    {
        let mut stack = vec![dir.clone()];
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
                } else if path.file_name().and_then(|n| n.to_str()) == Some("scenario.json") {
                    let rel = path
                        .parent()
                        .and_then(|p| p.strip_prefix(&dir).ok())
                        .and_then(|p| p.to_str())
                        .ok_or("non-utf8 scenario dir")?
                        .to_string();
                    scenario_dirs.insert(rel);
                }
            }
        }
    }
    let mut scenario_count = 0;
    for scenario in &scenario_dirs {
        if scenario == "schema" {
            continue;
        }
        let sdir = dir.join(scenario);
        if !sdir.is_dir() {
            return Err(format!("scenario dir missing: {scenario}"));
        }
        let scenario_json = sdir.join("scenario.json");
        if scenario_json.is_file() {
            scenario_count += 1;
            let text = std::fs::read_to_string(&scenario_json)
                .map_err(|e| format!("cannot read {}: {e}", scenario_json.display()))?;
            let v: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("bad {}: {e}", scenario_json.display()))?;
            for key in ["id", "description", "source_evidence", "input", "operation"] {
                if v.get(key).is_none() {
                    return Err(format!("{} lacks '{key}'", scenario_json.display()));
                }
            }
            if v.get("id").and_then(|i| i.as_str()) != Some(scenario.as_str()) {
                return Err(format!("{} id mismatch", scenario_json.display()));
            }
        }
        let routes_path = sdir.join("routes.json");
        if routes_path.is_file() {
            let text = std::fs::read_to_string(&routes_path)
                .map_err(|e| format!("cannot read {}: {e}", routes_path.display()))?;
            let file: RoutesFile = serde_json::from_str(&text)
                .map_err(|e| format!("bad {}: {e}", routes_path.display()))?;
            let mut route_ids = BTreeSet::new();
            for r in &file.routes {
                if !route_ids.insert(r.route_id.clone()) {
                    return Err(format!("duplicate route_id '{}' in {scenario}", r.route_id));
                }
                if r.method != "GET" && r.method != "HEAD" {
                    return Err(format!("bad method in {scenario}/{}", r.route_id));
                }
                if !(100..600).contains(&r.status) {
                    return Err(format!("bad status in {scenario}/{}", r.route_id));
                }
                if r.path.is_none() && r.path_prefix.is_none() && r.path_regex.is_none() {
                    return Err(format!(
                        "route {}/{} needs path, path_prefix, or path_regex",
                        scenario, r.route_id
                    ));
                }
                if let Some(p) = &r.payload {
                    check_traversal(p)?;
                    let rel = format!("{scenario}/{p}");
                    if !seen_files.contains(&rel) {
                        return Err(format!("payload {rel} referenced but not in manifest"));
                    }
                }
                if r.payload.is_none() && r.generator.is_none() {
                    return Err(format!(
                        "route {}/{} needs payload or generator",
                        scenario, r.route_id
                    ));
                }
                if let (Some(host), Some(path)) = (&r.host, &r.path) {
                    let key = (host.clone(), path.clone(), r.method.clone());
                    let fingerprint = route_fingerprint(&dir, scenario, r)?;
                    served
                        .entry(key)
                        .or_default()
                        .push((scenario.clone(), fingerprint));
                }
            }
        }
    }
    // Incompatible duplicate served URLs fail; identical duplicates are allowed
    // (scenarios stay self-contained with distinct scenario/payload IDs).
    for ((host, path, method), owners) in &served {
        let mut fps: BTreeSet<&String> = BTreeSet::new();
        for (_, fp) in owners {
            fps.insert(fp);
        }
        if fps.len() > 1 {
            let who: Vec<&String> = owners.iter().map(|(s, _)| s).collect();
            return Err(format!(
                "incompatible duplicate served URL {host}{path} ({method}) in {who:?}"
            ));
        }
    }
    // Unlisted files: walk scenario dirs, excluding schema/ and manifest.json.
    let mut actual = BTreeSet::new();
    collect_files(&dir, &dir, &mut actual)?;
    actual.remove("manifest.json");
    // Root documentation is owned content, not fixture data.
    actual.remove("README.md");
    for f in actual.iter().filter(|f| f.starts_with("schema/")) {
        seen_files.insert(f.clone());
    }
    // scenario.json/routes.json/expected/pixels are referenced implicitly.
    for f in actual.iter() {
        if f.ends_with("/scenario.json")
            || f.ends_with("/routes.json")
            || f.contains("/expected/")
            || f.contains("/pixels/")
        {
            seen_files.insert(f.clone());
        }
    }
    let unlisted: Vec<_> = actual.difference(&seen_files).collect();
    if !unlisted.is_empty() {
        return Err(format!("unlisted files: {:?}", unlisted));
    }
    let missing: Vec<_> = seen_files.difference(&actual).collect();
    if !missing.is_empty() {
        return Err(format!("manifest lists missing files: {:?}", missing));
    }
    println!(
        "fixtures verify: {} files, {} scenarios ok",
        manifest.scenarios.len(),
        scenario_count
    );
    Ok(())
}

fn route_fingerprint(dir: &Path, scenario: &str, r: &Route) -> Result<String, String> {
    if let Some(gen) = &r.generator {
        let canonical = serde_json::to_string(gen).map_err(|e| format!("bad generator: {e}"))?;
        return Ok(format!("{}|gen|{canonical}", r.status));
    }
    let payload = r.payload.as_deref().ok_or_else(|| {
        format!(
            "route {}/{} needs payload or generator",
            scenario, r.route_id
        )
    })?;
    check_traversal(payload)?;
    let bytes = std::fs::read(dir.join(scenario).join(payload))
        .map_err(|e| format!("cannot read payload {scenario}/{payload}: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{}|{}", r.status, hex::encode(hasher.finalize())))
}

fn check_schemas(dir: &Path) -> Result<(), String> {
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

fn load_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join("manifest.json"))
        .map_err(|e| format!("cannot read manifest.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("bad manifest.json: {e}"))
}

fn check_traversal(p: &str) -> Result<(), String> {
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

fn collect_files(base: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<(), String> {
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

pub fn serve(args: &[String]) -> Result<(), String> {
    let mut port = "0".to_string();
    let mut write_address: Option<PathBuf> = None;
    let mut extra: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                port = args
                    .get(i)
                    .cloned()
                    .ok_or("fixtures serve --port needs a value")?;
            }
            "--write-address" => {
                i += 1;
                write_address = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("fixtures serve --write-address needs a value")?
                        .into(),
                );
            }
            other => extra.push(other.to_string()),
        }
        i += 1;
    }
    if !extra.is_empty() {
        return Err(format!(
            "unknown fixtures serve options: {}",
            extra.join(" ")
        ));
    }
    let root = super::repo_root();
    let exe = root.join("target/debug/dezoomify-fixture-server");
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--port")
        .arg(&port)
        .arg("--scenarios-dir")
        .arg(root.join("testdata/scenarios"))
        .current_dir(&root);
    if let Some(addr) = write_address {
        cmd.arg("--write-address").arg(addr);
    }
    let status = cmd.status().map_err(|e| {
        format!(
            "failed to run {} (build it first with `cargo build -p dezoomify-fixture-server`): {e}",
            exe.display()
        )
    })?;
    if !status.success() {
        return Err("fixture server exited nonzero".to_string());
    }
    Ok(())
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
