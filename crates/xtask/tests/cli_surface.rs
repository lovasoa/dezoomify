//! Stable CLI surface contract (todo 6.2 xtask slim-down).
//!
//! The task/target/lane/flag vocabulary in `crates/xtask/README.md` is
//! stable: unknown tasks, targets, lanes, and flags must fail with a usage
//! error instead of succeeding as no-ops or silently widening coverage.
//! These tests pin that contract end to end against the built binary (fast
//! rejection paths only; no suite ever runs here).

use std::process::Command;

fn xtask(args: &[&str]) -> std::process::Output {
    let exe = env!("CARGO_BIN_EXE_xtask");
    Command::new(exe)
        .args(args)
        .output()
        .expect("run xtask binary")
}

fn stdout_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr_text(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn help_lists_the_stable_surface() {
    let out = xtask(&["--help"]);
    assert!(out.status.success(), "help failed: {}", stderr_text(&out));
    let help = stdout_text(&out);
    for token in [
        "setup", "check", "fixtures", "protocol", "build", "dev", "ci", "release", "test",
        "digest", "perf",
    ] {
        assert!(help.contains(token), "help lacks {token}");
    }
}

#[test]
fn rejects_unknown_tasks_targets_and_lanes() {
    let cases: &[&[&str]] = &[
        &["bogus"],
        &["build", "bogus"],
        &["dev", "bogus"],
        &["fixtures", "bogus"],
        &["protocol", "bogus"],
        &["ci", "bogus"],
        &["release", "bogus"],
        &["test", "bogus"],
        &["test", "live"],
    ];
    for args in cases {
        let out = xtask(args);
        assert!(!out.status.success(), "accepted {args:?}");
        let detail = stderr_text(&out);
        assert!(
            detail.contains("unknown") || detail.contains("usage"),
            "rejection for {args:?} carries no usage guidance: {detail}"
        );
    }
}

#[test]
fn rejects_unknown_flags_without_running_suites() {
    // Every case fails during argument parsing, before any suite, build, or
    // network effect.
    let cases: &[&[&str]] = &[
        &["check", "--bogus"],
        &["fixtures", "verify", "--bogus"],
        &["fixtures", "serve", "--bogus"],
        &["test", "core", "--bogus"],
        &["test", "perf", "--bogus"],
        &["test", "native", "--bogus"],
        &["ci", "digest", "--bogus"],
        &["ci", "digest", "--check"],
        &["release", "verify", "--bogus"],
    ];
    for args in cases {
        let out = xtask(args);
        assert!(!out.status.success(), "accepted {args:?}");
        let detail = stderr_text(&out);
        assert!(
            detail.contains("unknown") || detail.contains("usage") || detail.contains("missing"),
            "rejection for {args:?} carries no usage guidance: {detail}"
        );
    }
}

#[test]
fn digest_round_trip_attests_inputs() {
    let out = xtask(&["ci", "digest"]);
    assert!(
        out.status.success(),
        "ci digest failed: {}",
        stderr_text(&out)
    );
    let computed = stdout_text(&out).trim().to_string();
    assert_eq!(computed.len(), 64, "digest is not sha256 hex: {computed}");
    assert!(
        computed.chars().all(|c| c.is_ascii_hexdigit()),
        "digest is not hex: {computed}"
    );
    let out = xtask(&["ci", "digest", "--check", &computed]);
    assert!(
        out.status.success(),
        "digest --check rejected its own output: {}",
        stderr_text(&out)
    );
    let out = xtask(&["ci", "digest", "--check", &"0".repeat(64)]);
    assert!(
        !out.status.success(),
        "digest --check accepted a wrong digest"
    );
}
