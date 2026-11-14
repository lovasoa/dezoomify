//! `cargo xtask test native`, `test scenario`, `build cli`: native runtime +
//! CLI gates.

pub fn test_native(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test native", args)?;
    super::command::cargo_test(&["-p", "dezoomify-native", "-p", "dezoomify-cli"])
}

/// Keep a complete renderer outside the Rust build graph. CI installs Poppler;
/// local callers opt into this validation after installing the same tools.
pub fn test_pdf(args: &[String]) -> Result<(), String> {
    super::reject_unknown_args("test pdf", args)?;
    let tool = std::process::Command::new("pdftoppm")
        .arg("-v")
        .output()
        .map_err(|error| format!("PDF rendering requires Poppler's pdftoppm: {error}"))?;
    if !tool.status.success() {
        return Err("PDF rendering requires a working pdftoppm".into());
    }
    super::command::cargo_test(&[
        "-p",
        "dezoomify-native",
        "--test",
        "pdf_render",
        "--",
        "--ignored",
    ])
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
