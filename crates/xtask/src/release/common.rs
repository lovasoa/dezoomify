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
pub(crate) struct Targets {
    #[serde(rename = "target")]
    pub(crate) list: Vec<TargetEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TargetEntry {
    pub(crate) name: String,
    pub(crate) os: String,
}

#[derive(Deserialize)]
pub(crate) struct Capabilities {
    pub(crate) capabilities: Vec<String>,
}

/// Release targets and their host bundlers are declared in
/// `release/targets.toml`.
/// Every declared target is mandatory; a missing recipe, host, tool, or
/// artifact fails the release rather than narrowing its inventory.
pub(crate) fn load_targets() -> Result<Targets, String> {
    parse_toml("release/targets.toml")
}

fn parse_toml<T: for<'de> Deserialize<'de>>(rel: &str) -> Result<T, String> {
    let text = std::fs::read_to_string(crate::repo_root().join(rel))
        .map_err(|e| format!("missing {rel}: {e}"))?;
    toml::from_str(&text).map_err(|e| format!("bad {rel}: {e}"))
}

pub(crate) fn load_capabilities() -> Result<Capabilities, String> {
    let path = crate::repo_root().join("generated/release-capabilities.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing generated/release-capabilities.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("bad release-capabilities.json: {e}"))
}

// ---------------------------------------------------------------------------
// Plan document
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct Plan {
    pub(crate) version: String,
    pub(crate) tag: String,
    pub(crate) commit: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) targets: Vec<PlanTarget>,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanTarget {
    pub(crate) name: String,
    pub(crate) os: String,
}

pub(crate) fn git_output(args: &[&str]) -> Result<String, String> {
    git_output_at(&crate::repo_root(), args)
}

fn git_output_at(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let cause = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            cause.chars().take(2048).collect::<String>().trim()
        ));
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

/// UTC calendar version, without leading zeroes. Coordinated builds must pass
/// the frozen DEZOOMIFY_VERSION so crossing midnight cannot change their version.
pub(crate) fn app_version() -> Result<String, String> {
    let version = std::env::var("DEZOOMIFY_VERSION").unwrap_or_else(|_| {
        let date = time::OffsetDateTime::now_utc().date();
        format!(
            "{}.{}.{}",
            date.year() - 2000,
            u8::from(date.month()),
            date.day()
        )
    });
    validate_version(&version)?;
    Ok(version)
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
        "desktop-linux-x86_64" => Some("dezoomify-desktop.deb".into()),
        "desktop-windows-x86_64" => Some("dezoomify-desktop.msi".into()),
        "desktop-macos-aarch64" => Some("dezoomify-desktop.dmg".into()),
        "extension-chromium" => Some(format!("dezoomify-chromium-v{version}.zip")),
        "extension-firefox" => Some(format!("dezoomify-firefox-v{version}.zip")),
        _ => None,
    }
}

pub(crate) fn validate_version(version: &str) -> Result<(), String> {
    let invalid =
        || format!("version '{version}' must be a UTC date YY.M.D without leading zeroes");
    let parts = version
        .split('.')
        .map(|part| {
            if part.is_empty()
                || !part.chars().all(|c| c.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return Err(invalid());
            }
            part.parse::<u8>().map_err(|_| invalid())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let [year, month, day] = parts.as_slice() else {
        return Err(invalid());
    };
    if *year > 99 {
        return Err(invalid());
    }
    let month = time::Month::try_from(*month).map_err(|_| invalid())?;
    time::Date::from_calendar_date(2000 + i32::from(*year), month, *day).map_err(|_| invalid())?;
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
    let targets = load_targets().unwrap();
    let caps = load_capabilities().unwrap();
    let version = "26.10.26".to_string();
    Plan {
        tag: version.clone(),
        version,
        commit: "0".repeat(40),
        capabilities: caps.capabilities,
        targets: targets
            .list
            .iter()
            .map(|t| PlanTarget {
                name: t.name.clone(),
                os: t.os.clone(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_version;

    #[test]
    fn versions_are_real_calendar_dates_accepted_by_every_packager() {
        for version in ["26.10.26", "26.1.1", "28.2.29"] {
            validate_version(version).unwrap();
        }
        for version in [
            "2026.10.26",
            "26.01.1",
            "26.2.29",
            "26.13.1",
            "26.1.0",
            "3.1.783",
            "26.1.1.1",
        ] {
            assert!(validate_version(version).is_err(), "{version}");
        }
    }
}
