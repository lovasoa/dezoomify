//! `cargo xtask check`: formatting, lint, and read-only artifact validation.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    super::command::cargo(&["fmt", "--all", "--", "--check"])?;
    super::command::cargo(&[
        "clippy",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
    ])?;
    run_biome()?;
    run_typecheck()?;
    super::fixtures::verify(&[])?;
    super::style::verify(&[])?;
    super::content::verify(&[])?;
    super::protocol::run(&["generate".to_string(), "--check".to_string()])?;
    super::supply::check_workspace_lockfiles()?;
    super::supply::check_deny()?;
    println!("check: ok");
    Ok(())
}

fn run_biome() -> Result<(), String> {
    let status = super::desktop::pnpm_command()?
        .args(["check:biome"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to launch pnpm check:biome: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "Biome check failed (run `pnpm check:biome` for details)".to_string())
}

fn run_typecheck() -> Result<(), String> {
    let status = super::desktop::pnpm_command()?
        .args(["typecheck"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to launch pnpm for typecheck: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "pnpm typecheck failed (run `pnpm typecheck` for details)".to_string())
}
