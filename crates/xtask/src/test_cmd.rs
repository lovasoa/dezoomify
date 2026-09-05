//! `cargo xtask test`: fast deterministic aggregate.
//! Runs check, workspace unit tests, core, protocol, job, wasm, browser, UI,
//! web, native, scenario, desktop, extension, and native-messaging suites.
//! Named test targets exist only for their owning layers. Rejects opt-in
//! live flags; propagates the first nonzero result with a stable summary.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        // Live compatibility is opt-in and isolated: only the explicit
        // dry-run form reaches the live handler; every other live spelling
        // stays rejected from the deterministic suite.
        if args.first().map(String::as_str) == Some("live") {
            return super::ci::test_live(&args[1..]);
        }
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
            Some("native") => return super::native::test_native(&args[1..]),
            Some("scenario") => return super::native::test_scenario(&args[1..]),
            Some("desktop") => return super::desktop::test_desktop(&args[1..]),
            Some("extension") => return super::extension::test_extension(&args[1..]),
            Some("native-messaging") => {
                return super::extension::test_native_messaging(&args[1..]);
            }
            Some("all") => return super::ci::test_all(),
            _ => {}
        }
        return Err(format!(
            "unknown test arguments (targets: core, protocol, job, wasm, browser, ui, web, native, scenario, desktop, extension, native-messaging, all, live): {}",
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
    run_step("test-native", &mut summary, || {
        super::native::test_native(&[])
    })?;
    run_step("test-scenario", &mut summary, || {
        super::native::test_scenario(&[])
    })?;
    run_step("test-desktop", &mut summary, || {
        super::desktop::test_desktop(&[])
    })?;
    run_step("test-extension", &mut summary, || {
        super::extension::test_extension(&[])
    })?;
    run_step("test-native-messaging", &mut summary, || {
        super::extension::test_native_messaging(&[])
    })?;
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
