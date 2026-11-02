//! Check the CLI's public entry points without pinning help prose.
use std::process::Command;

#[test]
fn help_and_version_exit_without_io_or_prompting() {
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
            .args(args)
            .output()
            .unwrap()
    };
    let help = run(&["--help"]);
    assert!(help.status.success());
    assert!(!help.stdout.is_empty());
    assert!(help.stderr.is_empty());
    for args in [&[][..], &["-?"][..]] {
        let output = run(args);
        assert!(output.status.success());
        assert_eq!(output.stdout, help.stdout);
        assert!(output.stderr.is_empty());
    }
    let version = run(&["--version"]);
    assert!(version.status.success());
    assert!(version.stderr.is_empty());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap(),
        format!(
            "dezoomify-cli {}\n",
            option_env!("DEZOOMIFY_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
        )
    );
}

#[test]
fn noninteractive_missing_input_is_a_usage_error() {
    for args in [["--largest"], ["--json"]] {
        let run = Command::new(env!("CARGO_BIN_EXE_dezoomify-cli"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(run.status.code(), Some(2));
        assert!(run.stdout.is_empty());
        let stderr = String::from_utf8(run.stderr).unwrap();
        assert!(stderr.contains("no input given"));
        assert!(!stderr.contains("Enter an URL"));
        assert!(!stderr.contains('\u{1b}'));
    }
}
