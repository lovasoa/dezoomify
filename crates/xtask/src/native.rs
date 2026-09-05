//! `cargo xtask test native`, `test scenario`, `build cli`,
//! `parity validate --native`: native runtime + CLI gates.

use std::process::Command;

pub fn test_native(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test native", args)?;
    run_cargo(&["test", "-p", "dezoomify-native"])?;
    run_cargo(&["test", "-p", "dezoomify-cli"])?;
    println!("test native: ok");
    Ok(())
}

pub fn test_scenario(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test scenario", args)?;
    // Real-pipeline scenario gate: the native scenarios run the actual
    // pipeline over loopback sockets; their expected results must pin a
    // computed digest (never a stub marker) or an honest failure code.
    let dzi = super::repo_root().join("testdata/scenarios/native/cli-dzi/expected/result.json");
    let dzi_value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&dzi).map_err(|e| format!("missing native scenario: {e}"))?,
    )
    .map_err(|e| format!("bad native scenario JSON: {e}"))?;
    let hash = dzi_value
        .get("outputHash")
        .and_then(|v| v.as_str())
        .ok_or("cli-dzi scenario lacks outputHash")?;
    if !hash.starts_with("sha256:") || hash.len() != 7 + 64 {
        return Err(format!(
            "cli-dzi expected result must pin a real sha256 digest; got {hash}"
        ));
    }
    let failure =
        super::repo_root().join("testdata/scenarios/native/cli-tile-failure/expected/result.json");
    let failure_value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&failure)
            .map_err(|e| format!("missing native failure scenario: {e}"))?,
    )
    .map_err(|e| format!("bad failure scenario JSON: {e}"))?;
    if failure_value.get("code").and_then(|v| v.as_str()) != Some("tile.download-failed") {
        return Err("cli-tile-failure scenario must pin the honest failure code".to_string());
    }
    let snapshot = super::repo_root().join("testdata/scenarios/cli/help/expected/snapshot.txt");
    let snapshot_text =
        std::fs::read_to_string(&snapshot).map_err(|e| format!("missing CLI snapshot: {e}"))?;
    if !snapshot_text.starts_with("usage: dezoomify-cli") {
        return Err("CLI snapshot lacks usage line".to_string());
    }
    // Enforce the golden against the real binary (byte-for-byte comparison
    // lives in apps/cli/tests/snapshots.rs).
    run_cargo(&["test", "-p", "dezoomify-cli", "--test", "snapshots"])?;
    run_cargo(&["test", "-p", "dezoomify-native", "--test", "scenarios"])?;
    run_cargo(&[
        "test",
        "-p",
        "dezoomify-native",
        "--test",
        "pipeline_loopback",
    ])?;
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
