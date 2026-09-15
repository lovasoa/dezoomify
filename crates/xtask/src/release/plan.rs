//! `cargo xtask release plan`: freeze the deterministic release contract.
//!
//! The plan pins the version, tag, commit, protocol range, schema
//! fingerprint, capabilities, and per-target availability from
//! `release/*.toml` + `generated/*.json`, and refuses to silently replace
//! an existing plan for the same version (byte-identical rewrites are the
//! only idempotent case).

use super::common::{
    app_version, git_commit, git_output, load_capabilities, load_compatibility, load_config,
    load_targets, schema_fingerprint, validate_version, ARTIFACTS_ROOT,
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
    let path = crate::repo_root().join("docs/user/start-here.md");
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let introduction = text
        .split("\n\n")
        .nth(2)
        .ok_or("docs/user/start-here.md has no introduction")?
        .replace('\n', " ");
    let reference = format!("refs/tags/{}", plan.tag);
    let tagged = git_output(&[
        "for-each-ref",
        "--format=%(objecttype)%00%(contents)",
        &reference,
    ])?;
    let changes = match tagged.split_once('\0') {
        Some(("tag", description)) if !description.trim().is_empty() => description.trim().into(),
        _ => {
            let parent = format!("{}^", plan.commit);
            let previous = git_output(&[
                "describe",
                "--first-parent",
                "--tags",
                "--match=v[0-9]*.[0-9]*.[0-9]*",
                "--match=rolling-v[0-9]*.[0-9]*.[0-9]*",
                "--abbrev=0",
                &parent,
            ])?;
            let range = format!("{previous}..{}", plan.commit);
            git_output(&["log", "--first-parent", "--format=- %s", &range])?
        }
    };
    Ok(format!(
        "# dezoomify v{}\n\n{introduction}\n\n{changes}\n",
        plan.version
    ))
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
        let notes = std::fs::read_to_string(base.join(&version).join("notes.md")).unwrap();
        assert!(notes.starts_with(&format!("# dezoomify v{version}\n\n")));
        assert!(!notes.contains("rolling"));
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let second = std::fs::read_to_string(release_plan_at(&base, false).unwrap()).unwrap();
        assert_eq!(first, second);
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
