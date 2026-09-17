//! Generated WASM ABI declaration checks.
//!
//! Rust DTOs are authoritative. `wasm-bindgen` and `tsify` produce the only
//! TypeScript declaration consumed by browser products.

use std::path::{Path, PathBuf};
use std::process::Command;

const TRACKED_DECLARATION: &str = "packages/wasm-bindings/src/generated.d.ts";

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
    let check = args.first().map(String::as_str) == Some("--check");
    if !args.is_empty() && !check {
        return Err(format!("unknown protocol generate arg '{}'", args[0]));
    }
    let generated = emit_declaration()?;
    let tracked = super::repo_root().join(TRACKED_DECLARATION);
    if check {
        compare(&generated, &tracked)
    } else {
        std::fs::copy(&generated, &tracked).map_err(|e| {
            format!(
                "copy generated binding {} to {}: {e}",
                generated.display(),
                tracked.display()
            )
        })?;
        println!("protocol generate: wrote {}", tracked.display());
        Ok(())
    }
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

fn compare(generated: &Path, tracked: &Path) -> Result<(), String> {
    let actual = std::fs::read(generated)
        .map_err(|e| format!("read generated declaration {}: {e}", generated.display()))?;
    let expected = std::fs::read(tracked)
        .map_err(|e| format!("read tracked declaration {}: {e}", tracked.display()))?;
    if actual == expected {
        println!("protocol binding: generated declaration is current");
        Ok(())
    } else {
        Err(format!(
            "generated WASM declaration drifted: run `cargo xtask protocol generate` ({})",
            tracked.display()
        ))
    }
}

fn check(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("protocol check", args)?;
    generate(&["--check".to_string()])?;
    super::command::cargo_test(&["-p", "dezoomify-protocol"])?;
    typecheck_binding()?;
    wasm_portability_check()?;
    println!("protocol check: ok");
    Ok(())
}

pub fn test_protocol() -> Result<(), String> {
    generate(&["--check".to_string()])?;
    super::command::cargo_test(&["-p", "dezoomify-protocol"])?;
    typecheck_binding()?;
    wasm_portability_check()
}

fn wasm_portability_check() -> Result<(), String> {
    super::command::cargo(&[
        "check",
        "--quiet",
        "-p",
        "dezoomify-protocol",
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
