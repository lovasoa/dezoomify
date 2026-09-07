//! `cargo xtask release plan`: freeze the deterministic release contract.
//!
//! The plan pins the version, tag, commit, protocol range, schema
//! fingerprint, capabilities, and per-target availability from
//! `release/*.toml` + `generated/*.json`, and refuses to silently replace
//! an existing plan for the same version (byte-identical rewrites are the
//! only idempotent case).

use super::common::{
    git_commit, load_capabilities, load_compatibility, load_config, load_targets,
    schema_fingerprint, validate_version, ARTIFACTS_ROOT,
};
use super::common::{Plan, PlanProtocol, PlanTarget};
use std::path::{Path, PathBuf};

pub(crate) fn plan_cmd(args: &[String]) -> Result<(), String> {
    let mut version: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--version" => {
                i += 1;
                version = Some(args.get(i).ok_or("missing --version <v>")?.clone());
            }
            other => return Err(format!("unknown release plan arg '{other}'")),
        }
        i += 1;
    }
    let config = load_config()?;
    let version = version.unwrap_or_else(|| config.release.version.clone());
    let plan_path = release_plan(&version)?;
    println!("release plan: {}", plan_path.display());
    Ok(())
}

/// Writes the deterministic plan and notes; returns the plan path.
pub(crate) fn release_plan(version: &str) -> Result<PathBuf, String> {
    release_plan_at(&crate::repo_root().join(ARTIFACTS_ROOT), version)
}

fn release_plan_at(base: &Path, version: &str) -> Result<PathBuf, String> {
    validate_version(version)?;
    let config = load_config()?;
    if version != config.release.version {
        return Err(format!(
            "version {version} does not match release/config.toml ({})",
            config.release.version
        ));
    }
    assert_app_versions(version)?;
    let targets = load_targets()?;
    let compat = load_compatibility()?;
    let caps = load_capabilities()?;
    if config.protocol.range != compat.compatibility.current {
        return Err(format!(
            "protocol range {} disagrees with compatibility current {}",
            config.protocol.range, compat.compatibility.current
        ));
    }
    if caps.protocol != config.protocol.range {
        return Err(format!(
            "release capabilities protocol {} disagrees with config range {}",
            caps.protocol, config.protocol.range
        ));
    }
    let commit = git_commit()?;
    let fingerprint = schema_fingerprint()?;
    let plan = Plan {
        version: version.to_string(),
        tag: format!("v{version}"),
        channel: config.release.channel.clone(),
        commit,
        protocol: PlanProtocol {
            range: config.protocol.range.clone(),
            min_peer: config.protocol.min_peer.clone(),
            compatibility_current: compat.compatibility.current.clone(),
            compatibility_n_minus_1: compat.compatibility.n_minus_1.clone(),
        },
        schema_fingerprint: fingerprint.clone(),
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
    };
    if plan.targets.iter().filter(|t| t.available).count() == 0 {
        return Err("release plan has no buildable targets".to_string());
    }
    let dir = base.join(version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let plan_path = dir.join("plan.json");
    let json = serde_json::to_string_pretty(&plan).map_err(|e| format!("serialize plan: {e}"))?;
    // Determinism: byte-identical for the same inputs; refuse to silently
    // replace an existing plan for the same version.
    if plan_path.exists() {
        let existing =
            std::fs::read_to_string(&plan_path).map_err(|e| format!("read existing plan: {e}"))?;
        if existing != json {
            return Err(format!(
                "plan {} already exists with different content; bump the version or remove target/release-dist/{version}",
                plan_path.display()
            ));
        }
        return Ok(plan_path);
    }
    std::fs::write(&plan_path, json + "\n")
        .map_err(|e| format!("write {}: {e}", plan_path.display()))?;
    let notes = release_notes(&plan)?;
    std::fs::write(dir.join("notes.md"), notes).map_err(|e| format!("write notes.md: {e}"))?;
    Ok(plan_path)
}

fn release_notes(plan: &Plan) -> Result<String, String> {
    let mut notes = format!(
        "# dezoomify {}\n\n`{}` channel release, built from the tagged \
        revision `{}`.\n\n\
        - Supported protocol: `{}` (peers back to `{}`)\n\
        - Schema fingerprint: `{}`\n\
        - Capabilities: {}\n\n\
        ## Artifacts\n\n\
        | Artifact | Sha256 |\n|---|---|\n",
        plan.tag,
        plan.channel,
        &plan.commit[..12],
        plan.protocol.range,
        plan.protocol.min_peer,
        plan.schema_fingerprint,
        plan.capabilities.join(", "),
    );
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let name = super::common::expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        notes.push_str(&format!("| `{name}` | see `SHA256SUMS` |\n"));
    }
    notes.push_str(
        "\nEvery artifact ships with a GPG detached signature (`.sig`); the \
        signing public key is `release/gpg-public-key.asc` in the repository. \
        Verify digests against `SHA256SUMS` before use.\n\n\
        ## Install\n\n\
        See the [user guide](https://github.com/lovasoa/dezoomify/blob/master/docs/user/README.md).\n\n",
    );
    let curated = crate::repo_root()
        .join("release/notes")
        .join(format!("{}.md", plan.version));
    if let Ok(text) = std::fs::read_to_string(&curated) {
        notes.push_str("## User-visible changes\n\n");
        notes.push_str(text.trim_end());
        notes.push('\n');
    }
    Ok(notes)
}

// The release version is one version across all apps (docs/releases.md);
// the plan stage fails closed when any app manifest disagrees.
fn assert_app_versions(version: &str) -> Result<(), String> {
    let json = |rel: &str| -> Result<String, String> {
        let path = crate::repo_root().join(rel);
        let text = std::fs::read_to_string(&path).map_err(|e| format!("missing {rel}: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad {rel}: {e}"))?;
        value
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("{rel} lacks version"))
    };
    let cargo = |rel: &str| -> Result<String, String> {
        let text = std::fs::read_to_string(crate::repo_root().join(rel))
            .map_err(|e| format!("missing {rel}: {e}"))?;
        let needle = "version = \"";
        let i = text
            .find(needle)
            .ok_or_else(|| format!("{rel} lacks version"))?;
        let rest = &text[i + needle.len()..];
        let end = rest.find('"').ok_or_else(|| format!("{rel} bad version"))?;
        Ok(rest[..end].to_string())
    };
    let rust_const = |rel: &str, name: &str| -> Result<String, String> {
        let text = std::fs::read_to_string(crate::repo_root().join(rel))
            .map_err(|e| format!("missing {rel}: {e}"))?;
        let needle = format!("{name}: &str = \"");
        let i = text
            .find(&needle)
            .ok_or_else(|| format!("{rel} lacks {name}"))?;
        let rest = &text[i + needle.len()..];
        let end = rest.find('"').ok_or_else(|| format!("{rel} bad {name}"))?;
        Ok(rest[..end].to_string())
    };
    let sources: Vec<(&str, String)> = vec![
        ("apps/cli/Cargo.toml", cargo("apps/cli/Cargo.toml")?),
        (
            "apps/desktop/src-tauri/Cargo.toml",
            cargo("apps/desktop/src-tauri/Cargo.toml")?,
        ),
        (
            "apps/desktop/src-tauri/tauri.conf.json",
            json("apps/desktop/src-tauri/tauri.conf.json")?,
        ),
        (
            "apps/desktop/package.json",
            json("apps/desktop/package.json")?,
        ),
        (
            "apps/desktop/src-tauri/src/bin/dezoomify-native-host.rs",
            rust_const(
                "apps/desktop/src-tauri/src/bin/dezoomify-native-host.rs",
                "HOST_VERSION",
            )?,
        ),
        (
            "apps/extension/package.json",
            json("apps/extension/package.json")?,
        ),
        (
            "apps/extension/src/manifest/base.json",
            json("apps/extension/src/manifest/base.json")?,
        ),
        (
            "apps/extension/generated/manifest.chromium.json",
            json("apps/extension/generated/manifest.chromium.json")?,
        ),
        (
            "apps/extension/generated/manifest.firefox.json",
            json("apps/extension/generated/manifest.firefox.json")?,
        ),
    ];
    let mismatched: Vec<&str> = sources
        .iter()
        .filter(|(_, found)| found != version)
        .map(|(rel, _)| *rel)
        .collect();
    if mismatched.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "app versions disagree with release version {version}; bump {mismatched:?} too"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::common::{load_config, plan_from_repo, temp_root};
    use super::{release_plan, release_plan_at};

    #[test]
    fn plan_is_deterministic() {
        let version = load_config().unwrap().release.version;
        let base = temp_root("plan");
        let first = std::fs::read_to_string(release_plan_at(&base, &version).unwrap()).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let second = std::fs::read_to_string(release_plan_at(&base, &version).unwrap()).unwrap();
        assert_eq!(first, second);
        assert!(base.join(&version).join("notes.md").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn plan_refuses_version_mismatch() {
        assert!(release_plan("9.9.9").is_err());
        assert!(release_plan("not-a-version").is_err());
    }

    #[test]
    fn desktop_targets_track_bundle_recipes() {
        // Linux deb is verified (`cargo xtask build desktop` output);
        // Windows msi/nsis and macOS dmg have no matching host or tools on
        // this Linux host, so they stay unavailable.
        let plan = plan_from_repo();
        let available = |name: &str| {
            plan.targets
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("{name} in inventory"))
                .available
        };
        assert!(available("desktop-linux-x86_64"));
        assert!(!available("desktop-windows-x86_64"));
        assert!(!available("desktop-macos-aarch64"));
        assert!(!available("desktop-macos-x86_64"));
    }

    #[test]
    fn app_versions_agree_with_the_release_version() {
        // Drift guard: a bump that misses any app manifest fails the plan.
        let version = load_config().unwrap().release.version;
        assert_eq!(super::assert_app_versions(&version), Ok(()));
        let err = super::assert_app_versions("9.9.9").unwrap_err();
        assert!(
            err.contains("apps/cli/Cargo.toml"),
            "error lists offenders: {err}"
        );
    }
}
