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
    for asset in assets {
        cmd.arg(labeled_asset(&asset)?);
    }
    cmd.arg("--draft");
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

/// GitHub's display labels do not change the filenames used by store
/// submissions, direct downloads, and the desktop updater.
fn labeled_asset(path: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid release asset filename: {}", path.display()))?;
    let (unsigned, signature) = match name.strip_suffix(".sig") {
        Some(name) => (name, true),
        None => (name, false),
    };
    let label = if unsigned == "latest.json" {
        "Desktop updater manifest"
    } else if unsigned.starts_with("dezoomify-desktop-v") {
        if unsigned.ends_with("-windows-x86_64.msi") {
            "Windows installer — x64 (MSI)"
        } else if unsigned.ends_with("-linux-x86_64.deb") {
            "Linux installer — x64 (DEB)"
        } else if unsigned.ends_with("-macos-aarch64.dmg") {
            "macOS installer — Apple Silicon (DMG)"
        } else if unsigned.ends_with("-macos-aarch64.app.tar.gz") {
            "macOS updater — Apple Silicon"
        } else {
            return Err(format!("release asset has no display label: {name}"));
        }
    } else if unsigned.starts_with("dezoomify-cli-v") && unsigned.ends_with("-linux-x86_64.tar.gz")
    {
        "Command line — Linux x64 (tar.gz)"
    } else if unsigned.starts_with("dezoomify-chromium-v") && unsigned.ends_with(".zip") {
        "Browser extension — Chromium (ZIP)"
    } else if unsigned.starts_with("dezoomify-firefox-v") && unsigned.ends_with(".zip") {
        "Browser extension — Firefox (ZIP)"
    } else {
        return Err(format!("release asset has no display label: {name}"));
    };
    let mut argument = path.as_os_str().to_owned();
    argument.push("#");
    argument.push(label);
    if signature {
        argument.push(" — signature");
    }
    Ok(argument)
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

#[cfg(test)]
mod tests {
    use super::labeled_asset;
    use crate::release::common::{expected_artifact_name, plan_from_repo};
    use std::collections::BTreeSet;
    use std::path::Path;

    #[test]
    fn all_release_uploads_keep_filenames_and_have_display_labels() {
        let plan = plan_from_repo();
        let root = Path::new("artifacts");
        let mut assets = BTreeSet::new();
        for target in &plan.targets {
            assets.insert(
                root.join(&target.name)
                    .join(expected_artifact_name(&target.name, &plan.version).unwrap()),
            );
        }
        assets.extend(crate::release::updater::assets(&plan, root));
        assets.insert(root.join("latest.json"));
        // Six primary artifacts, macOS updater, three signatures, and manifest.
        assert_eq!(assets.len(), 11);
        for asset in assets {
            let argument = labeled_asset(&asset).unwrap();
            let (filename, label) = argument.to_str().unwrap().split_once('#').unwrap();
            assert_eq!(Path::new(filename), asset);
            assert!(!label.is_empty());
            assert!(!label.contains(&plan.version));
            assert_eq!(label.ends_with(" — signature"), filename.ends_with(".sig"));
        }
    }

    #[test]
    fn installers_name_platform_architecture_and_format() {
        for (file, label) in [
            (
                "dezoomify-desktop-v3.1.123-windows-x86_64.msi",
                "Windows installer — x64 (MSI)",
            ),
            (
                "dezoomify-desktop-v3.1.123-linux-x86_64.deb",
                "Linux installer — x64 (DEB)",
            ),
            (
                "dezoomify-desktop-v3.1.123-macos-aarch64.dmg",
                "macOS installer — Apple Silicon (DMG)",
            ),
        ] {
            assert_eq!(
                labeled_asset(Path::new(file)).unwrap(),
                std::ffi::OsString::from(format!("{file}#{label}"))
            );
        }
        assert!(labeled_asset(Path::new("unrecognized.bin")).is_err());
    }
}
