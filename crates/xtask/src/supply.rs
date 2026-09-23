//! Supply-chain gate: Rust (`cargo deny`) and JS (`pnpm`) dependency audits.
//!
//! Rust uses `cargo deny`, not `cargo audit`, as the single blocking tool:
//! one pinned binary covers advisories, licenses, bans, and sources from
//! `deny.toml`, while `cargo audit` would only duplicate the advisories leg
//! with a second database to maintain. The advisory-database fetch is the
//! only public-network contact outside `test live`, limited to the RustSec
//! database; everything else resolves from `Cargo.lock` and the JS lockfiles.
//!
//! JS audits the complete pnpm workspace. The workspace lockfile is the only
//! active JavaScript lockfile; installs never bypass auditing because the
//! blocking audit lives here, not in install flags.

use std::process::Command;

/// Pinned `cargo-deny` release. The `security` and `ci`
/// workflows install exactly this version; the missing-binary error below
/// repeats it, and the `deny_pin_matches_workflows` test enforces the sync.
pub const CARGO_DENY_VERSION: &str = "0.20.2";

/// Rust leg, also used by `cargo xtask check`. Fails closed: a missing
/// binary or a failed check is an error, never a silent skip.
pub fn check_deny() -> Result<(), String> {
    let version = Command::new("cargo")
        .args(["deny", "--version"])
        .current_dir(super::repo_root())
        .output()
        .map_err(|e| install_hint(&format!("cannot run `cargo deny`: {e}")))?;
    if !version.status.success() {
        return Err(install_hint("`cargo deny --version` failed"));
    }
    let status = Command::new("cargo")
        .args(["deny", "check", "--hide-inclusion-graph"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo deny: {e}"))?;
    if !status.success() {
        return Err("supply-chain gate failed (`cargo deny check`; see deny.toml)".to_string());
    }
    println!("supply chain (cargo deny): ok");
    Ok(())
}

fn install_hint(detail: &str) -> String {
    format!(
        "supply-chain gate needs cargo-deny {CARGO_DENY_VERSION} ({detail}). \
         Install with `cargo install cargo-deny --version {CARGO_DENY_VERSION} --locked` \
         (CI installs this pin via taiki-e/install-action) and rerun; the gate never skips"
    )
}

/// JavaScript half of the supply gate.
///
/// Required CI runs Rust policy through the ubiquitous `check` lane and this
/// JS half through the `security` lane. Keeping them separate avoids querying
/// the RustSec database twice.
pub fn audit_js() -> Result<(), String> {
    let status = super::desktop::pnpm_command()?
        .args(["audit", "--audit-level", "high"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| {
            format!(
                "failed to run pnpm audit: {e} (install pnpm 9.12.0 matching packageManager in package.json)"
            )
        })?;
    if !status.success() {
        return Err("supply-chain gate failed (`pnpm audit --audit-level high`)".to_string());
    }
    println!("supply chain (pnpm audit): ok");
    Ok(())
}

/// Reject a second package-manager lockfile in any pnpm workspace member.
/// The root pnpm lockfile is the sole exception and is intentionally allowed.
pub fn check_workspace_lockfiles() -> Result<(), String> {
    let root = super::repo_root();
    let workspace = std::fs::read_to_string(root.join("pnpm-workspace.yaml"))
        .map_err(|e| format!("cannot read pnpm-workspace.yaml: {e}"))?;
    let mut members = Vec::new();
    for line in workspace.lines() {
        let Some(raw) = line.trim().strip_prefix("- ") else {
            continue;
        };
        let pattern = raw.trim().trim_matches(['"', '\'']);
        if let Some(parent) = pattern.strip_suffix("/*") {
            let dir = root.join(parent);
            for entry in std::fs::read_dir(&dir)
                .map_err(|e| format!("cannot read workspace directory {}: {e}", dir.display()))?
            {
                let path = entry
                    .map_err(|e| format!("cannot read workspace entry {}: {e}", dir.display()))?
                    .path();
                if path.join("package.json").is_file() {
                    members.push(path);
                }
            }
        } else if let Some(parent) = pattern.strip_suffix("/**") {
            collect_package_dirs(&root.join(parent), &mut members)?;
        } else {
            let path = root.join(pattern);
            if path.join("package.json").is_file() {
                members.push(path);
            }
        }
    }

    for member in members {
        for lockfile in [
            "package-lock.json",
            "npm-shrinkwrap.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
            "bun.lockb",
        ] {
            let path = member.join(lockfile);
            if path.is_file() {
                return Err(format!(
                    "workspace member {} contains {lockfile}; use the root pnpm-lock.yaml",
                    member.strip_prefix(&root).unwrap_or(&member).display()
                ));
            }
        }
    }
    Ok(())
}

fn collect_package_dirs(
    dir: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read workspace directory {}: {e}", dir.display()))?
    {
        let path = entry
            .map_err(|e| format!("cannot read workspace entry {}: {e}", dir.display()))?
            .path();
        if path.join("package.json").is_file() {
            out.push(path.clone());
        }
        if path.is_dir() {
            collect_package_dirs(&path, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn workspace_lockfile_policy_is_clean() {
        super::check_workspace_lockfiles().expect("workspace has a second lockfile");
    }
}
