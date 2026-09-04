//! `cargo xtask test job [--transcripts]`: deterministic job-engine gate.
//! Bare target runs architecture checks, all crate tests, native/WASM
//! compilation, and transcript verification. `--transcripts` focuses the
//! scenario-local transcript comparison (read-only; never updates bytes).

use std::process::Command;

pub fn run(args: &[String]) -> Result<(), String> {
    if args.len() > 1 {
        return Err("usage: cargo xtask test job [--transcripts]".to_string());
    }
    if args.first().map(String::as_str) == Some("--transcripts") {
        return transcripts_only();
    }
    if !args.is_empty() {
        return Err(format!("unknown test job arg '{}'", args[0]));
    }
    run_cargo(&["check", "-p", "dezoomify-job", "--no-default-features"])?;
    run_cargo(&[
        "check",
        "-p",
        "dezoomify-job",
        "--target",
        "wasm32-unknown-unknown",
        "--no-default-features",
    ])?;
    // Purity: job depends inward only on core/protocol + pure serde.
    let tree = cargo_tree()?;
    for line in tree.lines() {
        let name = line.split_whitespace().next().unwrap_or("");
        if [
            "reqwest",
            "tokio",
            "async-std",
            "smol",
            "image",
            "png",
            "wasm-bindgen",
            "web-sys",
            "js-sys",
            "clap",
        ]
        .contains(&name)
        {
            return Err(format!("dezoomify-job depends on host crate {name}"));
        }
    }
    run_cargo(&["test", "-p", "dezoomify-job"])?;
    transcripts_only()?;
    println!("test job: ok");
    Ok(())
}

fn transcripts_only() -> Result<(), String> {
    for rel in [
        "testdata/scenarios/job/basic-success/expected/job.json",
        "testdata/scenarios/job/cancel-midway/expected/job.json",
    ] {
        let path = super::repo_root().join(rel);
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("missing transcript {rel}: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad transcript {rel}: {e}"))?;
        if value.as_array().is_none_or(Vec::is_empty) {
            return Err(format!("transcript {rel} is empty"));
        }
    }
    // Focused transcript verification also re-runs the workflow tests that
    // pin transcript equality.
    run_cargo(&["test", "-p", "dezoomify-job", "--test", "workflows"])?;
    println!("test job --transcripts: ok");
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

fn cargo_tree() -> Result<String, String> {
    let out = Command::new("cargo")
        .args([
            "tree",
            "-p",
            "dezoomify-job",
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
    if !out.status.success() {
        return Err("cargo tree failed".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn job_transcripts() {
        assert!(super::transcripts_only().is_ok());
    }
}
