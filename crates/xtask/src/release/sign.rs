//! `cargo xtask release sign`: assemble the aggregate digest manifest and
//! GPG-sign every published file.
//!
//! The aggregate `SHA256SUMS` is assembled deterministically in plan order
//! from the per-target fragments the `build` stage left behind; every
//! available target must have exactly its fragment or signing fails closed.
//! Signatures are detached (`.sig`) over the aggregate and every listed
//! artifact. The private key comes only from the `RELEASE_GPG_KEY`
//! environment secret; without it signing fails closed, never silently.

use super::common::{load_config, parse_sums, plan_dir, read_plan, Plan};
use crate::reject_unknown_args;
use std::path::{Path, PathBuf};
use std::process::Command;

const GPG_KEY_ENV: &str = "RELEASE_GPG_KEY";
const GPG_PASSPHRASE_ENV: &str = "RELEASE_GPG_PASSPHRASE";

pub(crate) fn sign_cmd(args: &[String]) -> Result<(), String> {
    reject_unknown_args("release sign", args)?;
    let config = load_config()?;
    let plan_path = plan_dir(&config.release.version).join("plan.json");
    let artifacts = plan_dir(&config.release.version);
    release_sign(&read_plan(&plan_path)?, &artifacts)?;
    println!("release sign: {}", artifacts.join("SHA256SUMS").display());
    Ok(())
}

/// Signs the aggregate SHA256SUMS and every artifact listed in it, writing
/// `<file>.sig` next to each. Fails closed without a key.
fn release_sign(plan: &Plan, artifacts: &Path) -> Result<(), String> {
    aggregate_sums(plan, artifacts)?;
    let key = std::env::var(GPG_KEY_ENV)
        .ok()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "release signing requires the {GPG_KEY_ENV} environment secret (armored GPG private key); refusing to publish unsigned artifacts"
            )
        })?;
    let sums = artifacts.join("SHA256SUMS");
    let names = parse_sums(&sums)?;
    if names.is_empty() {
        return Err("SHA256SUMS lists no artifacts; nothing to sign".to_string());
    }
    let home = gpg_home()?;
    import_key(&home, &key)?;
    for name in std::iter::once("SHA256SUMS".to_string()).chain(names) {
        let file = artifacts.join(&name);
        if !file.is_file() {
            return Err(format!("missing artifact {}", file.display()));
        }
        let sig = artifacts.join(format!("{name}.sig"));
        let mut cmd = Command::new("gpg");
        cmd.env("GNUPGHOME", &home)
            .args(["--batch", "--yes", "--detach-sign", "--output"])
            .arg(&sig)
            .arg(&file);
        if let Ok(pass) = std::env::var(GPG_PASSPHRASE_ENV) {
            cmd.args(["--pinentry-mode", "loopback", "--passphrase", &pass]);
        }
        let status = cmd
            .status()
            .map_err(|e| format!("failed to run gpg: {e}"))?;
        if !status.success() || !sig.is_file() {
            return Err(format!("gpg detached-sign failed for {name}"));
        }
    }
    cleanup_gpg_home(&home);
    Ok(())
}

/// Assembles the top-level SHA256SUMS from the per-target fragments, in plan
/// order (deterministic). Every available target must have exactly its
/// fragment; anything else fails closed.
fn aggregate_sums(plan: &Plan, artifacts: &Path) -> Result<String, String> {
    let mut aggregate = String::new();
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let fragment = artifacts.join(&target.name).join("SHA256SUMS");
        let text = std::fs::read_to_string(&fragment)
            .map_err(|e| format!("missing digest fragment {}: {e}", fragment.display()))?;
        for line in text.lines() {
            let name = line.split_whitespace().nth(1).ok_or_else(|| {
                format!("malformed digest line in {}: {line}", fragment.display())
            })?;
            if !name.starts_with(&format!("{}/", target.name)) {
                return Err(format!(
                    "fragment for {} lists foreign artifact {name}",
                    target.name
                ));
            }
            aggregate.push_str(line);
            aggregate.push('\n');
        }
    }
    if aggregate.is_empty() {
        return Err("no digest fragments found; nothing to sign".to_string());
    }
    std::fs::write(artifacts.join("SHA256SUMS"), &aggregate)
        .map_err(|e| format!("write aggregate SHA256SUMS: {e}"))?;
    Ok(aggregate)
}

pub(crate) fn gpg_home() -> Result<PathBuf, String> {
    if Command::new("gpg").arg("--version").output().is_err() {
        return Err("gpg is not installed; cannot sign release artifacts".to_string());
    }
    let dir = std::env::temp_dir().join(format!("dezoomify-release-gnupg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create gpg home: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn import_key(home: &Path, armored: &str) -> Result<(), String> {
    let keyfile = home.join("signing-key.asc");
    std::fs::write(&keyfile, armored).map_err(|e| format!("write key: {e}"))?;
    let status = Command::new("gpg")
        .env("GNUPGHOME", home)
        .args(["--batch", "--import"])
        .arg(&keyfile)
        .status()
        .map_err(|e| format!("failed to run gpg: {e}"))?;
    if !status.success() {
        return Err("gpg --import rejected the signing key".to_string());
    }
    Ok(())
}

pub(crate) fn cleanup_gpg_home(home: &Path) {
    let _ = std::fs::remove_dir_all(home);
}

#[cfg(test)]
mod tests {
    use super::super::common::{expected_artifact_name, plan_from_repo, temp_root};
    use super::{aggregate_sums, release_sign, GPG_KEY_ENV};

    #[test]
    fn sign_fails_closed_without_key() {
        let plan = plan_from_repo();
        let dir = temp_root("sign");
        for target in plan.targets.iter().filter(|t| t.available) {
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            let artifact = expected_artifact_name(&target.name, &plan.version).unwrap();
            std::fs::write(
                dir.join(&target.name).join(&artifact),
                format!("bytes-for-{}", target.name),
            )
            .unwrap();
            std::fs::write(
                dir.join(&target.name).join("SHA256SUMS"),
                format!("{}  {}/{}\n", "0".repeat(64), target.name, artifact),
            )
            .unwrap();
        }
        std::env::remove_var(GPG_KEY_ENV);
        assert!(release_sign(&plan, &dir).is_err());
        // A garbage key must also fail closed, never silently skip signing.
        std::env::set_var(GPG_KEY_ENV, "not-a-key");
        assert!(release_sign(&plan, &dir).is_err());
        std::env::remove_var(GPG_KEY_ENV);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_is_deterministic_and_rejects_foreign_entries() {
        let plan = plan_from_repo();
        let dir = temp_root("aggregate");
        for target in plan.targets.iter().filter(|t| t.available) {
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            std::fs::write(
                dir.join(&target.name).join("SHA256SUMS"),
                format!(
                    "{}  {}/{}\n",
                    "0".repeat(64),
                    target.name,
                    expected_artifact_name(&target.name, &plan.version).unwrap()
                ),
            )
            .unwrap();
        }
        let first = aggregate_sums(&plan, &dir).unwrap();
        let second = aggregate_sums(&plan, &dir).unwrap();
        assert_eq!(first, second);
        // A fragment listing another target's artifact fails closed.
        let cli = plan
            .targets
            .iter()
            .find(|t| t.available && t.name == "cli-linux-x86_64")
            .unwrap();
        std::fs::write(
            dir.join(&cli.name).join("SHA256SUMS"),
            format!("{}  extension-chromium/evil.zip\n", "0".repeat(64)),
        )
        .unwrap();
        assert!(aggregate_sums(&plan, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
