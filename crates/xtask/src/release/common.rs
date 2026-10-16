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
    pub(crate) channel: String,
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

/// Cargo owns the major/minor series; the complete first-parent history owns
/// the patch. An annotated matching tag can promote, but never assign, a version.
pub(crate) fn app_version() -> Result<(String, bool), String> {
    app_version_at(&crate::repo_root())
}

fn app_version_at(root: &Path) -> Result<(String, bool), String> {
    if git_output_at(root, &["rev-parse", "--is-shallow-repository"])? != "false" {
        return Err(
            "cannot derive app version from shallow history; fetch the complete history"
                .to_string(),
        );
    }
    let text = std::fs::read_to_string(root.join("Cargo.toml"))
        .map_err(|e| format!("read workspace Cargo.toml: {e}"))?;
    let manifest: toml::Value =
        toml::from_str(&text).map_err(|e| format!("parse workspace Cargo.toml: {e}"))?;
    let base = manifest
        .get("workspace")
        .and_then(|workspace| workspace.get("package"))
        .and_then(|package| package.get("version"))
        .and_then(toml::Value::as_str)
        .ok_or("workspace.package.version must be a numeric version")?;
    let (series, _) = base
        .rsplit_once('.')
        .ok_or("workspace version must be a triplet")?;
    let count = git_output_at(root, &["rev-list", "--first-parent", "--count", "HEAD"])?;
    let version = format!("{series}.{count}");
    validate_version(&version)?;
    let tag = format!("refs/tags/v{version}");
    let tagged = git_output_at(
        root,
        &[
            "for-each-ref",
            "--points-at=HEAD",
            "--format=%(refname)%00%(objecttype)",
            &tag,
        ],
    )?;
    Ok((version, tagged == format!("{tag}\0tag")))
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
    let mut parts = version.split('.');
    for limit in [255_u64, 255, 65535] {
        let p = parts
            .next()
            .ok_or_else(|| format!("version '{version}' is not a triplet"))?;
        if p.is_empty()
            || !p.chars().all(|c| c.is_ascii_digit())
            || (p.len() > 1 && p.starts_with('0'))
        {
            return Err(format!("version '{version}' is not a numeric triplet"));
        }
        // MSI ProductVersion is the tightest shared packaging constraint:
        // https://learn.microsoft.com/windows/win32/msi/productversion
        if p.parse::<u64>().map_or(true, |part| part > limit) {
            return Err(format!(
                "version '{version}' exceeds packaging limits (255.255.65535)"
            ));
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
    let targets = load_targets().unwrap();
    let caps = load_capabilities().unwrap();
    let version = app_version().unwrap().0;
    Plan {
        tag: format!("rolling-v{version}"),
        version,
        channel: "rolling".to_string(),
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
    use super::{app_version_at, git_output_at, temp_root};
    use std::path::{Path, PathBuf};

    fn git(root: &Path, args: &[&str]) {
        git_output_at(root, args).unwrap();
    }

    fn set_version(root: &Path, version: &str) {
        std::fs::write(
            root.join("Cargo.toml"),
            format!("[workspace.package]\nversion = \"{version}\"\n"),
        )
        .unwrap();
    }

    fn repository() -> PathBuf {
        let root = temp_root("version-history");
        git(&root, &["init", "--initial-branch=main"]);
        git(&root, &["config", "user.name", "Release Test"]);
        git(&root, &["config", "user.email", "release@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(&root, &["config", "tag.gpgsign", "false"]);
        set_version(&root, "3.1.0");
        commit(&root);
        root
    }

    fn commit(root: &Path) {
        git(root, &["add", "Cargo.toml"]);
        git(root, &["commit", "--allow-empty", "-m", "test commit"]);
    }

    #[test]
    fn versions_follow_cargo_and_history_with_annotated_promotion() {
        let root = repository();
        assert_eq!(app_version_at(&root).unwrap(), ("3.1.1".into(), false));
        git(&root, &["tag", "-a", "v99.0.1", "-m", "old scheme"]);
        git(&root, &["checkout", "-b", "feature"]);
        commit(&root);
        commit(&root);
        git(&root, &["checkout", "main"]);
        commit(&root);
        git(
            &root,
            &["merge", "--no-ff", "feature", "-m", "merge feature"],
        );
        assert_eq!(app_version_at(&root).unwrap().0, "3.1.3");
        set_version(&root, "3.2.999999");
        commit(&root);
        assert_eq!(app_version_at(&root).unwrap().0, "3.2.4");
        set_version(&root, "4.0.0");
        commit(&root);
        assert_eq!(app_version_at(&root).unwrap().0, "4.0.5");

        git(&root, &["tag", "v4.0.5"]);
        assert!(!app_version_at(&root).unwrap().1);
        git(&root, &["tag", "-d", "v4.0.5"]);
        git(&root, &["tag", "-a", "v4.0.6", "-m", "mismatched patch"]);
        assert!(!app_version_at(&root).unwrap().1);
        git(&root, &["tag", "-a", "v4.0.5", "-m", "promote"]);
        assert_eq!(app_version_at(&root).unwrap(), ("4.0.5".into(), true));
        commit(&root);
        assert_eq!(app_version_at(&root).unwrap(), ("4.0.6".into(), false));

        let shallow = temp_root("version-shallow");
        git(
            &root,
            &[
                "clone",
                "--depth=1",
                &format!("file://{}", root.display()),
                shallow.to_str().unwrap(),
            ],
        );
        assert!(app_version_at(&shallow)
            .unwrap_err()
            .contains("shallow history"));
        set_version(&root, "256.0.0");
        assert!(app_version_at(&root)
            .unwrap_err()
            .contains("packaging limits"));
        std::fs::remove_dir_all(shallow).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
