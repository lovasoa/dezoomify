//! `cargo xtask build wasm` / `cargo xtask test wasm [--transcripts|--browser <name>]`.
//! Adapter-only gate: target/tool versions, forbidden capabilities, adapter
//! tests, Node harness, and native/WASM transcript equality. Real `wasm-pack`
//! browser runs require pinned wasm-pack + browsers and are recorded as an
//! explicit exception (see gate ledger); the `--browser` flag focuses the
//! Node harness shape for the named engine.

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
    println!("test wasm --browser {name}: stub-ok (node harness shape; no headless browser)");
    Ok(())
}

fn run_node_harness() -> Result<(), String> {
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
