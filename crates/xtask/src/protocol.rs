//! `cargo xtask protocol generate|check`: deterministic Rust-derived
//! TypeScript/schema/capability artifacts. Generation writes tracked output
//! only on explicit `generate`; `check` and `generate --check` compare bytes
//! in a temp tree without updating tracked files.

use std::process::Command;

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("generate") => generate(&args[1..]),
        Some("check") => check(&args[1..]),
        Some(other) => Err(format!(
            "unknown protocol subcommand '{other}' (only 'generate|check')"
        )),
        None => Err("usage: cargo xtask protocol <generate|check> [--check]".to_string()),
    }
}

fn generate(args: &[String]) -> Result<(), String> {
    if args.len() > 1 {
        return Err("usage: cargo xtask protocol generate [--check]".to_string());
    }
    if args.first().map(String::as_str) == Some("--check") {
        return generate_check();
    }
    if !args.is_empty() {
        return Err(format!("unknown protocol generate arg '{}'", args[0]));
    }
    let status = Command::new("cargo")
        .args([
            "run",
            "-q",
            "-p",
            "dezoomify-protocol",
            "--bin",
            "generate-protocol",
            "--",
            "--out",
            "packages/protocol-ts",
        ])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run generator: {e}"))?;
    if !status.success() {
        return Err("protocol generate failed".to_string());
    }
    println!("protocol generate: ok");
    Ok(())
}

fn generate_check() -> Result<(), String> {
    let status = Command::new("cargo")
        .args([
            "run",
            "-q",
            "-p",
            "dezoomify-protocol",
            "--bin",
            "generate-protocol",
            "--",
            "--out",
            "packages/protocol-ts",
            "--check",
        ])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run generator check: {e}"))?;
    if !status.success() {
        return Err("protocol generate --check found drift".to_string());
    }
    Ok(())
}

fn check(_args: &[String]) -> Result<(), String> {
    // Markers/fingerprints, golden vectors (Rust), TS goldens, portability.
    generate_check()?;
    run_cargo(&["test", "-p", "dezoomify-protocol", "--test", "golden"])?;
    run_node_test()?;
    run_cargo(&[
        "check",
        "-p",
        "dezoomify-protocol",
        "--target",
        "wasm32-unknown-unknown",
        "--no-default-features",
    ])?;
    println!("protocol check: ok");
    Ok(())
}

pub fn test_protocol() -> Result<(), String> {
    run_cargo(&["test", "-p", "dezoomify-protocol"])?;
    run_node_test()?;
    check(&[])?;
    println!("test protocol: ok");
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

fn run_node_test() -> Result<(), String> {
    let status = Command::new("node")
        .args(["--test", "packages/protocol-ts/test/*.test.mjs"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node test: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "protocol-ts tests failed".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn protocol_check() {
        assert!(super::check(&[]).is_ok());
    }

    #[test]
    fn protocol_generate_check() {
        assert!(super::generate(&["--check".to_string()]).is_ok());
    }
}
