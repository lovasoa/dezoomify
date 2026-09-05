//! `cargo xtask ci <lane>|local`, `test all|live`.

use std::process::Command;

const LANES: &[&str] = &[
    "rust",
    "wasm",
    "browser",
    "web",
    "native",
    "desktop",
    "extension",
    "protocol",
    "security",
];

pub fn ci(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("local") => {
            for lane in LANES {
                ci_lane(lane)?;
            }
            println!("ci local: ok");
            Ok(())
        }
        Some(lane) if LANES.contains(&lane) => ci_lane(lane),
        Some(other) => Err(format!("unknown ci lane '{other}'")),
        None => Err("usage: cargo xtask ci <lane>|local".to_string()),
    }
}

fn ci_lane(lane: &str) -> Result<(), String> {
    match lane {
        "rust" => {
            super::style::verify(&[])?;
            run_cargo(&[
                "test",
                "-p",
                "dezoomify-core",
                "-p",
                "dezoomify-protocol",
                "-p",
                "dezoomify-job",
                "-p",
                "dezoomify-native",
            ])
        }
        "wasm" => super::wasm::run(&[]),
        "browser" => super::browser::test_browser(&[]),
        "web" => super::browser::test_web(&[]),
        "native" => super::native::test_native(&[]),
        "desktop" => super::desktop::test_desktop(&[]),
        "extension" => super::extension::test_extension(&[]),
        "protocol" => super::protocol::test_protocol(),
        "security" => {
            super::protocol::run(&["check".to_string()])?;
            println!("ci security: ok");
            Ok(())
        }
        _ => Err(format!("unknown lane {lane}")),
    }
}

pub fn test_all() -> Result<(), String> {
    super::test_cmd::run(&[])?;
    println!("test all: ok (fast deterministic aggregate)");
    Ok(())
}

pub fn test_live(args: &[String]) -> Result<(), String> {
    super::live::test_live(args)
}

fn run_cargo(args: &[&str]) -> Result<(), String> {
    let status = Command::new("cargo")
        .args(args)
        .current_dir(super::repo_root())
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("cargo {} failed", args.join(" ")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn live_dry_run() {
        assert!(super::test_live(&["--dry-run".to_string(), "--fixtures".to_string()]).is_ok());
    }
}
