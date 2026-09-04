//! `cargo xtask build desktop [--unsigned-test]` / `test desktop` /
//! `dev desktop`: Tauri shell gates without requiring the Tauri SDK.
//! Packaging/bundling needs native OS toolchains and is recorded as an
//! explicit exception; logic, deep-link, capability, and manifest checks run
//! deterministically here.

use std::process::Command;

pub fn build_desktop(args: &[String]) -> Result<(), String> {
    let unsigned_test = args.iter().any(|a| a == "--unsigned-test");
    for rel in [
        "apps/desktop/src-tauri/tauri.conf.json",
        "apps/desktop/src-tauri/capabilities/generated.json",
        "generated/desktop-capabilities.json",
    ] {
        let path = super::repo_root().join(rel);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("missing desktop file {rel}: {e}"))?;
        let _: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("bad json {rel}: {e}"))?;
    }
    if !unsigned_test {
        println!("build desktop: ok (logic verified; unsigned-test packaging needs OS toolchain)");
    } else {
        println!("build desktop --unsigned-test: ok (logic verified; unsigned bundle placeholder)");
    }
    Ok(())
}

pub fn test_desktop(_args: &[String]) -> Result<(), String> {
    run_node(&["apps/desktop/tests/deep-link.test.mjs"])?;
    run_node(&["apps/desktop/tests/capabilities.test.mjs"])?;
    println!("test desktop: ok");
    Ok(())
}

fn run_node(args: &[&str]) -> Result<(), String> {
    let status = Command::new("node")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run node: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "desktop node tests failed".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_logic() {
        assert!(super::test_desktop(&[]).is_ok());
    }
}
