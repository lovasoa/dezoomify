//! CLI snapshots: help, version, invalid args, collisions.

#[test]
fn help_snapshot_matches_golden_byte_for_byte() {
    let help = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--help")
        .output()
        .expect("run cli");
    assert!(help.status.success());
    let golden = testdata::scenario("cli/help/expected/snapshot.txt");
    assert_eq!(
        String::from_utf8(help.stdout).unwrap(),
        golden,
        "--help output drifted from testdata/scenarios/cli/help/expected/snapshot.txt; \
         update the golden alongside any usage change"
    );
}

#[test]
fn version_snapshot() {
    let version = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--version")
        .output()
        .expect("run cli");
    assert!(version.status.success());
    let stdout = String::from_utf8(version.stdout).unwrap();
    // Shape contract only: `<name> <version>`. The exact number comes from
    // the package and must not be pinned here (it changes every release).
    let expected = format!("dezoomify-cli {}\n", env!("CARGO_PKG_VERSION"));
    assert_eq!(
        stdout, expected,
        "--version must be `dezoomify-cli <pkg version>`"
    );
}

mod testdata {
    /// Reads a scenario-relative file under `testdata/scenarios/`.
    pub fn scenario(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios")
            .join(rel);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("missing scenario file {rel}: {e}"))
    }
}

#[test]
fn invalid_flag_fails() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--nope")
        .output()
        .expect("run cli");
    // Unknown flags are argument errors: exit 2 with the typed message on
    // stderr (main.rs prints `error: {message}` for parse failures, with the
    // `(code)` suffix reserved for pipeline NativeErrors). stdout must stay
    // clean so machine JSON is never polluted.
    assert_eq!(out.status.code(), Some(2), "unknown flag must exit 2");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(
        stdout.is_empty(),
        "arg error must not pollute stdout, got: {stdout:?}"
    );
    assert!(
        stderr.contains("error: unknown flag --nope"),
        "stderr must carry `error: unknown flag --nope`, got: {stderr:?}"
    );
}

#[test]
fn no_args_prints_help_without_prompting() {
    // Without a TTY there is no interactive prompt: missing positionals
    // print help to stdout. With a TTY, main prompts for input/output.
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .output()
        .expect("run cli");
    assert!(out.status.success(), "no-args must exit 0 with help");
    let golden = testdata::scenario("cli/help/expected/snapshot.txt");
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        golden,
        "no-args output must equal the --help golden"
    );
    assert!(
        String::from_utf8(out.stderr).unwrap().is_empty(),
        "help must not pollute stderr"
    );
}

#[test]
fn unknown_flags_still_fail() {
    // Unrelated flags must keep failing as unknown with exit 2.
    for flag in ["--definitely-unknown", "--nope", "-Z"] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
            .arg(flag)
            .output()
            .expect("run cli");
        assert_eq!(
            out.status.code(),
            Some(2),
            "{flag} must exit 2 as an unknown flag"
        );
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert!(
            stderr.contains(&format!("error: unknown flag {flag}")),
            "stderr must carry `error: unknown flag {flag}`, got: {stderr:?}"
        );
    }
}

#[test]
fn ported_flags_are_known() {
    // Ported selection flags must not fail as unknown. Without positionals
    // they print help (exit 0); without a value they report a missing value
    // (exit 2) but never `unknown flag`.
    let help_flags: &[&[&str]] = &[
        &["--largest"],
        &["-l"],
        &["--dezoomer", "auto"],
        &["-d", "auto"],
        &["--max-height", "800"],
        &["-h", "800"],
        &["--zoom-level", "0"],
        &["--parallelism", "8"],
        &["-n", "8"],
        &["--retry-delay", "2s"],
        &["--compression", "5"],
        &["--max-idle-per-host", "32"],
        &["--timeout", "30s"],
        &["--connect-timeout", "6s"],
        &["--logging", "info"],
        &["-V"],
        &["-?"],
        &["-w", "300"],
        &["-r", "3"],
        &["-i", "50ms"],
        &["-c", "cache-dir"],
    ];
    for argv in help_flags {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"));
        for arg in *argv {
            cmd.arg(arg);
        }
        let out = cmd.output().expect("run cli");
        let stderr = String::from_utf8(out.stderr).unwrap();
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert!(
            !stderr.contains("unknown flag"),
            "{argv:?} must not be unknown, stderr: {stderr:?}"
        );
        assert!(
            !stdout.contains("unknown flag"),
            "{argv:?} must not be unknown, stdout: {stdout:?}"
        );
    }
}
