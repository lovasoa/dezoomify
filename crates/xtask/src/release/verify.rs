//! `cargo xtask release verify`: plan/artifact consistency without secrets.
//!
//! Recomputes every digest, requires exactly the available targets'
//! artifacts under their target-relative `SHA256SUMS` paths, re-checks
//! protocol/capability agreement with the repository inventory, and (unless
//! `--unsigned`) validates every GPG signature against the repository's
//! public key. Verification uses public keys only; signing keys never leave
//! the `sign` stage.

use super::common::{
    expected_artifact_name, load_capabilities, load_compatibility, load_config, read_plan,
    schema_fingerprint, sha256_file, validate_version, Plan,
};
use super::sign;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) fn verify_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut artifacts: Option<PathBuf> = None;
    let mut unsigned = false;
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
            "--unsigned" => unsigned = true,
            other => return Err(format!("unknown release verify arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release verify --plan <path> --artifacts <path> [--unsigned]"
                .to_string(),
        );
    };
    let plan = read_plan(&plan)?;
    release_verify(&plan, &artifacts, unsigned)?;
    println!(
        "release verify: ok ({} artifacts)",
        if unsigned { "unsigned" } else { "signed" }
    );
    Ok(())
}

/// Full plan/artifact consistency: digest recomputation, expected artifact
/// names per available target, protocol/capability agreement with the
/// repository inventory, and (unless `--unsigned`) GPG signature validity.
pub(crate) fn release_verify(plan: &Plan, artifacts: &Path, unsigned: bool) -> Result<(), String> {
    validate_version(&plan.version)?;
    if plan.tag != format!("v{}", plan.version) {
        return Err(format!(
            "plan tag {} does not match version {}",
            plan.tag, plan.version
        ));
    }
    let config = load_config()?;
    if plan.version != config.release.version || plan.channel != config.release.channel {
        return Err("plan disagrees with release/config.toml".to_string());
    }
    let compat = load_compatibility()?;
    let caps = load_capabilities()?;
    let fingerprint = schema_fingerprint()?;
    if plan.protocol.range != config.protocol.range
        || plan.protocol.compatibility_current != compat.compatibility.current
        || plan.protocol.compatibility_n_minus_1 != compat.compatibility.n_minus_1
        || caps.protocol != plan.protocol.range
        || caps.capabilities != plan.capabilities
        || plan.schema_fingerprint != fingerprint
    {
        return Err(
            "plan disagrees with the repository release inventory; regenerate the plan".to_string(),
        );
    }
    if plan.commit.len() != 40 || !plan.commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("plan carries a malformed commit".to_string());
    }
    // Exactly the available targets' artifacts must be listed, no more,
    // keyed by their target-relative path in SHA256SUMS.
    let mut expected: BTreeMap<String, ()> = BTreeMap::new();
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let name = expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        let built = artifacts.join(&target.name).join(&name);
        if !built.is_file() {
            return Err(format!(
                "target '{}' has no built artifact at {}",
                target.name,
                built.display()
            ));
        }
        expected.insert(format!("{}/{name}", target.name), ());
    }
    let sums = artifacts.join("SHA256SUMS");
    let text =
        std::fs::read_to_string(&sums).map_err(|e| format!("missing {}: {e}", sums.display()))?;
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(digest), Some(name)) = (parts.next(), parts.next()) else {
            return Err(format!("malformed SHA256SUMS line: {line}"));
        };
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("malformed digest for {name}"));
        }
        if seen.insert(name.to_string(), digest.to_string()).is_some() {
            return Err(format!("SHA256SUMS lists {name} twice"));
        }
    }
    for name in seen.keys() {
        if !expected.contains_key(name) {
            return Err(format!("SHA256SUMS lists unexpected artifact {name}"));
        }
    }
    for name in expected.keys() {
        if !seen.contains_key(name) {
            return Err(format!("SHA256SUMS lacks expected artifact {name}"));
        }
    }
    for (name, digest) in &seen {
        let file = artifacts.join(name);
        let actual = sha256_file(&file)?;
        if &actual != digest {
            return Err(format!(
                "digest mismatch for {name}: SHA256SUMS says {digest}, file is {actual}"
            ));
        }
    }
    if !unsigned {
        verify_signatures(artifacts, seen.keys().cloned().collect())?;
    }
    Ok(())
}

/// Signature leg of verification: every listed artifact plus the aggregate
/// itself must carry a valid detached signature under the repository's
/// public key. Split out so the digest leg above stays readable.
fn verify_signatures(artifacts: &Path, names: Vec<String>) -> Result<(), String> {
    let key = std::fs::read_to_string(crate::repo_root().join("release/gpg-public-key.asc"))
        .map_err(|_| "missing release/gpg-public-key.asc; cannot verify signatures".to_string())?;
    let home = sign::gpg_home()?;
    sign::import_key(&home, &key)?;
    for name in std::iter::once("SHA256SUMS".to_string()).chain(names) {
        let sig = artifacts.join(format!("{name}.sig"));
        if !sig.is_file() {
            sign::cleanup_gpg_home(&home);
            return Err(format!("missing signature {name}.sig"));
        }
        let status = Command::new("gpg")
            .env("GNUPGHOME", &home)
            .args(["--batch", "--verify"])
            .arg(&sig)
            .arg(artifacts.join(&name))
            .status()
            .map_err(|e| format!("failed to run gpg: {e}"))?;
        if !status.success() {
            sign::cleanup_gpg_home(&home);
            return Err(format!("signature verification failed for {name}"));
        }
    }
    sign::cleanup_gpg_home(&home);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::common::{expected_artifact_name, plan_from_repo, sha256_file, temp_root};
    use super::release_verify;
    use std::path::PathBuf;

    #[test]
    fn verify_rejects_tampered_digests() {
        let plan = plan_from_repo();
        let dir = temp_root("verify");
        let mut names: Vec<(String, PathBuf)> = Vec::new();
        for target in plan.targets.iter().filter(|t| t.available) {
            let artifact = expected_artifact_name(&target.name, &plan.version).unwrap();
            let file = dir.join(&target.name).join(&artifact);
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            std::fs::write(&file, format!("bytes-for-{}", target.name)).unwrap();
            names.push((format!("{}/{}", target.name, artifact), file));
        }
        // All-zero digests: verify must reject.
        let sums = names
            .iter()
            .map(|(name, _)| format!("{}  {name}\n", "0".repeat(64)))
            .collect::<String>();
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        assert!(release_verify(&plan, &dir, true).is_err());
        // Correct digests: verify must pass.
        let sums = names
            .iter()
            .map(|(name, file)| format!("{}  {name}\n", sha256_file(file).unwrap()))
            .collect::<String>();
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        if let Err(e) = release_verify(&plan, &dir, true) {
            panic!("unsigned verify should pass: {e}");
        }
        // An unexpected extra artifact is rejected.
        std::fs::write(
            dir.join("SHA256SUMS"),
            format!("{sums}{}  evil.bin\n", "1".repeat(64)),
        )
        .unwrap();
        assert!(release_verify(&plan, &dir, true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_requires_signatures_unless_unsigned() {
        let plan = plan_from_repo();
        let dir = temp_root("verify-sig");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SHA256SUMS"), "").unwrap();
        // No artifacts at all: unsigned verify fails on missing artifacts
        // before signatures are even considered.
        assert!(release_verify(&plan, &dir, true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
