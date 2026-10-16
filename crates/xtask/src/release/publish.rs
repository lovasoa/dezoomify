//! `cargo xtask release publish`: publish a verified release to GitHub.
//!
//! Publishing is the only stage that touches the network beyond the local
//! git remote: it requires the `gh` CLI to be authenticated, the plan's tag
//! to exist and point at the planned commit, and no pre-existing GitHub
//! release for the tag.

use super::common::{expected_artifact_name, read_plan, Plan};
use super::verify::release_verify;
use std::path::PathBuf;
use std::process::Command;

pub(crate) fn publish_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut artifacts: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(
                    args.get(i).ok_or("missing --plan <path>")?.clone(),
                ));
            }
            "--artifacts" => {
                i += 1;
                artifacts = Some(PathBuf::from(
                    args.get(i).ok_or("missing --artifacts <path>")?.clone(),
                ));
            }
            other => return Err(format!("unknown release publish arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release publish --plan <path> --artifacts <path>".to_string(),
        );
    };
    let p = read_plan(&plan)?;
    release_verify(&p, &artifacts)?;
    release_publish(&p, &artifacts)?;
    println!("release publish: {}", p.tag);
    Ok(())
}

fn release_publish(plan: &Plan, artifacts: &std::path::Path) -> Result<(), String> {
    if Command::new("gh")
        .args(["auth", "status"])
        .output()
        .is_err()
    {
        return Err("gh is not available or authenticated; cannot publish".to_string());
    }
    let main = remote_main_commit()?;
    if main != plan.commit {
        return Err(format!(
            "plan pins {}, but origin/main is {main}; refusing to publish an outdated commit",
            plan.commit
        ));
    }
    match remote_tag_commit(&plan.tag)? {
        Some(commit) if commit != plan.commit => {
            return Err(format!(
                "tag {} points at {commit}, not the planned commit {}",
                plan.tag, plan.commit
            ));
        }
        None if plan.channel == "stable" => {
            return Err(format!(
                "tag {} does not exist on origin; push it before publishing",
                plan.tag
            ));
        }
        _ => {}
    }
    let tag = plan.tag.clone();
    let exists = Command::new("gh")
        .args(["release", "view", &tag])
        .current_dir(crate::repo_root())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists {
        return Err(format!(
            "GitHub release {tag} already exists; refusing to republish"
        ));
    }
    let manifest_path = artifacts.join("latest.json");
    let manifest = super::updater::manifest(plan, artifacts)?;
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write latest.json: {error}"))?;
    let mut cmd = Command::new("gh");
    cmd.args(["release", "create", &tag, "--target", &plan.commit])
        .arg("--title")
        .arg(format!("dezoomify v{}", plan.version))
        .arg("--notes-file")
        .arg(artifacts.join("notes.md"));
    let mut assets = std::collections::BTreeSet::new();
    for target in &plan.targets {
        let name = expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        assets.insert(artifacts.join(&target.name).join(name));
    }
    // Windows uses the same MSI for installation and updating.
    assets.extend(super::updater::assets(plan, artifacts));
    assets.insert(manifest_path);
    cmd.args(assets).arg("--draft");
    let status = cmd.status().map_err(|e| format!("failed to run gh: {e}"))?;
    if !status.success() {
        return Err(format!("gh release create {tag} failed"));
    }
    // Expose the new latest endpoint only after every asset has uploaded.
    let status = Command::new("gh")
        .args(["release", "edit", &tag, "--draft=false", "--latest"])
        .current_dir(crate::repo_root())
        .status()
        .map_err(|error| format!("publish GitHub release: {error}"))?;
    if !status.success() {
        return Err(format!(
            "gh release edit {tag} failed; release remains a draft"
        ));
    }
    Ok(())
}

fn remote_main_commit() -> Result<String, String> {
    let out = Command::new("git")
        .args(["ls-remote", "origin", "refs/heads/main"])
        .current_dir(crate::repo_root())
        .output()
        .map_err(|e| format!("failed to inspect origin/main: {e}"))?;
    let text = String::from_utf8(out.stdout).map_err(|e| format!("git output: {e}"))?;
    let commit = text
        .split_whitespace()
        .next()
        .ok_or_else(|| "origin/main did not resolve".to_string())?;
    Ok(commit.to_string())
}

fn remote_tag_commit(tag: &str) -> Result<Option<String>, String> {
    let reference = format!("refs/tags/{tag}");
    let peeled = format!("{reference}^{{}}");
    let out = Command::new("git")
        .args(["ls-remote", "origin", &reference, &peeled])
        .current_dir(crate::repo_root())
        .output()
        .map_err(|e| format!("failed to inspect origin tag {tag}: {e}"))?;
    if !out.status.success() {
        return Err(format!("failed to inspect origin tag {tag}"));
    }
    let text = String::from_utf8(out.stdout).map_err(|e| format!("git output: {e}"))?;
    let resolve = |name: &str| {
        text.lines().find_map(|line| {
            let (commit, found) = line.split_once(char::is_whitespace)?;
            (found.trim() == name).then_some(commit)
        })
    };
    let commit = resolve(&peeled).or_else(|| resolve(&reference));
    match commit {
        None => Ok(None),
        Some(value) if value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit()) => {
            Ok(Some(value.to_string()))
        }
        Some(_) => Err(format!("origin tag {tag} returned a malformed commit")),
    }
}
