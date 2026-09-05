//! `cargo xtask test native`, `test scenario`, `build cli`,
//! `parity validate --native`: native runtime + CLI gates.

use std::process::Command;

pub fn test_native(_args: &[String]) -> Result<(), String> {
    run_cargo(&["test", "-p", "dezoomify-native"])?;
    run_cargo(&["test", "-p", "dezoomify-cli"])?;
    println!("test native: ok");
    Ok(())
}

pub fn test_scenario(_args: &[String]) -> Result<(), String> {
    // Honest scenario gate: JSON fixtures must parse and declare their scope.
    // Native `outputHash` values are explicit `STUB:uncomputed` markers (no
    // digest is computed yet); fail if anyone reintroduces a fake `sha256:*`.
    for rel in [
        "testdata/scenarios/native/basic/expected/result.json",
        "testdata/scenarios/native/cache-resume/expected/result.json",
    ] {
        let path = super::repo_root().join(rel);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("missing scenario file {rel}: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad JSON {rel}: {e}"))?;
        let hash = value
            .get("outputHash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{rel} lacks outputHash"))?;
        if hash.starts_with("sha256:") {
            return Err(format!(
                "{rel} claims a computed digest ({hash}) with no pipeline; use STUB:uncomputed"
            ));
        }
        if hash != "STUB:uncomputed" {
            return Err(format!("{rel} has unexpected outputHash {hash}"));
        }
    }
    let snapshot = super::repo_root().join("testdata/scenarios/cli/help/expected/snapshot.txt");
    let snapshot_text =
        std::fs::read_to_string(&snapshot).map_err(|e| format!("missing CLI snapshot: {e}"))?;
    if !snapshot_text.contains("usage: dezoomify-cli") {
        return Err("CLI snapshot lacks usage line".to_string());
    }
    run_cargo(&["test", "-p", "dezoomify-native", "--test", "scenarios"])?;
    println!("test scenario: ok");
    Ok(())
}

pub fn build_cli(_args: &[String]) -> Result<(), String> {
    run_cargo(&["build", "-p", "dezoomify-cli"])?;
    println!("build cli: ok");
    Ok(())
}

pub fn parity_native() -> Result<(), String> {
    // Deterministic old/new comparison stub: native scenarios + CLI snapshots.
    test_native(&[])?;
    test_scenario(&[])?;
    println!("parity validate --native: ok (native scenarios + CLI snapshots green)");
    Ok(())
}

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
    fn native_scenario_files() {
        assert!(super::test_scenario(&[]).is_ok());
    }
}
