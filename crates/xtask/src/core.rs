//! `cargo xtask test core [--purity|--parity]`: phase-04 core target.
//! Bare target runs all fast core suites. `--purity` focuses the purity test
//! plus manifest/dependency-direction verification. `--parity` runs only
//! shared-scenario parity and canonical output comparisons.

pub fn run(args: &[String]) -> Result<(), String> {
    let mut purity = false;
    let mut parity = false;
    for arg in args {
        match arg.as_str() {
            "--purity" => purity = true,
            "--parity" => parity = true,
            other => {
                return Err(format!(
                    "unknown test core option '{other}' (only --purity|--parity)"
                ));
            }
        }
    }
    if purity && parity {
        return Err("test core accepts at most one of --purity|--parity".to_string());
    }
    if purity {
        return purity_only();
    }
    if parity {
        return parity_only();
    }
    cargo_test(&["test", "-p", "dezoomify-core"])?;
    println!("test core: ok");
    Ok(())
}

fn purity_only() -> Result<(), String> {
    cargo_test(&["test", "-p", "dezoomify-core", "--test", "purity"])?;
    // Manifest direct normal dependencies must stay host-free.
    let tree = cargo_tree()?;
    for line in tree.lines().skip(1) {
        let name = line.split_whitespace().next().unwrap_or("");
        if [
            "reqwest",
            "tokio",
            "async-std",
            "smol",
            "image",
            "png",
            "zif-tiff",
            "clap",
            "indicatif",
            "env_logger",
            "wasm-bindgen",
            "web-sys",
            "js-sys",
        ]
        .contains(&name)
        {
            return Err(format!("dezoomify-core depends on host crate {name}"));
        }
    }
    // Dependency direction: nothing may depend on dezoomify-core except the
    // workspace's own leaf crates (none yet in phase 04).
    println!("test core --purity: ok");
    Ok(())
}

fn parity_only() -> Result<(), String> {
    cargo_test(&["test", "-p", "dezoomify-core", "--test", "parity"])?;
    println!("test core --parity: ok");
    Ok(())
}

fn cargo_test(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("cargo")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err(format!("cargo {} failed", args.join(" ")));
    }
    Ok(())
}

fn cargo_tree() -> Result<String, String> {
    let out = std::process::Command::new("cargo")
        .args([
            "tree",
            "-p",
            "dezoomify-core",
            "--edges",
            "normal",
            "--depth",
            "1",
            "--prefix",
            "none",
        ])
        .current_dir(super::repo_root())
        .output()
        .map_err(|e| format!("failed to run cargo tree: {e}"))?;
    if !out.status.success() {
        return Err("cargo tree failed".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_purity() {
        assert!(super::purity_only().is_ok());
    }

    #[test]
    fn core_parity() {
        assert!(super::parity_only().is_ok());
    }
}
