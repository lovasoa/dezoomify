//! Shared release-pipeline inventory and plan document helpers.
//!
//! The `release` command surface lives in `super` (`mod.rs`); the stage
//! implementations live in `plan`, `build`, `verify`, and
//! `publish`. This module holds what every stage shares: the
//! `release/*.toml` + `generated/*.json` inventory inputs, the
//! deterministic plan document, artifact naming, git, and error helpers.
//! Nothing here performs a stage on its own.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const ARTIFACTS_ROOT: &str = "target/release-dist";

// ---------------------------------------------------------------------------
// Release inventory inputs (release/*.toml, generated/*.json)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct Config {
    pub(crate) protocol: ConfigProtocol,
}

#[derive(Deserialize)]
pub(crate) struct ConfigProtocol {
    pub(crate) range: String,
    pub(crate) min_peer: String,
}

#[derive(Deserialize)]
pub(crate) struct Targets {
    #[serde(rename = "target")]
    pub(crate) list: Vec<TargetEntry>,
}

#[derive(Deserialize)]
pub(crate) struct TargetEntry {
    pub(crate) name: String,
    pub(crate) os: String,
    #[serde(default = "default_available")]
    pub(crate) available: bool,
}

fn default_available() -> bool {
    true
}

#[derive(Deserialize)]
pub(crate) struct Compatibility {
    pub(crate) compatibility: CompatibilitySection,
}

#[derive(Deserialize)]
pub(crate) struct CompatibilitySection {
    pub(crate) current: String,
    pub(crate) n_minus_1: String,
}

#[derive(Deserialize)]
pub(crate) struct Capabilities {
    pub(crate) capabilities: Vec<String>,
    pub(crate) protocol: String,
}

/// Desktop targets mirror the host bundlers in `release/targets.toml`:
/// Linux deb is available (verified `cargo xtask build desktop` output);
/// Windows msi/nsis and macOS dmg stay `available = false` until a matching
/// host with its bundler tools produces them (docs/releases.md).
pub(crate) fn load_targets() -> Result<Targets, String> {
    parse_toml("release/targets.toml")
}

fn parse_toml<T: for<'de> Deserialize<'de>>(rel: &str) -> Result<T, String> {
    let text = std::fs::read_to_string(crate::repo_root().join(rel))
        .map_err(|e| format!("missing {rel}: {e}"))?;
    toml::from_str(&text).map_err(|e| format!("bad {rel}: {e}"))
}

pub(crate) fn load_config() -> Result<Config, String> {
    parse_toml("release/config.toml")
}

pub(crate) fn load_compatibility() -> Result<Compatibility, String> {
    parse_toml("release/compatibility.toml")
}

pub(crate) fn load_capabilities() -> Result<Capabilities, String> {
    let path = crate::repo_root().join("generated/release-capabilities.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing generated/release-capabilities.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("bad release-capabilities.json: {e}"))
}

pub(crate) fn schema_fingerprint() -> Result<String, String> {
    let path = crate::repo_root().join("generated/desktop-capabilities.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing generated/desktop-capabilities.json: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad desktop-capabilities.json: {e}"))?;
    value
        .get("fingerprint")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "desktop-capabilities.json lacks fingerprint".to_string())
}

// ---------------------------------------------------------------------------
// Plan document
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct Plan {
    pub(crate) version: String,
    pub(crate) tag: String,
    pub(crate) channel: String,
    pub(crate) commit: String,
    pub(crate) protocol: PlanProtocol,
    pub(crate) schema_fingerprint: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) targets: Vec<PlanTarget>,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct PlanProtocol {
    pub(crate) range: String,
    pub(crate) min_peer: String,
    pub(crate) compatibility_current: String,
    pub(crate) compatibility_n_minus_1: String,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct PlanTarget {
    pub(crate) name: String,
    pub(crate) os: String,
    pub(crate) available: bool,
}

pub(crate) fn git_output(args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(crate::repo_root())
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {} failed", args.join(" ")));
    }
    String::from_utf8(out.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|e| format!("git output: {e}"))
}

pub(crate) fn git_commit() -> Result<String, String> {
    let commit = git_output(&["rev-parse", "HEAD"])?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("git rev-parse HEAD returned a non-commit value".to_string());
    }
    Ok(commit)
}

/// The nearest numbered tag is the baseline; each first-parent commit after
/// it consumes one patch number. The boolean is true on the tagged commit.
pub(crate) fn app_version() -> Result<(String, bool), String> {
    let current = app_version_at("HEAD", 0)?;
    if current.1 {
        let rolling = app_version_at("HEAD^", 1)?.0;
        let numbers = |version: &str| {
            version
                .split('.')
                .map(|part| part.parse::<u64>().expect("validated app version"))
                .collect::<Vec<_>>()
        };
        if numbers(&current.0) <= numbers(&rolling) {
            return Err(format!(
                "numbered version {} must be newer than rolling version {rolling}",
                current.0
            ));
        }
    }
    Ok(current)
}

fn app_version_at(revision: &str, extra_distance: u64) -> Result<(String, bool), String> {
    let description = git_output(&[
        "describe",
        "--first-parent",
        "--tags",
        "--match",
        "v[0-9]*.[0-9]*.[0-9]*",
        "--long",
        revision,
    ])
    .map_err(|_| "cannot derive app version; fetch the numbered tags".to_string())?;
    let (tag_distance, _) = description
        .rsplit_once("-g")
        .ok_or_else(|| "unexpected git describe output".to_string())?;
    let (tag, distance) = tag_distance
        .rsplit_once('-')
        .ok_or_else(|| "unexpected git describe output".to_string())?;
    let base = tag
        .strip_prefix('v')
        .ok_or_else(|| "numbered tags must use vX.Y.Z".to_string())?;
    validate_version(base)?;
    let mut parts: Vec<u64> = base
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| "bad numbered tag".to_string())?;
    let distance: u64 = distance
        .parse()
        .map_err(|_| "bad git distance".to_string())?;
    let exact = distance == 0;
    let distance = distance
        .checked_add(extra_distance)
        .ok_or_else(|| "derived version overflow".to_string())?;
    parts[2] = parts[2]
        .checked_add(distance)
        .ok_or_else(|| "derived version overflow".to_string())?;
    if parts.iter().any(|part| *part > u64::from(u16::MAX)) {
        return Err("derived version exceeds browser-store limits".to_string());
    }
    Ok((format!("{}.{}.{}", parts[0], parts[1], parts[2]), exact))
}

pub(crate) fn plan_dir(version: &str) -> PathBuf {
    crate::repo_root().join(ARTIFACTS_ROOT).join(version)
}

pub(crate) fn read_plan(path: &Path) -> Result<Plan, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("missing release plan {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("bad release plan {}: {e}", path.display()))
}

pub(crate) fn expected_artifact_name(target: &str, version: &str) -> Option<String> {
    match target {
        "cli-linux-x86_64" => Some(format!("dezoomify-cli-v{version}-linux-x86_64.tar.gz")),
        "desktop-linux-x86_64" => Some(format!("dezoomify-desktop-v{version}-linux-x86_64.deb")),
        "desktop-windows-x86_64" => {
            Some(format!("dezoomify-desktop-v{version}-windows-x86_64.msi"))
        }
        "desktop-macos-aarch64" => Some(format!("dezoomify-desktop-v{version}-macos-aarch64.dmg")),
        "desktop-macos-x86_64" => Some(format!("dezoomify-desktop-v{version}-macos-x86_64.dmg")),
        "extension-chromium" => Some(format!("dezoomify-chromium-v{version}.zip")),
        "extension-firefox" => Some(format!("dezoomify-firefox-v{version}.zip")),
        _ => None,
    }
}

pub(crate) fn validate_version(version: &str) -> Result<(), String> {
    let mut parts = version.split('.');
    for _ in 0..3 {
        let p = parts
            .next()
            .ok_or_else(|| format!("version '{version}' is not a triplet"))?;
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("version '{version}' is not a numeric triplet"));
        }
    }
    if parts.next().is_some() {
        return Err(format!("version '{version}' is not a triplet"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
#[cfg(test)]
pub(crate) fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("xtask-release-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
pub(crate) fn plan_from_repo() -> Plan {
    let config = load_config().unwrap();
    let targets = load_targets().unwrap();
    let compat = load_compatibility().unwrap();
    let caps = load_capabilities().unwrap();
    let version = app_version().unwrap().0;
    Plan {
        tag: format!("rolling-v{version}"),
        version,
        channel: "rolling".to_string(),
        commit: "0".repeat(40),
        protocol: PlanProtocol {
            range: config.protocol.range.clone(),
            min_peer: config.protocol.min_peer.clone(),
            compatibility_current: compat.compatibility.current.clone(),
            compatibility_n_minus_1: compat.compatibility.n_minus_1.clone(),
        },
        schema_fingerprint: schema_fingerprint().unwrap(),
        capabilities: caps.capabilities.clone(),
        targets: targets
            .list
            .iter()
            .map(|t| PlanTarget {
                name: t.name.clone(),
                os: t.os.clone(),
                available: t.available,
            })
            .collect(),
    }
}
