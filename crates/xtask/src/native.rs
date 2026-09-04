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
    for rel in [
        "testdata/scenarios/native/basic/expected/result.json",
        "testdata/scenarios/native/cache-resume/expected/result.json",
        "testdata/scenarios/cli/help/expected/snapshot.txt",
    ] {
        let path = super::repo_root().join(rel);
        if std::fs::read(&path).is_err() {
            return Err(format!("missing scenario file {rel}"));
        }
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
