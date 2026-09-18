//! Shared subprocess entry points for repository tasks.

use std::{
    io::{self, Write},
    process::Command,
};

pub(crate) fn cargo(args: &[&str]) -> Result<(), String> {
    run("cargo", args)
}

pub(crate) fn cargo_test(selectors: &[&str]) -> Result<(), String> {
    let mut command = Command::new("cargo");
    command
        .args(["test", "--quiet"])
        .args(selectors)
        .args(["--", "--format", "terse"])
        .current_dir(super::repo_root());
    let output = command
        .output()
        .map_err(|e| format!("failed to run cargo tests: {e}"))?;
    if !output.status.success() {
        io::stdout()
            .write_all(&output.stdout)
            .map_err(|e| format!("failed to print cargo test output: {e}"))?;
        io::stderr()
            .write_all(&output.stderr)
            .map_err(|e| format!("failed to print cargo test errors: {e}"))?;
        return Err("cargo tests failed".to_string());
    }
    print!(".");
    io::stdout()
        .flush()
        .map_err(|e| format!("failed to print cargo test result: {e}"))
}

pub(crate) fn node_test(patterns: &[&str], tsx: bool) -> Result<(), String> {
    let mut args = Vec::new();
    if tsx {
        args.extend(["--import", "./test/tsx-loader.mjs"]);
    }
    args.extend(["--test"]);
    args.extend_from_slice(patterns);
    super::desktop::run_node_with_deadline(
        std::time::Duration::from_secs(10 * 60),
        &args,
        &[("NODE_NO_WARNINGS", "1")],
        &patterns.join(" "),
    )
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(super::repo_root());
    status(command, &format!("{program} {}", args.join(" ")))
}

fn status(mut command: Command, label: &str) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|e| format!("failed to run {label}: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{label} failed"))
}
