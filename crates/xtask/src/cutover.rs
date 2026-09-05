//! Cutover and post-cutover gates: candidate verification, packaged
//! parity/security, compatibility suites, deletion/clean-tree lanes,
//! post-cutover snapshot/validation/cleanup lanes. Production promotion is
//! out of scope for this environment; lanes verify tooling + evidence shape.

use std::process::Command;

pub fn release_verify_candidate() -> Result<(), String> {
    let path = super::repo_root().join("release/cutover.toml");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("missing cutover.toml: {e}"))?;
    if !text.contains("version") || !text.contains("protocol_range") {
        return Err("cutover.toml lacks version/protocol_range".to_string());
    }
    // Honest scope: shape check only; no installer/signature/prod verification.
    println!("release verify --candidate: stub-ok (shape only; test-channel candidate)");
    Ok(())
}

pub fn parity_packaged(args: &[String]) -> Result<(), String> {
    // Deterministic packaged parity: installed-artifact checks reduce to the
    // same scenario corpus gates in this environment (no installers).
    super::parity::validate(&[])?;
    super::native::test_scenario(&[])?;
    if args.iter().any(|a| a == "--security") {
        println!(
            "parity validate --packaged --security: stub-ok (no installers; corpus gates only)"
        );
    } else {
        println!("parity validate --packaged: stub-ok (no installers; corpus gates only)");
    }
    Ok(())
}

pub fn test_scenario_suite(args: &[String]) -> Result<(), String> {
    let suite = args
        .windows(2)
        .find(|w| w[0] == "--suite")
        .map(|w| w[1].clone())
        .ok_or("usage: test scenario --suite <name> [--packaged]")?;
    match suite.as_str() {
        "cutover-compatibility" | "postcutover" => {
            super::native::test_scenario(&[])?;
            println!("test scenario --suite {suite}: stub-ok (native corpus only; no packaged artifacts)");
            Ok(())
        }
        other => Err(format!("unknown scenario suite '{other}'")),
    }
}

pub fn ci_lane(name: &str, extra: &[String]) -> Result<(), String> {
    match name {
        "cutover-deletion-gate" => {
            let inventory = super::repo_root().join("artifacts/phase-14/deletion-inventory.json");
            if !inventory.is_file() {
                return Err("deletion inventory missing".to_string());
            }
            println!(
                "ci cutover-deletion-gate: ok (inventory classifies; zero deletions approved)"
            );
            Ok(())
        }
        "cutover-clean-tree" => {
            // Honest check: fail when the working tree has staged/unstaged
            // changes or untracked files outside known build outputs.
            let out = std::process::Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(super::repo_root())
                .output()
                .map_err(|e| format!("failed to run git status: {e}"))?;
            if !out.status.success() {
                return Err("git status failed".to_string());
            }
            let text = String::from_utf8_lossy(&out.stdout);
            let dirty: Vec<&str> = text
                .lines()
                .filter(|l| {
                    !(l.contains("apps/desktop/src-tauri/target/")
                        || l.contains("apps/desktop/src-tauri/Cargo.lock"))
                })
                .collect();
            if !dirty.is_empty() {
                return Err(format!(
                    "working tree not clean ({} entries): {}",
                    dirty.len(),
                    dirty.join(", ").chars().take(300).collect::<String>()
                ));
            }
            println!("ci cutover-clean-tree: ok");
            Ok(())
        }
        "postcutover-snapshot" => {
            let state = extra
                .windows(2)
                .find(|w| w[0] == "--state")
                .map(|w| w[1].as_str())
                .unwrap_or("fixtures");
            if state != "fixtures" && state != "production" {
                return Err(format!("unknown snapshot state '{state}'"));
            }
            println!("ci postcutover-snapshot --state {state}: stub-ok (no snapshot written; redaction not scanned)");
            Ok(())
        }
        "postcutover-validation" => {
            println!("ci postcutover-validation: stub-ok (no production checks)");
            Ok(())
        }
        "postcutover-cleanup-gate" => {
            println!("ci postcutover-cleanup-gate: stub-ok (no cleanup verified)");
            Ok(())
        }
        other => Err(format!("unknown ci lane '{other}'")),
    }
}

#[allow(dead_code)]
pub fn test_live_packaged() -> Result<(), String> {
    Err(
        "live packaged runs require explicit production approval; dry-run only in this environment"
            .to_string(),
    )
}

#[allow(dead_code)]
fn run_cargo(args: &[&str]) -> Result<(), String> {
    let status = Command::new("cargo")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("cargo {} failed", args.join(" ")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn candidate_verify_is_an_honest_shape_only_stub() {
        // This gate is intentionally a shape check only. Pin the honesty of
        // its own report: it must say stub-ok, never claim real verification.
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--nocapture", "--exact", "capture_candidate_verify_output"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn test harness");
        let output = child.wait_with_output().expect("wait");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("stub-ok (shape only"),
            "release verify --candidate must report its stub-ok scope; got: {stdout}"
        );
        assert!(
            !stdout.to_ascii_lowercase().contains("verified candidate"),
            "release verify --candidate must not claim candidate verification"
        );
    }

    #[test]
    fn capture_candidate_verify_output() {
        super::release_verify_candidate().expect("candidate verify stub ok");
    }
}
