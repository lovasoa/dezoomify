//! Generated WASM ABI declaration checks.
//!
//! Rust DTOs are authoritative. `wasm-bindgen` and `tsify` produce the only
//! TypeScript declaration consumed by browser products.

use std::path::PathBuf;
use std::process::Command;

const TRACKED_DECLARATION: &str = "packages/wasm-bindings/src/generated.d.ts";

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("generate") => generate(&args[1..]),
        Some("check") => check(&args[1..]),
        Some(other) => Err(format!(
            "unknown bindings subcommand '{other}' (only 'generate|check')"
        )),
        None => Err("usage: cargo xtask bindings <generate|check>".to_string()),
    }
}

fn generate(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask bindings generate (no options)".to_string());
    }
    let generated = emit_declaration()?;
    let tracked = super::repo_root().join(TRACKED_DECLARATION);
    std::fs::copy(&generated, &tracked).map_err(|e| {
        format!(
            "copy generated binding {} to {}: {e}",
            generated.display(),
            tracked.display()
        )
    })?;
    println!("bindings generate: wrote {}", tracked.display());
    Ok(())
}

fn emit_declaration() -> Result<PathBuf, String> {
    super::command::cargo(&[
        "build",
        "--quiet",
        "--release",
        "-p",
        "dezoomify-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ])?;
    let target = super::cargo_target_directory()?;
    let input = target.join("wasm32-unknown-unknown/release/dezoomify_wasm.wasm");
    let output =
        std::env::temp_dir().join(format!("dezoomify-wasm-bindings-{}", std::process::id()));
    if output.exists() {
        std::fs::remove_dir_all(&output)
            .map_err(|e| format!("clear temporary binding directory: {e}"))?;
    }
    std::fs::create_dir_all(&output)
        .map_err(|e| format!("create temporary binding directory: {e}"))?;
    let status = Command::new("wasm-bindgen")
        .args([
            "--target",
            "web",
            "--typescript",
            "--out-name",
            "dezoomify-wasm",
        ])
        .arg("--out-dir")
        .arg(&output)
        .arg(&input)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("run wasm-bindgen (run `cargo xtask setup`): {e}"))?;
    if !status.success() {
        return Err("wasm-bindgen failed while generating the typed ABI".to_string());
    }
    Ok(output.join("dezoomify-wasm.d.ts"))
}

fn check(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("bindings check", args)?;
    super::command::cargo_test(&["-p", "dezoomify"])?;
    typecheck_binding()?;
    wasm_portability_check()?;
    println!("bindings check: ok");
    Ok(())
}

pub fn test_bindings() -> Result<(), String> {
    super::command::cargo_test(&["-p", "dezoomify"])?;
    typecheck_binding()?;
    wasm_portability_check()
}

pub(crate) fn wasm_portability_check() -> Result<(), String> {
    super::command::cargo(&[
        "check",
        "--quiet",
        "-p",
        "dezoomify",
        "--target",
        "wasm32-unknown-unknown",
        "--no-default-features",
    ])
}

fn typecheck_binding() -> Result<(), String> {
    let status = super::desktop::pnpm_command()?
        .args(["--filter", "@dezoomify/wasm-bindings", "typecheck"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("run generated binding typecheck: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("generated binding TypeScript compilation failed".to_string())
    }
}
