//! CLI snapshots: help, version, invalid args, collisions.

#[test]
fn help_and_version_snapshot() {
    let help = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--help")
        .output()
        .expect("run cli");
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("usage: dezoomify-cli"));
    let version = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--version")
        .output()
        .expect("run cli");
    assert!(version.status.success());
}

#[test]
fn invalid_flag_fails() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
        .arg("--nope")
        .output()
        .expect("run cli");
    assert!(!out.status.success());
}
