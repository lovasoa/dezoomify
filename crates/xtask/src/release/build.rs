//! `cargo xtask release build`: build one target's artifact per plan.
//!
//! Each target builds into `target/release-dist/<version>/<target>/` and
//! appends its digest to a per-target `SHA256SUMS` fragment. Fragments stay
//! separate so parallel builds never share state; the `sign` stage
//! assembles the aggregate deterministically in plan order. Rebuilds are
//! refused: digests must stay append-only and stable.

use super::common::{append_sums, expected_artifact_name, git_commit, plan_dir, read_plan, Plan};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn build_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut target: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(
                    args.get(i).ok_or("missing --plan <path>")?.clone(),
                ));
            }
            "--target" => {
                i += 1;
                target = Some(args.get(i).ok_or("missing --target <name>")?.clone());
            }
            other => return Err(format!("unknown release build arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(target)) = (plan, target) else {
        return Err("usage: cargo xtask release build --plan <path> --target <name>".to_string());
    };
    let built = release_build(&read_plan(&plan)?, &target)?;
    println!("release build {target}: {}", built.display());
    Ok(())
}

/// Builds one target's artifact and appends its digest to the aggregate
/// SHA256SUMS. Refuses to rebuild an existing artifact (digests must stay
/// append-only and stable).
fn release_build(plan: &Plan, target: &str) -> Result<PathBuf, String> {
    let entry = plan
        .targets
        .iter()
        .find(|t| t.name == target)
        .ok_or_else(|| format!("target '{target}' is not in the release plan"))?;
    if !entry.available {
        return Err(format!(
            "target '{target}' is unavailable in this release (see release/targets.toml and docs/releases.md)"
        ));
    }
    if plan.commit != git_commit()? {
        return Err(
            "release plan was generated from a different commit; regenerate the plan".to_string(),
        );
    }
    let artifact = expected_artifact_name(target, &plan.version)
        .ok_or_else(|| format!("target '{target}' has no artifact name rule"))?;
    let dir = plan_dir(&plan.version).join(target);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let out = dir.join(&artifact);
    if out.exists() {
        return Err(format!(
            "artifact {} already exists; remove target/release-dist/{}/{} to rebuild",
            out.display(),
            plan.version,
            target
        ));
    }
    match target {
        "cli-linux-x86_64" => build_cli_artifact(&entry.os, &out)?,
        "desktop-linux-x86_64"
        | "desktop-windows-x86_64"
        | "desktop-macos-aarch64"
        | "desktop-macos-x86_64" => build_desktop_artifact(target, &entry.os, &out)?,
        "extension-chromium" => build_extension_artifact("chromium", &out)?,
        "extension-firefox" => build_extension_artifact("firefox", &out)?,
        other => return Err(format!("target '{other}' has no build recipe")),
    }
    if !out.is_file() || std::fs::metadata(&out).map_err(|e| e.to_string())?.len() == 0 {
        return Err(format!("build produced no artifact at {}", out.display()));
    }
    // Per-target digest fragment; the aggregate SHA256SUMS is assembled
    // deterministically at sign time (parallel builds never share state).
    let fragment = dir.join("SHA256SUMS");
    if fragment.exists() {
        return Err(format!(
            "digest fragment {} already exists; remove target/release-dist/{}/{} to rebuild",
            fragment.display(),
            plan.version,
            target
        ));
    }
    append_sums(&fragment, &format!("{target}/{artifact}"), &out)?;
    Ok(out)
}

fn build_cli_artifact(target_os: &str, out: &Path) -> Result<(), String> {
    if target_os != "linux" || !cfg!(target_os = "linux") {
        return Err("target cli-linux-x86_64 must be built on a linux host".to_string());
    }
    run_cmd(&["cargo", "build", "--release", "-p", "dezoomify-cli"])?;
    let bin = crate::repo_root().join("target/release/dezoomify-cli");
    if !bin.is_file() {
        return Err(format!(
            "cargo build produced no binary at {}",
            bin.display()
        ));
    }
    tar_gz(&bin, "dezoomify-cli", out)?;
    Ok(())
}

fn build_extension_artifact(browser: &str, out: &Path) -> Result<(), String> {
    crate::extension::build_extension(&[])?;
    let source = crate::repo_root()
        .join("target/extension")
        .join(format!("dezoomify-{browser}.zip"));
    std::fs::copy(&source, out).map_err(|e| {
        format!(
            "copy WXT extension package {} to {}: {e}",
            source.display(),
            out.display()
        )
    })?;
    Ok(())
}

/// Desktop release artifact: runs the canonical `cargo xtask build desktop`
/// pipeline (lean shell, frontend, window shell, icons, host bundler), then
/// copies the single release installer to `out`. Only the artifact named by
/// `expected_artifact_name` ships; anything else the bundler leaves on disk
/// is never listed in SHA256SUMS and never signed.
fn build_desktop_artifact(target: &str, target_os: &str, out: &Path) -> Result<(), String> {
    let host_ok = match target_os {
        "linux" => cfg!(target_os = "linux"),
        "windows" => cfg!(target_os = "windows"),
        "macos" => cfg!(target_os = "macos"),
        _ => false,
    };
    if !host_ok {
        return Err(format!(
            "target {target} must be built on a {target_os} host (release builds never cross-compile installers)"
        ));
    }
    crate::desktop::build_desktop(&[])?;
    let (subdir, extension, arch_token): (&str, &str, Option<&str>) = match target {
        "desktop-linux-x86_64" => ("deb", "deb", None),
        // The Windows recipe also produces the nsis setup binary alongside
        // the msi; only the msi is the release artifact.
        "desktop-windows-x86_64" => ("msi", "msi", None),
        "desktop-macos-aarch64" => ("dmg", "dmg", Some("aarch64")),
        "desktop-macos-x86_64" => ("dmg", "dmg", Some("x64")),
        _ => return Err(format!("target '{target}' has no build recipe")),
    };
    let dir = crate::repo_root()
        .join("target/release/bundle")
        .join(subdir);
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("desktop bundler produced no {}: {e}", dir.display()))?;
    let mut hits: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(&format!(".{extension}")) {
            continue;
        }
        if let Some(token) = arch_token {
            if !name.contains(token) {
                continue;
            }
            if token == "x64" && name.contains("aarch64") {
                continue;
            }
        }
        hits.push(path);
    }
    if hits.len() != 1 {
        return Err(format!(
            "desktop bundler left {} .{extension} files in {}; expected exactly one release installer",
            hits.len(),
            dir.display()
        ));
    }
    std::fs::copy(&hits[0], out).map_err(|e| format!("copy {}: {e}", hits[0].display()))?;
    Ok(())
}

/// Deterministic tar.gz containing one file renamed to `inner_name`.
fn tar_gz(file: &Path, inner_name: &str, out: &Path) -> Result<(), String> {
    let staging = out
        .parent()
        .ok_or("bad artifact path")?
        .join(".staging-tar");
    std::fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;
    let staged = staging.join(inner_name);
    std::fs::copy(file, &staged).map_err(|e| format!("stage {}: {e}", file.display()))?;
    let status = Command::new("tar")
        .arg("-czf")
        .arg(out)
        .arg("-C")
        .arg(&staging)
        .arg(inner_name)
        .status()
        .map_err(|e| format!("failed to run tar: {e}"));
    let _ = std::fs::remove_dir_all(&staging);
    let status = status?;
    if !status.success() || !out.is_file() {
        return Err(format!("tar failed writing {}", out.display()));
    }
    Ok(())
}

fn run_cmd(cmd: &[&str]) -> Result<(), String> {
    let status = Command::new(cmd[0])
        .args(&cmd[1..])
        .current_dir(crate::repo_root())
        .status()
        .map_err(|e| format!("failed to run {}: {e}", cmd[0]))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{} failed", cmd[0]))
}

#[cfg(test)]
mod tests {
    use super::super::common::{append_sums, parse_sums, temp_root};

    #[test]
    fn sums_parsing_and_append_guard() {
        let dir = temp_root("sums");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, b"aaa").unwrap();
        let sums = dir.join("SHA256SUMS");
        append_sums(&sums, "a.bin", &a).unwrap();
        append_sums(&sums, "a.bin", &a).unwrap_err();
        assert_eq!(parse_sums(&sums).unwrap(), vec!["a.bin".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
