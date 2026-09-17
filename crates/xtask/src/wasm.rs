//! `cargo xtask build wasm` / `cargo xtask test wasm [--browser <name>]`.
//! Adapter-only gate: target/tool versions, forbidden capabilities, adapter
//! tests, Node harness, and native/WASM transcript equality. The `--browser`
//! flag runs the Node harness and then a real headless-Chromium pass over
//! the compiled adapter through the webapp E2E suite.

use std::process::Command;

pub fn build_wasm(_args: &[String]) -> Result<(), String> {
    super::command::cargo(&[
        "build",
        "--quiet",
        "-p",
        "dezoomify-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ])?;
    println!("build wasm: ok (target/wasm32-unknown-unknown/debug)");
    Ok(())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let mut browser: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--browser" => {
                i += 1;
                browser = Some(args.get(i).ok_or("missing --browser <name>")?.clone());
            }
            other => return Err(format!("unknown test wasm option '{other}'")),
        }
        i += 1;
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
    super::command::cargo_test(&["-p", "dezoomify-wasm"])?;
    run_node_harness()?;
    Ok(())
}

fn browser_focus(_name: &str) -> Result<(), String> {
    run_node_harness()?;
    // Real headless browser run: the webapp E2E loads the compiled wasm
    // adapter (wasm-bindgen glue, release profile) inside Chromium and
    // exercises session/dispatch/buffer plumbing end to end.
    super::browser::run_e2e()?;
    Ok(())
}

pub(crate) fn run_node_harness() -> Result<(), String> {
    generate_node_bindings()?;
    super::command::node_test(&["packages/wasm-harness/src/*.spec.mjs"], false)
}

fn generate_node_bindings() -> Result<(), String> {
    super::command::cargo(&[
        "build",
        "--quiet",
        "-p",
        "dezoomify-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ])?;
    let target_dir = super::cargo_target_directory()?;
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
