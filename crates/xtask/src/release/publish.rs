//! `cargo xtask release publish`: publish a verified release to GitHub.
//!
//! Publishing is the only stage that touches the network beyond the local
//! git remote: it requires the `gh` CLI to be authenticated, the plan's tag
//! to exist and point at the planned commit, and no pre-existing GitHub
//! release for the tag. The reviewed `SHA256SUMS` inventory is recorded
//! under `release/checksums/<version>/` before the release is created.

use super::common::{parse_sums, read_plan, Plan};
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
    release_verify(&p, &artifacts, false)?;
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
    let master = remote_master_commit()?;
    if master != plan.commit {
        return Err(format!(
            "plan pins {}, but origin/master is {master}; refusing to publish an outdated commit",
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
    if plan.channel == "stable" {
        let inventory = crate::repo_root()
            .join("release/checksums")
            .join(&plan.version);
        std::fs::create_dir_all(&inventory)
            .map_err(|e| format!("create {}: {e}", inventory.display()))?;
        std::fs::copy(artifacts.join("SHA256SUMS"), inventory.join("SHA256SUMS"))
            .map_err(|e| format!("copy SHA256SUMS: {e}"))?;
    }
    let mut cmd = Command::new("gh");
    cmd.args(["release", "create", &tag, "--target", &plan.commit])
        .arg("--title")
        .arg(format!("dezoomify v{}", plan.version))
        .arg("--notes-file")
        .arg(artifacts.join("notes.md"))
        .arg(artifacts.join("SHA256SUMS"))
        .arg(artifacts.join("SHA256SUMS.sig"));
    for name in parse_sums(&artifacts.join("SHA256SUMS"))? {
        cmd.arg(artifacts.join(&name));
        cmd.arg(artifacts.join(format!("{name}.sig")));
    }
    cmd.arg("--latest");
    let status = cmd.status().map_err(|e| format!("failed to run gh: {e}"))?;
    if !status.success() {
        return Err(format!("gh release create {tag} failed"));
    }
    Ok(())
}

fn remote_master_commit() -> Result<String, String> {
    let out = Command::new("git")
        .args(["ls-remote", "origin", "refs/heads/master"])
        .current_dir(crate::repo_root())
        .output()
        .map_err(|e| format!("failed to inspect origin/master: {e}"))?;
    let text = String::from_utf8(out.stdout).map_err(|e| format!("git output: {e}"))?;
    let commit = text
        .split_whitespace()
        .next()
        .ok_or_else(|| "origin/master did not resolve".to_string())?;
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
