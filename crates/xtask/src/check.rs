//! `cargo xtask check`: formatting, lint, and read-only artifact validation.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    run_cargo(&["fmt", "--all", "--", "--check"])?;
    run_cargo(&[
        "clippy",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
    ])?;
    super::fixtures::verify(&[])?;
    super::style::verify(&[])?;
    println!("check: ok");
    Ok(())
}

fn run_cargo(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("cargo")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err(format!("cargo {} failed", args.join(" ")));
    }
    Ok(())
}
