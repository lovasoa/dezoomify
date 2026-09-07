//! `cargo xtask test perf [--smoke]`: native pipeline perf tracking (todo 3.1).
//!
//! `--smoke` runs the fast deterministic perf smoke
//! (`cargo test -p dezoomify-native --test perf`): fixed-pool width, 512 MiB
//! spill decision, 20k streaming-halves-legacy model, 40k canvas-limit gate,
//! versioned cache keys, and encoded byte sizes within 20 percent of
//! `crates/dezoomify-native/tests/perf-baseline.json`. No gigapixel
//! allocation, no public network.
//!
//! Without `--smoke`, the same smoke runs first, then the criterion benches
//! (`tile-throughput`, `encode time`, `peak RSS on 20k model`) run with
//! `--quick` for CI tracking. A deterministic regression beyond 20 percent
//! fails the lane; wall-time numbers print for tracking.

use std::process::Command;

pub fn run(args: &[String]) -> Result<(), String> {
    let mut smoke = false;
    for arg in args {
        if arg == "--smoke" {
            smoke = true;
        } else {
            return Err(format!(
                "unknown test perf argument '{arg}' (only '--smoke' exists)"
            ));
        }
    }
    run_cargo(&["test", "-p", "dezoomify-native", "--test", "perf"])?;
    if smoke {
        println!("test perf: ok (smoke)");
        return Ok(());
    }
    run_cargo(&[
        "bench",
        "-p",
        "dezoomify-native",
        "--bench",
        "native_pipeline",
        "--",
        "--quick",
    ])?;
    println!("test perf: ok (smoke + benches)");
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
