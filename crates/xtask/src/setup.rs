//! `cargo xtask setup`: verify pinned tools and prepare phase-03 dependencies.
//! Idempotent; never installs later-app toolchains.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask setup (no options)".to_string());
    }
    let rustc = version_of("rustc", &["--version"])?;
    println!("rustc: {rustc}");
    let cargo = version_of("cargo", &["--version"])?;
    println!("cargo: {cargo}");
    let node = version_of("node", &["--version"])?;
    println!("node: {node}");
    if !rustc.contains("1.98.0") {
        return Err(format!("rust-toolchain.toml pins 1.98.0, found: {rustc}"));
    }
    println!("setup: pinned tools ok (phase-03 scope only)");
    Ok(())
}

fn version_of(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {cmd}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{cmd} failed"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
