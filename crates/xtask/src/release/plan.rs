//! `cargo xtask release plan`: freeze the deterministic release contract.
//!
//! The plan pins the version, tag, commit, protocol range, schema
//! fingerprint, capabilities, and per-target availability from
//! `release/*.toml` + `generated/*.json`, and refuses to silently replace
//! an existing plan for the same version (byte-identical rewrites are the
//! only idempotent case).

use super::common::{
    app_version, git_commit, load_capabilities, load_compatibility, load_config, load_targets,
    schema_fingerprint, validate_version, ARTIFACTS_ROOT,
};
use super::common::{Plan, PlanProtocol, PlanTarget};
use std::path::{Path, PathBuf};

pub(crate) fn plan_cmd(args: &[String]) -> Result<(), String> {
    let numbered = match args {
        [] => false,
        [arg] if arg == "--numbered" => true,
        _ => return Err("usage: cargo xtask release plan [--numbered]".to_string()),
    };
    let plan_path = release_plan(numbered)?;
    println!("release plan: {}", plan_path.display());
    Ok(())
}

/// Writes the deterministic plan and notes; returns the plan path.
pub(crate) fn release_plan(numbered: bool) -> Result<PathBuf, String> {
    release_plan_at(&crate::repo_root().join(ARTIFACTS_ROOT), numbered)
}

fn release_plan_at(base: &Path, numbered: bool) -> Result<PathBuf, String> {
    let (version, exactly_tagged) = app_version()?;
    validate_version(&version)?;
    let config = load_config()?;
    if numbered && !exactly_tagged {
        return Err(format!("numbered release requires tag v{version} at HEAD"));
    }
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
        tag: if numbered {
            format!("v{version}")
        } else {
            format!("rolling-v{version}")
        },
        channel: if numbered { "stable" } else { "rolling" }.to_string(),
        version: version.clone(),
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
    let dir = base.join(&version);
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
        "# dezoomify {}\n\n`{}` channel release, built from revision `{}`.\n\n\
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

#[cfg(test)]
mod tests {
    use super::super::common::{app_version, plan_from_repo, temp_root};
    use super::release_plan_at;

    #[test]
    fn plan_is_deterministic() {
        let version = app_version().unwrap().0;
        let base = temp_root("plan");
        let first = std::fs::read_to_string(release_plan_at(&base, false).unwrap()).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let second = std::fs::read_to_string(release_plan_at(&base, false).unwrap()).unwrap();
        assert_eq!(first, second);
        assert!(base.join(&version).join("notes.md").is_file());
        let _ = std::fs::remove_dir_all(&base);
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
}
