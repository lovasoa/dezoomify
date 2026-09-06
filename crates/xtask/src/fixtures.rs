//! `cargo xtask fixtures verify|serve|capture`.
//!
//! Verification is read-only: schemas, route/payload references, byte hashes,
//! sizes, duplicate IDs, incompatible duplicate served URLs, unlisted/missing
//! files, unsafe traversal, provenance, and sensitive flags. Serve spawns the
//! deterministic fixture server on loopback. Capture fetches public metadata
//! over the network (explicit, low-volume, like `test live`) and saves
//! redacted `routes.json` plus payloads for pull requests; it never sends or
//! stores credentials (see `docs/security.md` and
//! `docs/CONTRIBUTING-format.md`).

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

pub fn capture(args: &[String]) -> Result<(), String> {
    let opts = parse_capture_args(args)?;
    let root = super::repo_root();
    let scenario_dir = root.join("testdata/scenarios").join(&opts.out);
    if scenario_dir.exists() && !scenario_dir.is_dir() {
        return Err(format!("--out {} is not a directory", opts.out));
    }
    let mut fetched: Vec<FetchedResource> = Vec::new();
    for url in &opts.urls {
        let parsed = split_capture_url(url)?;
        let redacted = redact_capture_url(&parsed);
        let outcome = fetch_url(url, opts.timeout_secs, opts.max_bytes)?;
        let scrubbed = scrub_secrets(&outcome.bytes, &redacted.secrets, &outcome.content_type);
        let rel = payload_rel_path(&parsed.host, &parsed.path, &redacted.query);
        fetched.push(FetchedResource {
            parsed,
            redacted,
            bytes: scrubbed,
            content_type: outcome.content_type,
            rel,
        });
    }
    fetched.sort_by(|a, b| a.rel.cmp(&b.rel));
    for item in &fetched {
        let full = scenario_dir.join(&item.rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        std::fs::write(&full, &item.bytes)
            .map_err(|e| format!("cannot write {}: {e}", full.display()))?;
    }
    let routes_path = scenario_dir.join("routes.json");
    let merged = merge_capture_routes(&routes_path, &fetched)?;
    let routes_text = serde_json::to_string_pretty(&merged)
        .map_err(|e| format!("cannot encode routes.json: {e}"))?;
    std::fs::write(&routes_path, format!("{routes_text}\n"))
        .map_err(|e| format!("cannot write {}: {e}", routes_path.display()))?;
    let scenario_path = scenario_dir.join("scenario.json");
    if !scenario_path.is_file() {
        let first = &fetched[0];
        let skeleton = serde_json::json!({
            "id": opts.out,
            "description": format!(
                "Captured from {} ({}); review before merge",
                first.redacted.url, first.parsed.host,
            ),
            "source_evidence": {
                "snapshot": opts.snapshot,
                "path": first.redacted.url,
            },
            "input": {
                "mode": "automatic",
                "url": format!(
                    "http://{{{{origin}}}}/fetch?url={}://{}{}",
                    first.parsed.scheme, first.parsed.host, first.redacted.path_query,
                ),
            },
            "operation": "discover",
        });
        let text = serde_json::to_string_pretty(&skeleton)
            .map_err(|e| format!("cannot encode scenario.json: {e}"))?;
        std::fs::write(&scenario_path, format!("{text}\n"))
            .map_err(|e| format!("cannot write {}: {e}", scenario_path.display()))?;
    }
    println!(
        "fixtures capture: {} resource(s) into {} (redacted)",
        fetched.len(),
        opts.out,
    );
    for item in &fetched {
        println!("  {} -> {}", item.redacted.url, item.rel);
    }
    println!(
        "manifest snippet (review, then insert sorted into testdata/scenarios/manifest.json):"
    );
    let mut snippet = Vec::new();
    for item in &fetched {
        snippet.push(manifest_entry(&opts, &item.rel, &item.bytes));
    }
    snippet.push(manifest_entry(
        &opts,
        "routes.json",
        &std::fs::read(&routes_path).map_err(|e| format!("cannot read routes.json: {e}"))?,
    ));
    if scenario_path.is_file() {
        snippet.push(manifest_entry(
            &opts,
            "scenario.json",
            &std::fs::read(&scenario_path)
                .map_err(|e| format!("cannot read scenario.json: {e}"))?,
        ));
    }
    let text = serde_json::to_string_pretty(&snippet)
        .map_err(|e| format!("cannot encode snippet: {e}"))?;
    println!("{text}");
    println!("next: inspect `git diff` for secrets, add the manifest entries, then run");
    println!("`cargo xtask fixtures verify` and `cargo xtask test core --parity`.");
    println!("See docs/CONTRIBUTING-format.md for the full format checklist.");
    Ok(())
}

struct CaptureOptions {
    urls: Vec<String>,
    out: String,
    timeout_secs: u64,
    max_bytes: u64,
    license: String,
    snapshot: String,
}

struct CaptureUrl {
    scheme: String,
    host: String,
    path: String,
    query: Option<String>,
}

struct RedactedUrl {
    url: String,
    path_query: String,
    query: Option<String>,
    secrets: Vec<String>,
}

struct FetchedResource {
    parsed: CaptureUrl,
    redacted: RedactedUrl,
    bytes: Vec<u8>,
    content_type: String,
    rel: String,
}

struct FetchOutcome {
    bytes: Vec<u8>,
    content_type: String,
}

/// Query key substrings whose values are credentials per docs/security.md.
/// Mirrors the fixture-server request-log redaction vocabulary.
const SENSITIVE_SUBSTRINGS: &[&str] = &[
    "apikey",
    "api_key",
    "token",
    "auth",
    "session",
    "signature",
    "secret",
    "password",
    "cookie",
];

fn parse_capture_args(args: &[String]) -> Result<CaptureOptions, String> {
    let mut urls: Vec<String> = Vec::new();
    let mut out: Option<String> = None;
    let mut redact = false;
    let mut timeout_secs = 30u64;
    let mut max_bytes = 5_242_880u64;
    let mut license = "see PR (reviewer confirms license before merge)".to_string();
    let mut snapshot = "uncommitted-capture (see PR)".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--url" | "--also" => {
                i += 1;
                let url = args
                    .get(i)
                    .cloned()
                    .ok_or("fixtures capture --url needs a value")?;
                urls.push(url);
            }
            "--out" => {
                i += 1;
                out = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("fixtures capture --out needs a value")?,
                );
            }
            "--redact" => redact = true,
            "--timeout-secs" => {
                i += 1;
                timeout_secs = args
                    .get(i)
                    .ok_or("fixtures capture --timeout-secs needs a value")?
                    .parse::<u64>()
                    .map_err(|_| "bad --timeout-secs <seconds>".to_string())?;
                if timeout_secs == 0 || timeout_secs > 300 {
                    return Err("bad --timeout-secs <seconds> (1-300)".to_string());
                }
            }
            "--max-bytes" => {
                i += 1;
                max_bytes = args
                    .get(i)
                    .ok_or("fixtures capture --max-bytes needs a value")?
                    .parse::<u64>()
                    .map_err(|_| "bad --max-bytes <bytes>".to_string())?;
                if max_bytes == 0 || max_bytes > 20_971_520 {
                    return Err("bad --max-bytes <bytes> (1-20971520)".to_string());
                }
            }
            "--license" => {
                i += 1;
                license = args
                    .get(i)
                    .cloned()
                    .ok_or("fixtures capture --license needs a value")?;
            }
            "--snapshot" => {
                i += 1;
                snapshot = args
                    .get(i)
                    .cloned()
                    .ok_or("fixtures capture --snapshot needs a value")?;
            }
            "--help" | "-h" => {
                return Err(
                    "usage: cargo xtask fixtures capture --url <url> [--also <url>...] \
                     --out <scenario-id> --redact [--timeout-secs <1-300>] \
                     [--max-bytes <1-20971520>] [--license <text>] [--snapshot <text>]"
                        .to_string(),
                );
            }
            other => {
                return Err(format!(
                    "unknown fixtures capture option '{other}' \
                     (only --url|--also|--out|--redact|--timeout-secs|--max-bytes|--license|--snapshot)"
                ));
            }
        }
        i += 1;
    }
    if urls.is_empty() {
        return Err("fixtures capture needs --url <url>".to_string());
    }
    if urls.len() > 20 {
        return Err(
            "fixtures capture takes at most 20 urls (one metadata page plus a few resources)"
                .to_string(),
        );
    }
    let out = out.ok_or("fixtures capture needs --out <scenario-id>")?;
    check_capture_out(&out)?;
    if !redact {
        return Err(
            "fixtures capture refuses to save without --redact (credentials stay out of the corpus; see docs/security.md)".to_string(),
        );
    }
    if license.trim().is_empty() || snapshot.trim().is_empty() {
        return Err("fixtures capture needs non-empty --license and --snapshot".to_string());
    }
    Ok(CaptureOptions {
        urls,
        out,
        timeout_secs,
        max_bytes,
        license,
        snapshot,
    })
}

fn check_capture_out(out: &str) -> Result<(), String> {
    if out.is_empty()
        || out.starts_with('/')
        || out.ends_with('/')
        || out.contains("..")
        || out.contains('\\')
        || out == "schema"
        || out.starts_with("schema/")
    {
        return Err(format!("bad --out scenario id '{out}'"));
    }
    let ok = out
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'/');
    if !ok
        || !out
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return Err(format!("bad --out scenario id '{out}'"));
    }
    Ok(())
}

fn split_capture_url(url: &str) -> Result<CaptureUrl, String> {
    let (scheme, rest) = url
        .strip_prefix("http://")
        .map(|rest| ("http".to_string(), rest))
        .or_else(|| {
            url.strip_prefix("https://")
                .map(|rest| ("https".to_string(), rest))
        })
        .ok_or("capture url must start with http:// or https://")?;
    if rest.is_empty() || rest.contains(' ') {
        return Err("capture url has a bad authority".to_string());
    }
    let (authority, path_query) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err(
            "capture url must not contain userinfo (strip credentials and use a public url)"
                .to_string(),
        );
    }
    // Fixture identity ignores ports: the fixture server matches routes on
    // hostname only so loopback captures replay on ephemeral ports.
    let host = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            h.to_lowercase()
        }
        _ => authority.to_lowercase(),
    };
    if host.is_empty() {
        return Err("capture url has a bad authority".to_string());
    }
    let (path, query) = match path_query.find(['?', '#']) {
        Some(i) => {
            let (p, _) = path_query.split_at(i);
            let q = path_query[i + 1..].to_string();
            (
                if p.is_empty() {
                    "/".to_string()
                } else {
                    p.to_string()
                },
                if q.is_empty() { None } else { Some(q) },
            )
        }
        None => (path_query, None),
    };
    if path.contains("..") {
        return Err("capture url path must not contain '..'".to_string());
    }
    Ok(CaptureUrl {
        scheme,
        host,
        path,
        query,
    })
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_SUBSTRINGS.iter().any(|n| lower.contains(n))
}

/// Redact a capture URL: fragments are dropped, userinfo is already rejected,
/// and sensitive query values become `REDACTED`. Returns the redacted URL plus
/// the original secret values so payload bytes can be scrubbed the same way.
fn redact_capture_url(parsed: &CaptureUrl) -> RedactedUrl {
    let mut secrets = Vec::new();
    let query = parsed.query.as_deref().map(|q| {
        q.split('&')
            .map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                if !v.is_empty() && is_sensitive_key(k) {
                    secrets.push(v.to_string());
                    format!("{k}=REDACTED")
                } else {
                    pair.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("&")
    });
    let path_query = match &query {
        Some(q) if !q.is_empty() => format!("{}?{q}", parsed.path),
        _ => parsed.path.clone(),
    };
    let url = format!("{}://{}{}", parsed.scheme, parsed.host, path_query);
    RedactedUrl {
        url,
        path_query,
        query,
        secrets,
    }
}

fn route_id_for(host: &str, path: &str) -> String {
    let mut id = String::new();
    for ch in format!("{host}{path}").chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else if !id.ends_with('-') && !id.is_empty() {
            id.push('-');
        }
    }
    while id.ends_with('-') {
        id.pop();
    }
    if id.is_empty() {
        id.push_str("capture");
    }
    id.chars().take(100).collect()
}

/// On-disk payload path under the scenario dir. Colons become `%3A` so the
/// tree checks out on Windows; a redacted-query hash disambiguates resources
/// whose paths collide.
fn payload_rel_path(host: &str, path: &str, redacted_query: &Option<String>) -> String {
    let trimmed = path.trim_start_matches('/');
    let mut base = if trimmed.is_empty() || path.ends_with('/') {
        format!("{trimmed}index.html")
    } else {
        trimmed.to_string()
    };
    base = base.replace(':', "%3A");
    if let Some(q) = redacted_query {
        if !q.is_empty() {
            let mut hasher = Sha256::new();
            hasher.update(q.as_bytes());
            let hash = hex::encode(hasher.finalize());
            let short = &hash[..8];
            match base.rsplit_once('.') {
                Some((stem, ext)) if !ext.contains('/') => {
                    base = format!("{stem}__q{short}.{ext}");
                }
                _ => base = format!("{base}__q{short}"),
            }
        }
    }
    format!("payloads/{}/{base}", host.replace(':', "%3A"))
}

fn fetch_url(url: &str, timeout_secs: u64, max_bytes: u64) -> Result<FetchOutcome, String> {
    let dir = std::env::temp_dir().join(format!("dezoomify-capture-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let body_path = dir.join("body.bin");
    let _ = std::fs::remove_file(&body_path);
    let output = std::process::Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--max-redirs",
            "5",
            "--max-time",
            &timeout_secs.to_string(),
            "--max-filesize",
            &max_bytes.to_string(),
            "--proto",
            "=http,https",
            "--user-agent",
            "dezoomify-fixture-capture/1.0",
            "--header",
            "Accept: */*",
            "--output",
            &body_path.to_string_lossy(),
            "--write-out",
            "%{content_type}\n%{http_code}",
        ])
        .arg("--")
        .arg(url)
        .output()
        .map_err(|e| format!("failed to run curl (is curl installed?): {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = std::fs::remove_file(&body_path);
        return Err(if detail.is_empty() {
            "curl fetch failed".to_string()
        } else {
            format!("curl fetch failed: {detail}")
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines().rev();
    let code = lines.next().unwrap_or("").trim().to_string();
    let content_type = lines.next().unwrap_or("").trim().to_string();
    if !code.starts_with('2') {
        let _ = std::fs::remove_file(&body_path);
        return Err(format!("curl fetch failed with HTTP {code}"));
    }
    let bytes = std::fs::read(&body_path).map_err(|e| format!("cannot read fetched body: {e}"))?;
    let _ = std::fs::remove_file(&body_path);
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "fetched body exceeds --max-bytes {max_bytes} ({} bytes)",
            bytes.len()
        ));
    }
    if bytes.is_empty() {
        return Err("fetched body is empty".to_string());
    }
    Ok(FetchOutcome {
        bytes,
        content_type,
    })
}

fn is_text_content_type(content_type: &str) -> bool {
    let lower = content_type.to_ascii_lowercase();
    lower.starts_with("text/")
        || lower.contains("json")
        || lower.contains("xml")
        || lower.contains("javascript")
        || lower.contains("svg")
}

fn scrub_secrets(bytes: &[u8], secrets: &[String], content_type: &str) -> Vec<u8> {
    if secrets.is_empty() {
        return bytes.to_vec();
    }
    if !content_type.is_empty() && !is_text_content_type(content_type) {
        return bytes.to_vec();
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let mut scrubbed = text.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            scrubbed = scrubbed.replace(secret, "REDACTED");
        }
    }
    scrubbed.into_bytes()
}

fn content_type_for(path: &str, fetched: &str) -> String {
    if !fetched.is_empty() {
        return fetched.split(';').next().unwrap_or("").trim().to_string();
    }
    match path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
    {
        Some(ext) if ext == "json" => "application/json".to_string(),
        Some(ext) if ext == "xml" || ext == "dzi" => "application/xml".to_string(),
        Some(ext) if ext == "html" => "text/html".to_string(),
        Some(ext) if ext == "txt" => "text/plain".to_string(),
        Some(ext) if ext == "png" => "image/png".to_string(),
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn merge_capture_routes(
    routes_path: &Path,
    fetched: &[FetchedResource],
) -> Result<serde_json::Value, String> {
    let mut routes: Vec<serde_json::Value> = Vec::new();
    if routes_path.is_file() {
        let text = std::fs::read_to_string(routes_path)
            .map_err(|e| format!("cannot read {}: {e}", routes_path.display()))?;
        let existing: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("bad {}: {e}", routes_path.display()))?;
        if let Some(list) = existing.get("routes").and_then(|r| r.as_array()) {
            routes.extend(list.iter().cloned());
        }
    }
    for item in fetched {
        let content_type = content_type_for(&item.parsed.path, &item.content_type);
        let route = serde_json::json!({
            "route_id": route_id_for(&item.parsed.host, &item.parsed.path),
            "method": "GET",
            "host": item.parsed.host,
            "path": item.parsed.path,
            "status": 200,
            "headers": { "Content-Type": content_type },
            "payload": item.rel,
        });
        routes.retain(|r| {
            !(r.get("method").and_then(|m| m.as_str()) == Some("GET")
                && r.get("host").and_then(|h| h.as_str()) == Some(item.parsed.host.as_str())
                && r.get("path").and_then(|p| p.as_str()) == Some(item.parsed.path.as_str()))
        });
        routes.push(route);
    }
    routes.sort_by(|a, b| {
        a.get("route_id")
            .and_then(|r| r.as_str())
            .cmp(&b.get("route_id").and_then(|r| r.as_str()))
    });
    Ok(serde_json::json!({ "routes": routes }))
}

fn manifest_entry(opts: &CaptureOptions, name: &str, bytes: &[u8]) -> serde_json::Value {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let content_type = match name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
    {
        Some(ext) if ext == "json" => "application/json",
        Some(ext) if ext == "html" => "text/html",
        Some(ext) if ext == "xml" || ext == "dzi" => "application/xml",
        Some(ext) if ext == "txt" => "text/plain",
        Some(ext) if ext == "png" => "image/png",
        Some(ext) if ext == "jpg" || ext == "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    };
    let path = format!("{}/{}", opts.out, name);
    serde_json::json!({
        "id": path,
        "path": path,
        "sha256": hex::encode(hasher.finalize()),
        "size": bytes.len(),
        "content_type": content_type,
        "source_snapshot": opts.snapshot,
        "source_path": "capture (see PR for the redacted source url)",
        "license_provenance": opts.license,
        "sensitive": false,
        "served_urls": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> CaptureOptions {
        CaptureOptions {
            urls: vec!["https://example.test/a".to_string()],
            out: "web/capture-test".to_string(),
            timeout_secs: 30,
            max_bytes: 100,
            license: "test".to_string(),
            snapshot: "test".to_string(),
        }
    }

    #[test]
    fn capture_needs_url_out_and_redact() {
        assert!(parse_capture_args(&[]).is_err());
        assert!(parse_capture_args(&[
            "--url".to_string(),
            "https://example.test/a".to_string(),
            "--out".to_string(),
            "web/x".to_string(),
        ])
        .is_err());
        assert!(parse_capture_args(&[
            "--url".to_string(),
            "https://example.test/a".to_string(),
            "--out".to_string(),
            "web/x".to_string(),
            "--redact".to_string(),
        ])
        .is_ok());
    }

    #[test]
    fn capture_rejects_userinfo_and_non_http() {
        assert!(split_capture_url("https://user:pass@example.test/a").is_err());
        assert!(split_capture_url("ftp://example.test/a").is_err());
        assert!(split_capture_url("https://example.test/a/../b").is_err());
        assert_eq!(
            split_capture_url("http://127.0.0.1:8931/a").unwrap().host,
            "127.0.0.1"
        );
        assert!(check_capture_out("../evil").is_err());
        assert!(check_capture_out("schema").is_err());
        assert!(check_capture_out("Web/Upper").is_err());
    }

    #[test]
    fn redaction_strips_secrets_but_keeps_shape() {
        let parsed =
            split_capture_url("https://example.test/item?apiKey=SECRET-1&view=2&token=SECRET-2")
                .unwrap();
        let redacted = redact_capture_url(&parsed);
        assert_eq!(
            redacted.url,
            "https://example.test/item?apiKey=REDACTED&view=2&token=REDACTED"
        );
        assert_eq!(redacted.secrets, vec!["SECRET-1", "SECRET-2"]);
        assert!(!redacted.url.contains("SECRET"));
        let scrubbed = scrub_secrets(
            b"{\"key\":\"SECRET-1\",\"view\":2}" as &[u8],
            &redacted.secrets,
            "application/json",
        );
        assert_eq!(scrubbed, b"{\"key\":\"REDACTED\",\"view\":2}");
        // Binary payloads are never rewritten.
        let png = [0x89, 0x50, 0x4eu8];
        assert_eq!(scrub_secrets(&png, &redacted.secrets, "image/png"), png);
    }

    #[test]
    fn payload_paths_stay_traversal_free_and_windows_safe() {
        assert_eq!(
            payload_rel_path("example.test", "/a/b.json", &None),
            "payloads/example.test/a/b.json"
        );
        assert_eq!(
            payload_rel_path("example.test", "/iiif/ark:/1/info.json", &None),
            "payloads/example.test/iiif/ark%3A/1/info.json"
        );
        let with_query =
            payload_rel_path("example.test", "/iip", &Some("FIF=REDACTED".to_string()));
        assert!(with_query.starts_with("payloads/example.test/iip__q"));
        assert!(!with_query.contains(".."));
        assert!(!with_query.contains(':'));
        assert_eq!(
            route_id_for("Example.TEST", "/a/B.json"),
            "example-test-a-b-json"
        );
    }

    #[test]
    fn manifest_entries_carry_provenance_without_secrets() {
        let entry = manifest_entry(&opts(), "routes.json", b"{}");
        assert_eq!(entry["path"], "web/capture-test/routes.json");
        assert_eq!(entry["sensitive"], false);
        assert!(!entry["source_path"].as_str().unwrap().contains("SECRET"));
    }
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}
