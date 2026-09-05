//! Repository task runner. Phase-gated: phases 03-09 commands exist.
//! Future top-level commands fail as unknown instead of succeeding as no-ops.

mod browser;
mod check;
mod ci;
mod core;
mod cutover;
mod desktop;
mod extension;
mod fixtures;
mod job;
mod live;
mod native;
mod parity;
mod protocol;
mod setup;
mod sources;
mod test_cmd;
mod transcript;
mod wasm;

use std::process::ExitCode;

const HELP: &str = "cargo xtask <task>\n\nAvailable tasks (phases 03-15, test-channel):\n  setup                 verify pinned tools and prepare phase-03 dependencies\n  check                 formatting, lint, and read-only artifact validation\n  sources verify        verify locked source objects and prefix trees\n  fixtures verify       verify scenario schemas, routes, payloads, and manifest\n  fixtures serve        serve deterministic fixtures on loopback\n  parity validate       validate the parity inventory against evidence\n  parity report         write the current parity report under artifacts/\n  protocol generate     write Rust-derived TypeScript/schema artifacts\n  protocol check        verify generated artifacts, vectors, and portability\n  build wasm|web|cli|desktop|extension\n                        build app artifacts\n  dev ui|web|desktop|extension\n                        verify dev sources for the named app\n  ci <lane>|local       run CI lanes locally\n  release plan|build|verify\n                        release orchestration (test channel)\n  test                  run all fast deterministic suites\n  test core [--purity|--parity]\n                        pure discovery core suites\n  test protocol         versioned protocol contract suites\n  test job [--transcripts]\n                        portable job-engine suites\n  test wasm [--transcripts|--browser <name>]\n                        WASM adapter suites\n  test browser [--build-only]\n                        browser-runtime suites\n  test ui               shared-UI controller suites\n  test web              website integration suites\n  test native           native runtime + CLI suites\n  test scenario         scenario file suites\n  test desktop          desktop shell suites\n  test extension        extension unit + manifest suites\n  test native-messaging [--browser <name>|--cleanup-only]\n                        Native Messaging suites\n  test all              full deterministic aggregate\n  test live --dry-run --fixtures\n                        live-compat dry run (no public targets)\n  test live --public [--limit <n>] [--site <id>]\n                        low-volume public download check (real bytes, opt-in)\n";

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
        "sources" => match args.get(1).map(String::as_str) {
            Some("verify") => sources::verify(&args[2..]),
            Some(other) => Err(format!(
                "unknown sources subcommand '{other}' (only 'verify' exists in phase 03)"
            )),
            None => Err("usage: cargo xtask sources verify".to_string()),
        },
        "fixtures" => match args.get(1).map(String::as_str) {
            Some("verify") => fixtures::verify(&args[2..]),
            Some("serve") => fixtures::serve(&args[2..]),
            Some(other) => Err(format!(
                "unknown fixtures subcommand '{other}' (only 'verify|serve' exist in phase 03)"
            )),
            None => Err("usage: cargo xtask fixtures <verify|serve> [options]".to_string()),
        },
        "parity" => match args.get(1).map(String::as_str) {
            Some("validate") => {
                if args.get(2).map(String::as_str) == Some("--native") {
                    native::parity_native()
                } else if args.get(2).map(String::as_str) == Some("--packaged") {
                    cutover::parity_packaged(&args[3..])
                } else {
                    parity::validate(&args[2..])
                }
            }
            Some("report") => parity::report(&args[2..]),
            Some(other) => Err(format!(
                "unknown parity subcommand '{other}' (only 'validate|report' exist in phase 03)"
            )),
            None => Err("usage: cargo xtask parity <validate|report>".to_string()),
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
                browser::dev(args.get(1).expect("target"))
            }
            Some(other) => Err(format!("unknown dev target '{other}'")),
            None => Err("usage: cargo xtask dev <ui|web|desktop|extension>".to_string()),
        },
        "ci" => {
            if args.get(1).map(String::as_str) == Some("cutover-deletion-gate")
                || args.get(1).map(String::as_str) == Some("cutover-clean-tree")
                || args.get(1).map(String::as_str) == Some("postcutover-snapshot")
                || args.get(1).map(String::as_str) == Some("postcutover-validation")
                || args.get(1).map(String::as_str) == Some("postcutover-cleanup-gate")
            {
                cutover::ci_lane(&args[1], &args[2..])
            } else {
                ci::ci(&args[1..])
            }
        }
        "release" => {
            if args.get(1).map(String::as_str) == Some("verify")
                && args.get(2).map(String::as_str) == Some("--candidate")
            {
                cutover::release_verify_candidate()
            } else {
                ci::release(&args[1..])
            }
        }
        "test" => test_cmd::run(&args[1..]),
        other => Err(format!(
            "unknown task '{other}' (tasks: setup, check, sources, fixtures, parity, protocol, build, dev, ci, release, test)"
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

fn run_git(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(repo_root())
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
            "setup", "check", "sources", "fixtures", "parity", "protocol", "build", "dev", "ci",
            "release", "test",
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
        assert!(dispatch(&s(&["sources", "bogus"])).is_err());
        assert!(dispatch(&s(&["fixtures", "bogus"])).is_err());
        assert!(dispatch(&s(&["parity", "bogus"])).is_err());
    }

    #[test]
    fn sources() {
        assert!(dispatch(&s(&["sources", "verify"])).is_ok());
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
    fn fixture_manifest() {
        assert!(dispatch(&s(&["fixtures", "verify"])).is_ok());
    }

    #[test]
    fn parity() {
        assert!(dispatch(&s(&["parity", "validate"])).is_ok());
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
