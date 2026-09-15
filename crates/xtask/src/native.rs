//! `cargo xtask test native`, `test scenario`, `build cli`: native runtime +
//! CLI gates.

pub fn test_native(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test native", args)?;
    super::command::cargo_test(&["-p", "dezoomify-native", "-p", "dezoomify-cli"])
}

pub fn test_scenario(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test scenario", args)?;
    super::command::cargo_test(&["-p", "dezoomify-cli", "--test", "snapshots"])?;
    super::command::cargo_test(&["-p", "dezoomify-native", "--test", "scenarios"])?;
    super::command::cargo_test(&["-p", "dezoomify-native", "--test", "pipeline_loopback"])
}

pub fn build_cli(_args: &[String]) -> Result<(), String> {
    super::command::cargo(&["build", "-p", "dezoomify-cli"])?;
    println!("build cli: ok");
    Ok(())
}
