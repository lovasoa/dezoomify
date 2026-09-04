//! `cargo xtask test`: fast deterministic aggregate.
//! Runs check, workspace unit tests, core, protocol, job, wasm, browser, UI,
//! and web suites plus the legacy-web harness. Named test targets exist only
//! for their owner phases (core 04, protocol 05, job 06, wasm 07,
//! browser/ui/web 08-09). Rejects opt-in live flags; propagates the first
//! nonzero result with a stable summary.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        if args.iter().any(|a| a == "--live" || a.starts_with("live")) {
            return Err("live tests are not part of the deterministic suite".to_string());
        }
        match args.first().map(String::as_str) {
            Some("core") => return super::core::run(&args[1..]),
            Some("protocol") => {
                if args.len() > 1 {
                    return Err(format!(
                        "unknown test protocol arguments: {}",
                        args[1..].join(" ")
                    ));
                }
                return super::protocol::test_protocol();
            }
            Some("job") => return super::job::run(&args[1..]),
            Some("wasm") => return super::wasm::run(&args[1..]),
            Some("browser") => return super::browser::test_browser(&args[1..]),
            Some("ui") => return super::browser::test_ui(&args[1..]),
            Some("web") => return super::browser::test_web(&args[1..]),
            _ => {}
        }
        return Err(format!(
            "unknown test arguments (targets: core, protocol, job, wasm, browser, ui, web): {}",
            args.join(" ")
        ));
    }
    let mut summary: Vec<(&'static str, bool)> = Vec::new();
    run_step("check", &mut summary, || super::check::run(&[]))?;
    run_step("cargo-test", &mut summary, cargo_test)?;
    run_step("test-core", &mut summary, || super::core::run(&[]))?;
    run_step(
        "test-protocol",
        &mut summary,
        super::protocol::test_protocol,
    )?;
    run_step("test-job", &mut summary, || super::job::run(&[]))?;
    run_step("test-wasm", &mut summary, || super::wasm::run(&[]))?;
    run_step("test-browser", &mut summary, || {
        super::browser::test_browser(&[])
    })?;
    run_step("test-ui", &mut summary, || super::browser::test_ui(&[]))?;
    run_step("test-web", &mut summary, || super::browser::test_web(&[]))?;
    run_step("legacy-web-harness", &mut summary, legacy_web_harness)?;
    print_summary(&summary);
    println!("test: all fast deterministic suites pass");
    Ok(())
}

fn run_step(
    name: &'static str,
    summary: &mut Vec<(&'static str, bool)>,
    step: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let ok = step().is_ok();
    summary.push((name, ok));
    if !ok {
        print_summary(summary);
        return Err(format!("test step '{name}' failed"));
    }
    Ok(())
}

fn cargo_test() -> Result<(), String> {
    let status = std::process::Command::new("cargo")
        .args(["test", "-p", "xtask", "-p", "dezoomify-fixture-server"])
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo test: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "cargo test failed".to_string())
}

fn print_summary(summary: &[(&str, bool)]) {
    println!("test summary:");
    for (name, ok) in summary {
        println!("  {}: {}", name, if *ok { "pass" } else { "FAIL" });
    }
}

fn legacy_web_harness() -> Result<(), String> {
    let root = super::repo_root();
    let dir = root.join("crates/fixture-server/tests/legacy-web");
    for cmd in ["npm ci", "npm test"] {
        let mut parts = cmd.split_whitespace();
        let status = std::process::Command::new(parts.next().expect("cmd"))
            .args(parts)
            .current_dir(&dir)
            .status()
            .map_err(|e| format!("harness '{cmd}' failed to run: {e}"))?;
        if !status.success() {
            return Err(format!("harness '{cmd}' failed"));
        }
    }
    Ok(())
}
