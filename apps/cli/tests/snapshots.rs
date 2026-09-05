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
    assert_eq!(String::from_utf8(version.stdout).unwrap(), "dezoomify-cli 1.0.0\n");
}

mod testdata {
    /// Reads a scenario-relative file under `testdata/scenarios/`.
    pub fn scenario(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios")
            .join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("missing scenario file {rel}: {e}"))
    }
}

#[test]
fn invalid_flag_fails() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--nope")
        .output()
        .expect("run cli");
    assert!(!out.status.success());
}
