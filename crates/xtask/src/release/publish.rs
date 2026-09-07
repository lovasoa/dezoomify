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
    let mut draft = false;
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
            "--draft" => draft = true,
            other => return Err(format!("unknown release publish arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release publish --plan <path> --artifacts <path> [--draft]"
                .to_string(),
        );
    };
    let p = read_plan(&plan)?;
    release_verify(&p, &artifacts, false)?;
    release_publish(&p, &artifacts, draft)?;
    println!("release publish: {}", p.tag);
    Ok(())
}

fn release_publish(plan: &Plan, artifacts: &std::path::Path, draft: bool) -> Result<(), String> {
    if Command::new("gh")
        .args(["auth", "status"])
        .output()
        .is_err()
    {
        return Err("gh is not available or authenticated; cannot publish".to_string());
    }
    // The tag must exist and point at the planned revision; the release is
    // never published for a revision other than the one it is tagged with.
    let tag_commit = tag_commit(&plan.tag)?;
    if tag_commit != plan.commit {
        return Err(format!(
            "tag {} points at {tag_commit}, but the plan pins {}; regenerate the plan from the tagged revision",
            plan.tag, plan.commit
        ));
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
    // Record the reviewed inventory before publishing.
    let inventory = crate::repo_root()
        .join("release/checksums")
        .join(&plan.version);
    std::fs::create_dir_all(&inventory)
        .map_err(|e| format!("create {}: {e}", inventory.display()))?;
    std::fs::copy(artifacts.join("SHA256SUMS"), inventory.join("SHA256SUMS"))
        .map_err(|e| format!("copy SHA256SUMS: {e}"))?;
    let mut cmd = Command::new("gh");
    cmd.args(["release", "create", &tag, "--target", &plan.commit])
        .arg("--title")
        .arg(format!("dezoomify {}", plan.tag))
        .arg("--notes-file")
        .arg(artifacts.join("notes.md"))
        .arg(artifacts.join("SHA256SUMS"));
    for name in parse_sums(&artifacts.join("SHA256SUMS"))? {
        cmd.arg(artifacts.join(&name));
        cmd.arg(artifacts.join(format!("{name}.sig")));
    }
    if draft {
        cmd.arg("--draft");
    }
    let status = cmd.status().map_err(|e| format!("failed to run gh: {e}"))?;
    if !status.success() {
        return Err(format!("gh release create {tag} failed"));
    }
    Ok(())
}

/// Resolves the tag to the commit it points at, fetching it from the origin
/// when the shallow/CI checkout lacks it. Fails closed when the tag does
/// not exist.
fn tag_commit(tag: &str) -> Result<String, String> {
    let resolve = |label: &str| -> Option<String> {
        let out = Command::new("git")
            .args(["rev-parse", &format!("{label}^{{commit}}")])
            .current_dir(crate::repo_root())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8(out.stdout).ok()?;
        let commit = s.trim().to_string();
        (commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())).then_some(commit)
    };
    if let Some(commit) = resolve(tag) {
        return Ok(commit);
    }
    let fetched = Command::new("git")
        .args([
            "fetch",
            "--no-tags",
            "origin",
            &format!("refs/tags/{tag}:refs/tags/{tag}"),
        ])
        .current_dir(crate::repo_root())
        .status()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !fetched.success() {
        return Err(format!(
            "tag {tag} does not exist; create and push it before publishing"
        ));
    }
    resolve(tag).ok_or_else(|| format!("tag {tag} exists but does not resolve to a commit"))
}
