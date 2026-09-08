//! `cargo xtask fixtures serve`: spawn the deterministic fixture server.
//!
//! Serves `testdata/scenarios` on loopback through the
//! `dezoomify-fixture-server` binary (build it first with
//! `cargo build -p dezoomify-fixture-server`). Unknown options fail instead
//! of being ignored.

use std::path::PathBuf;

pub fn serve(args: &[String]) -> Result<(), String> {
    let mut port = "0".to_string();
    let mut write_address: Option<PathBuf> = None;
    let mut extra: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                port = args
                    .get(i)
                    .cloned()
                    .ok_or("fixtures serve --port needs a value")?;
            }
            "--write-address" => {
                i += 1;
                write_address = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("fixtures serve --write-address needs a value")?
                        .into(),
                );
            }
            other => extra.push(other.to_string()),
        }
        i += 1;
    }
    if !extra.is_empty() {
        return Err(format!(
            "unknown fixtures serve options: {}",
            extra.join(" ")
        ));
    }
    let root = crate::repo_root();
    let exe = crate::cargo_debug_binary("dezoomify-fixture-server")?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--port")
        .arg(&port)
        .arg("--scenarios-dir")
        .arg(root.join("testdata/scenarios"))
        .current_dir(&root);
    if let Some(addr) = write_address {
        cmd.arg("--write-address").arg(addr);
    }
    let status = cmd.status().map_err(|e| {
        format!(
            "failed to run {} (build it first with `cargo build -p dezoomify-fixture-server`): {e}",
            exe.display()
        )
    })?;
    if !status.success() {
        return Err("fixture server exited nonzero".to_string());
    }
    Ok(())
}
