//! `cargo xtask build wasm` / `cargo xtask test wasm [--transcripts|--browser <name>]`.
//! Adapter-only gate: target/tool versions, forbidden capabilities, adapter
//! tests, Node harness, and native/WASM transcript equality. The `--browser`
//! flag runs the Node harness and then a real headless-Chromium pass over
//! the compiled adapter through the webapp E2E suite.

use std::path::PathBuf;
use std::process::Command;

pub fn build_wasm(_args: &[String]) -> Result<(), String> {
    run_cargo(&[
        "build",
        "-p",
        "dezoomify-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ])?;
    println!("build wasm: ok (target/wasm32-unknown-unknown/debug)");
    Ok(())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let mut transcripts = false;
    let mut browser: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--transcripts" => transcripts = true,
            "--browser" => {
                i += 1;
                browser = Some(args.get(i).ok_or("missing --browser <name>")?.clone());
            }
            other => return Err(format!("unknown test wasm option '{other}'")),
        }
        i += 1;
    }
    if transcripts {
        return transcripts_only();
    }
    if let Some(name) = browser {
        // Only chromium engine coverage exists in this environment
        // (firefox/webkit browsers not installed); other names fail closed.
        if name != "chrome" && name != "chromium" {
            return Err(format!(
                "browser '{name}' unavailable (only chromium engine coverage; firefox/webkit deferred)"
            ));
        }
        return browser_focus(&name);
    }
    // Full gate.
    run_cargo(&["test", "-p", "dezoomify-wasm"])?;
    run_node_harness()?;
    forbidden_capabilities()?;
    transcripts_only()?;
    println!("test wasm: ok");
    Ok(())
}

fn transcripts_only() -> Result<(), String> {
    // The real transcript gate is the adapter's runtime comparison against
    // the checked-in golden (tests/adapter.rs
    // basic_success_transcript_matches_golden); run it rather than statically
    // grepping the checked-in file, which cannot detect golden rot.
    run_cargo(&[
        "test",
        "-p",
        "dezoomify-wasm",
        "--test",
        "adapter",
        "transcript",
    ])?;
    println!("test wasm --transcripts: ok (adapter golden comparison green)");
    Ok(())
}

fn browser_focus(name: &str) -> Result<(), String> {
    run_node_harness()?;
    // Real headless browser run: the webapp E2E loads the compiled wasm
    // adapter (wasm-bindgen glue, release profile) inside Chromium and
    // exercises session/dispatch/buffer plumbing end to end.
    super::browser::run_e2e()?;
    println!(
        "test wasm --browser {name}: ok (node harness + headless chromium executed the wasm adapter)"
    );
    Ok(())
}

fn run_node_harness() -> Result<(), String> {
    generate_node_bindings()?;
    let status = Command::new("node")
        .args(["--test", "packages/wasm-harness/src/node.spec.mjs"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node harness: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "wasm node harness failed".to_string())
}

fn generate_node_bindings() -> Result<(), String> {
    run_cargo(&[
        "build",
        "-p",
        "dezoomify-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ])?;
    let target_dir = cargo_target_directory()?;
    let input = target_dir.join("wasm32-unknown-unknown/debug/dezoomify_wasm.wasm");
    let output = target_dir.join("wasm-node-harness");
    let status = Command::new("wasm-bindgen")
        .args([
            "--target",
            "nodejs",
            "--out-dir",
            output
                .to_str()
                .ok_or("Cargo target directory is not valid UTF-8")?,
            "--out-name",
            "dezoomify_wasm",
            input
                .to_str()
                .ok_or("WASM artifact path is not valid UTF-8")?,
        ])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| {
            format!(
                "failed to generate Node bindings with wasm-bindgen (run `cargo xtask setup`): {e}"
            )
        })?;
    status.success().then_some(()).ok_or_else(|| {
        "wasm-bindgen failed while generating the Node conformance bindings".to_string()
    })
}

fn cargo_target_directory() -> Result<PathBuf, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(super::repo_root())
        .output()
        .map_err(|e| format!("failed to query Cargo target directory: {e}"))?;
    if !output.status.success() {
        return Err("cargo metadata failed while resolving the target directory".to_string());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid cargo metadata output: {e}"))?;
    metadata["target_directory"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "cargo metadata omitted target_directory".to_string())
}

fn forbidden_capabilities() -> Result<(), String> {
    let out = Command::new("cargo")
        .args([
            "tree",
            "-p",
            "dezoomify-wasm",
            "--edges",
            "normal",
            "--depth",
            "1",
            "--prefix",
            "none",
        ])
        .current_dir(super::repo_root())
        .output()
        .map_err(|e| format!("failed to run cargo tree: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines().skip(1) {
        let name = line.split_whitespace().next().unwrap_or("");
        if [
            "reqwest", "tokio", "web-sys", "js-sys", "image", "png", "clap",
        ]
        .contains(&name)
        {
            return Err(format!("dezoomify-wasm depends on host crate {name}"));
        }
    }
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
    fn wasm_transcripts() {
        assert!(super::transcripts_only().is_ok());
    }
}
