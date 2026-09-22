//! `cargo xtask test`: fast deterministic Rust and JavaScript aggregate.

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
            Some("web") => return super::browser::test_web(&args[1..]),
            Some("ui") => return test_ui(&args[1..]),
            Some("app-model") => return test_app_model(&args[1..]),
            Some("native") => return super::native::test_native(&args[1..]),
            Some("scenario") => return super::native::test_scenario(&args[1..]),
            Some("desktop") => return super::desktop::test_desktop(&args[1..]),
            Some("extension") => return super::extension::test_extension(&args[1..]),
            Some("perf") => return super::perf::run(&args[1..]),
            Some("all") => return super::ci::test_all(),
            _ => {}
        }
        return Err(format!(
            "unknown test arguments (targets: core, protocol, job, wasm, browser, ui, app-model, web, native, scenario, desktop, extension, perf, all, live): {}",
            args.join(" ")
        ));
    }
    cargo_test()?;
    super::browser::generate_web_artifacts()?;
    node_test()
}

fn cargo_test() -> Result<(), String> {
    super::command::cargo_test(&["--workspace"])
}

/// `test ui`: shared-UI snapshot presentation plus the product-agnostic view
/// contract (fold/presentation, rendering, a11y, i18n, history, handoff copy).
/// No engine, no network, no browsers.
pub(crate) fn test_ui(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err(format!(
            "unknown test ui arguments: {}; usage: cargo xtask test ui",
            args.join(" ")
        ));
    }
    super::command::node_test(
        &[
            "test/snapshot-view.test.mjs",
            "test/presentation.test.mjs",
            "test/view-rendering.test.mjs",
            "test/ui-a11y.test.mjs",
            "test/ui-i18n.test.mjs",
            "test/ui-mobile.test.mjs",
            "test/history.test.mjs",
            "test/handoff.test.mjs",
            "test/hash.test.mjs",
        ],
        true,
    )
}

/// `test app-model`: host-neutral service, snapshot predicates, history,
/// and labels. Pure Node, no hosts.
pub(crate) fn test_app_model(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err(format!(
            "unknown test app-model arguments: {}; usage: cargo xtask test app-model",
            args.join(" ")
        ));
    }
    super::command::node_test(&["test/app-model.test.mjs"], true)
}

fn node_test() -> Result<(), String> {
    super::command::node_test(
        &[
            "test/*.test.mjs",
            "packages/browser-runtime/test/*.test.mjs",
            "apps/desktop/tests/*.test.mjs",
            // These two tests consume generated WASM and WXT output. The
            // explicit extension integration lane regenerates both first.
            "apps/extension/tests/unit/!(job-worker|manifest-policy).test.mjs",
        ],
        true,
    )
}
