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
    // No interactive prompt exists: missing positionals print help to stdout.
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
fn removed_flags_stay_unknown() {
    // The surface is --overwrite/--json/--max-width/--accept-invalid-certs/
    // -H/--header/--image-index/--retries/--min-interval/--tile-cache/
    // --outfile: bulk and unrelated selection flags must fail as unknown.
    for flag in ["--bulk", "--largest", "--zoom-level", "--parallelism"] {
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
