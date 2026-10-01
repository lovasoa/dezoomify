//! `cargo xtask build wasm` / `cargo xtask test wasm [--browser <name>]`.
//! Fresh generated Host bindings and product execution in Chromium. Also the
//! one cargo-build + wasm-bindgen pipeline shared with `bindings generate`
//! and the extension glue.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Build `dezoomify-wasm` for wasm32 and return the raw `.wasm` artifact.
pub(crate) fn build_wasm_artifact(release: bool) -> Result<PathBuf, String> {
    let mut build = Command::new("cargo");
    build.args(["build", "--quiet", "-p", "dezoomify-wasm"]);
    if release {
        build.arg("--release");
    }
    let status = build
        .args(["--target", "wasm32-unknown-unknown"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err("wasm core build failed".to_string());
    }
    let profile = if release { "release" } else { "debug" };
    Ok(super::cargo_target_directory()?.join(format!(
        "wasm32-unknown-unknown/{profile}/dezoomify_wasm.wasm"
    )))
}

/// One generated tree of the shared wasm-bindgen pipeline: the `--target`,
/// output directory, output name, and declaration switch.
pub(crate) struct Bindgen<'a> {
    pub(crate) target: &'a str,
    pub(crate) out_dir: &'a Path,
    pub(crate) out_name: &'a str,
    pub(crate) typescript: bool,
}

/// Run `wasm-bindgen` over a built artifact: the only place the CLI is
/// invoked, so every generated tree (web glue, typed declarations, Node
/// harness) comes from one pipeline.
pub(crate) fn run_wasm_bindgen(input: &Path, bindgen: &Bindgen<'_>) -> Result<(), String> {
    let Bindgen {
        target,
        out_dir,
        out_name,
        typescript,
    } = bindgen;
    let mut command = Command::new("wasm-bindgen");
    command.args(["--target", target]);
    if *typescript {
        command.arg("--typescript");
    }
    let status = command
        .arg("--out-dir")
        .arg(out_dir)
        .arg("--out-name")
        .arg(out_name)
        .arg(input)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run wasm-bindgen (run `cargo xtask setup`): {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "wasm-bindgen failed".to_string())
}

pub fn build_wasm(_args: &[String]) -> Result<(), String> {
    build_wasm_artifact(false)?;
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
    // function (wasm-bindgen glue, release profile) inside Chromium.
    super::browser::run_e2e()?;
    Ok(())
}

pub(crate) fn run_node_harness() -> Result<(), String> {
    generate_node_bindings()?;
    super::command::node_test(&["packages/wasm-harness/src/*.spec.mjs"], false)
}

fn generate_node_bindings() -> Result<(), String> {
    let input = build_wasm_artifact(false)?;
    let output = super::cargo_target_directory()?.join("wasm-node-harness");
    run_wasm_bindgen(
        &input,
        &Bindgen {
            target: "nodejs",
            out_dir: &output,
            out_name: "dezoomify_wasm",
            typescript: false,
        },
    )?;
    // The `nodejs` target emits CommonJS, but the generated tree lives under
    // the repository's `target/`, which would inherit the root package's
    // `"type": "module"`. Pin the directory so Node never reparses the
    // bindings as ESM (which fails on `exports`/`__dirname`).
    let package_json = output.join("package.json");
    std::fs::write(&package_json, "{\"type\":\"commonjs\"}\n")
        .map_err(|e| format!("cannot write {}: {e}", package_json.display()))?;
    Ok(())
}
