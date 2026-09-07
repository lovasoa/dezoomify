//! Supply-chain gate: Rust (`cargo deny`) and JS (`pnpm`/`npm audit`)
//! dependency audits.
//!
//! Rust uses `cargo deny`, not `cargo audit`, as the single blocking tool:
//! one pinned binary covers advisories, licenses, bans, and sources from
//! `deny.toml`, while `cargo audit` would only duplicate the advisories leg
//! with a second database to maintain. The advisory-database fetch is the
//! only public-network contact outside `test live`, limited to the RustSec
//! database; everything else resolves from `Cargo.lock` and the JS lockfiles.
//!
//! JS audits the pnpm workspace plus the two isolated npm E2E profiles (the
//! documented exception in `docs/security.md`); installs never bypass
//! auditing because the blocking audit lives here, not in install flags.

use std::process::Command;

/// Pinned `cargo-deny` release. The `security`, `ci`, and `release-build`
/// workflows install exactly this version; the missing-binary error below
/// repeats it, and the `deny_pin_matches_workflows` test enforces the sync.
pub const CARGO_DENY_VERSION: &str = "0.20.2";

/// Isolated npm E2E profiles with their own lockfiles (documented exception
/// in `docs/security.md`; deliberately not part of the pnpm workspace).
const NPM_AUDIT_DIRS: &[&str] = &[
    "crates/fixture-server/tests/webapp-e2e",
    "apps/extension/tests/browser",
];

/// Full gate for the `security` lane: Rust deny plus JS audits.
pub fn run() -> Result<(), String> {
    check_deny()?;
    audit_js()?;
    println!("supply chain: ok (cargo deny + JS audits)");
    Ok(())
}

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
        .args(["deny", "check", "advisories", "licenses", "bans", "sources"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo deny: {e}"))?;
    if !status.success() {
        return Err(
            "supply-chain gate failed (`cargo deny check advisories licenses bans sources`; see deny.toml)"
                .to_string(),
        );
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

fn audit_js() -> Result<(), String> {
    // Workspace audit over pnpm-lock.yaml.
    let status = Command::new("pnpm")
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
    // Isolated E2E profiles, one lockfile each. `npm audit` reads the
    // lockfile, so no prior install is required.
    for dir in NPM_AUDIT_DIRS {
        let status = Command::new("npm")
            .args(["audit", "--audit-level=high"])
            .current_dir(super::repo_root().join(dir))
            .status()
            .map_err(|e| format!("failed to run npm audit in {dir}: {e}"))?;
        if !status.success() {
            return Err(format!(
                "supply-chain gate failed (`npm audit --audit-level=high` in {dir})"
            ));
        }
    }
    println!("supply chain (JS audits): ok");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn deny_config_covers_all_checks() {
        let text = std::fs::read_to_string(super::super::repo_root().join("deny.toml"))
            .expect("deny.toml");
        for section in ["[advisories]", "[licenses]", "[bans]", "[sources]"] {
            assert!(text.contains(section), "deny.toml lacks {section}");
        }
    }

    #[test]
    fn audit_profiles_exist_with_lockfiles() {
        for dir in super::NPM_AUDIT_DIRS {
            let root = super::super::repo_root().join(dir);
            assert!(
                root.join("package.json").is_file(),
                "{dir} lacks package.json"
            );
            assert!(
                root.join("package-lock.json").is_file(),
                "{dir} lacks package-lock.json"
            );
        }
    }

    #[test]
    fn workspace_excludes_isolated_profiles() {
        // Single pnpm workspace plus the documented isolated npm exception
        // (docs/security.md): the workspace member globs must not absorb the
        // isolated E2E profiles, or `pnpm -r` would widen to browser binaries.
        // Only the `packages:` member lines count; comments may name the
        // isolated profiles to document the exception.
        let text = std::fs::read_to_string(super::super::repo_root().join("pnpm-workspace.yaml"))
            .expect("pnpm-workspace.yaml");
        let members: Vec<String> = text
            .lines()
            .filter_map(|l| l.trim().strip_prefix("- ").map(str::to_string))
            .collect();
        assert!(!members.is_empty(), "pnpm-workspace.yaml lists no members");
        for dir in super::NPM_AUDIT_DIRS {
            assert!(
                !members.iter().any(|m| m.contains(dir)),
                "pnpm-workspace.yaml must not list isolated profile {dir}"
            );
        }
        for member in ["packages/*", "apps/*"] {
            assert!(
                text.contains(member),
                "pnpm-workspace.yaml lacks workspace member {member}"
            );
        }
    }

    #[test]
    fn ci_hashes_single_js_lockfile_set() {
        // The Playwright cache key must hash the single JS lockfile set:
        // the pnpm workspace lock plus both isolated npm profile locks.
        // Hashing only a subset would reuse stale browsers after a JS change.
        let text =
            std::fs::read_to_string(super::super::repo_root().join(".github/workflows/ci.yml"))
                .expect("ci.yml");
        for lock in [
            "pnpm-lock.yaml",
            "crates/fixture-server/tests/webapp-e2e/package-lock.json",
            "apps/extension/tests/browser/package-lock.json",
        ] {
            assert!(
                text.contains(lock),
                "ci.yml Playwright cache key lacks {lock}"
            );
        }
    }

    #[test]
    fn deny_pin_matches_workflows() {
        // The workflows must install the same cargo-deny release xtask
        // gates on; a drift would let CI pass what local runs deny.
        for workflow in [
            ".github/workflows/security.yml",
            ".github/workflows/ci.yml",
            ".github/workflows/release-build.yml",
        ] {
            let text = std::fs::read_to_string(super::super::repo_root().join(workflow))
                .unwrap_or_else(|_| panic!("read {workflow}"));
            assert!(
                text.contains(super::CARGO_DENY_VERSION),
                "{workflow} does not pin cargo-deny {}",
                super::CARGO_DENY_VERSION
            );
        }
    }
}
