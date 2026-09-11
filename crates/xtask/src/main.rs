//! Repository task runner. Unknown commands fail instead of succeeding as
//! no-ops.

// 6.1 unwrap policy: task failures return `Err(String)` with a usage message
// instead of panicking (see the workspace `clippy.toml` + root `Cargo.toml`
// policy note).
#![deny(clippy::unwrap_used)]

mod architecture;
mod browser;
mod check;
mod ci;
mod content;
mod core;
mod desktop;
mod extension;
mod fixtures;
mod job;
mod live;
mod native;
mod native_messaging;
mod perf;
mod protocol;
mod release;
mod setup;
mod style;
mod supply;
mod test_cmd;
mod transcript;
mod wasm;

use std::process::ExitCode;

const HELP: &str = "cargo xtask <task>\n\nAvailable tasks:\n  setup                 verify pinned tools\n  check                 formatting, lint, prose hygiene, and read-only artifact validation\n  fixtures verify       verify scenario schemas, routes, payloads, and manifest\n  fixtures serve [--port <n>] [--write-address <path>]\n                        serve deterministic fixtures on loopback\n  fixtures capture --url <url> --out <scenario> --redact [--also <url>...]\n                        fetch public metadata and save redacted routes.json and payloads\n  protocol generate [--check]\n                        write Rust-derived TypeScript/schema artifacts\n  protocol check        verify generated artifacts, vectors, and portability\n  build wasm|web|cli|desktop|extension\n                        build app artifacts\n  build desktop [--unsigned-test]\n                        desktop shell + bundle (no bundle with --unsigned-test)\n  dev ui|web|desktop|extension\n                        run the named app's development environment\n  dev extension [--browser <name>]\n                        extension dev with named engine (chromium only)\n  ci <lane>|local|digest [--check <hex>] run CI lanes locally; digest attests release inputs\n  release plan|build|sign|verify|publish\n                        release orchestration\n  test                  run all fast deterministic suites\n  test core [--purity|--parity]\n                        pure discovery core suites\n  test protocol         versioned protocol contract suites\n  test job [--transcripts]\n                        portable job-engine suites\n  test wasm [--transcripts|--browser <name>]\n                        WASM adapter suites\n  test browser [--build-only|--browser <name>|--scenario <id>]\n                        browser-runtime suites\n  test ui               shared-UI controller, view, accessibility, i18n, and mobile suites\n  test web [--e2e|--no-e2e|--skip-browser-matrix|--no-unit|--browser <chromium|firefox|webkit|all>]\n                        website integration suites\n  test native           native runtime + CLI suites\n  test scenario         scenario file suites\n  test desktop [--e2e-window]   desktop shell suites (real window via WebdriverIO embedded WebDriver)\n  test extension        extension unit + manifest suites
  test perf [--smoke]     native pipeline perf smoke + benches (opt-in, tracked)\n  test native-messaging [--browser <name>|--cleanup-only] [--skip-unit|--no-unit]\n                        Native Messaging suites\n  test all              full deterministic aggregate\n  test live --dry-run --fixtures\n                        live-compat dry run (no public targets)\n  test live --public [--limit <n>] [--site <id>]\n                        low-volume public download check (real bytes, opt-in)\n  test live --webapp    live webapp check in Chromium (opt-in, diagnostic)\n";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(args: &[String]) -> Result<(), String> {
    let first = args.first().map(String::as_str).unwrap_or("--help");
    match first {
        "--help" | "-h" | "help" => {
            print!("{HELP}");
            Ok(())
        }
        "setup" => setup::run(&args[1..]),
        "check" => check::run(&args[1..]),
        "fixtures" => match args.get(1).map(String::as_str) {
            Some("verify") => fixtures::verify(&args[2..]),
            Some("serve") => fixtures::serve(&args[2..]),
            Some("capture") => fixtures::capture(&args[2..]),
            Some(other) => Err(format!(
                "unknown fixtures subcommand '{other}' (only 'verify|serve|capture' exist)"
            )),
            None => Err("usage: cargo xtask fixtures <verify|serve|capture> [options]".to_string()),
        },
        "protocol" => protocol::run(&args[1..]),
        "build" => match args.get(1).map(String::as_str) {
            Some("wasm") => wasm::build_wasm(&args[2..]),
            Some("web") => browser::build_web(&args[2..]),
            Some("cli") => native::build_cli(&args[2..]),
            Some("desktop") => desktop::build_desktop(&args[2..]),
            Some("extension") => extension::build_extension(&args[2..]),
            Some(other) => Err(format!("unknown build target '{other}'")),
            None => Err("usage: cargo xtask build <wasm|web|cli|desktop|extension>".to_string()),
        },
        "dev" => match args.get(1).map(String::as_str) {
            Some("ui") | Some("web") | Some("desktop") | Some("extension") => {
                // `Some` by the match guard above; bind it instead of
                // re-indexing (6.1 unwrap policy: no panics on argv).
                let Some(target) = args.get(1) else {
                    return Err("usage: cargo xtask dev <ui|web|desktop|extension>".to_string());
                };
                browser::dev(target, &args[2..])
            }
            Some(other) => Err(format!("unknown dev target '{other}'")),
            None => Err("usage: cargo xtask dev <ui|web|desktop|extension>".to_string()),
        },
        "ci" => ci::ci(&args[1..]),
        "release" => release::run(&args[1..]),
        "test" => test_cmd::run(&args[1..]),
        other => Err(format!(
            "unknown task '{other}' (tasks: setup, check, fixtures, protocol, build, dev, ci, release, test)"
        )),
    }
}

fn repo_root() -> std::path::PathBuf {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let dir = std::path::PathBuf::from(manifest);
    dir.parent()
        .and_then(|p| p.parent())
        .map(std::path::Path::to_path_buf)
        .unwrap_or(dir)
}

/// Resolve Cargo's active target directory rather than assuming `target/`.
///
/// `CARGO_TARGET_DIR` is a supported cache location used by CI and local
/// callers. Every task that builds then launches a Cargo binary must use this
/// path so it executes the artifact Cargo just refreshed.
pub(crate) fn cargo_target_directory() -> Result<std::path::PathBuf, String> {
    let root = repo_root();
    let output = std::process::Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to query Cargo target directory: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata failed while resolving the target directory: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid cargo metadata output: {e}"))?;
    metadata["target_directory"]
        .as_str()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "cargo metadata omitted target_directory".to_string())
}

/// Debug executable path for a binary Cargo has built in this workspace.
pub(crate) fn cargo_debug_binary(name: &str) -> Result<std::path::PathBuf, String> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    Ok(cargo_target_directory()?
        .join("debug")
        .join(format!("{name}{suffix}")))
}

/// Targets that take no options must fail on unknown flags instead of
/// silently widening or skipping coverage (docs/testing.md).
pub(crate) fn reject_unknown_args(target: &str, args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "unknown {target} argument(s): {}; this target takes no options",
            args.join(" ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{dispatch, HELP};
    use std::collections::BTreeSet;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn command_help() {
        // Help lists the implemented command surface: no future commands.
        assert!(dispatch(&s(&["--help"])).is_ok());
        for cmd in [
            "setup", "check", "fixtures", "protocol", "build", "dev", "ci", "release", "test",
        ] {
            assert!(HELP.contains(cmd), "help lacks {cmd}");
        }
        for future in ["quantum", "teleport"] {
            assert!(
                !HELP.lines().any(|l| l.trim_start().starts_with(future)),
                "help advertises future command {future}"
            );
        }
    }

    #[test]
    fn rejects_unavailable_commands() {
        for args in [
            vec!["build", "bogus"],
            vec!["dev", "bogus"],
            vec!["ci", "bogus"],
            vec!["release", "bogus"],
            vec!["protocol", "bogus"],
            vec!["test", "bogus"],
            vec!["bogus"],
        ] {
            assert!(dispatch(&s(&args)).is_err(), "accepted {args:?}");
        }
        // Only implemented subcommands parse.
        assert!(dispatch(&s(&["fixtures", "bogus"])).is_err());
        assert!(dispatch(&s(&["sources", "verify"])).is_err());
        assert!(dispatch(&s(&["parity", "validate"])).is_err());
    }

    #[test]
    fn fixture_manifest() {
        assert!(dispatch(&s(&["fixtures", "verify"])).is_ok());
    }

    #[test]
    fn scenario_schema() {
        for name in [
            "manifest.schema.json",
            "scenario.schema.json",
            "routes.schema.json",
            "transcript.schema.json",
        ] {
            let path = super::repo_root()
                .join("testdata/scenarios/schema")
                .join(name);
            let text = std::fs::read_to_string(&path).expect("read schema");
            let v: serde_json::Value = serde_json::from_str(&text).expect("parse schema");
            assert!(
                v.get("title").and_then(|t| t.as_str()).is_some(),
                "schema {name} needs a title"
            );
            assert!(v.get("type").is_some(), "schema {name} needs a type");
        }
    }

    #[test]
    fn test_command() {
        // Unknown flags and live filters fail instead of widening coverage.
        // `test core` itself is valid (covered by core::tests); unknown core
        // options must fail.
        assert!(dispatch(&s(&["test", "--live"])).is_err());
        assert!(dispatch(&s(&["test", "bogus"])).is_err());
        assert!(dispatch(&s(&["test", "core", "--bogus"])).is_err());
        let _ = BTreeSet::<String>::new();
    }
}
