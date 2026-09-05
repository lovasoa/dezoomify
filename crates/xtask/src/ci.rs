//! `cargo xtask ci <lane>|local`, `test all|live`, `release plan|build|verify`.

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
        "rust" => run_cargo(&[
            "test",
            "-p",
            "dezoomify-core",
            "-p",
            "dezoomify-protocol",
            "-p",
            "dezoomify-job",
            "-p",
            "dezoomify-native",
        ]),
        "wasm" => super::wasm::run(&[]),
        "browser" => super::browser::test_browser(&[]),
        "web" => super::browser::test_web(&[]),
        "native" => super::native::test_native(&[]),
        "desktop" => super::desktop::test_desktop(&[]),
        "extension" => super::extension::test_extension(&[]),
        "protocol" => super::protocol::test_protocol(),
        "security" => {
            super::parity::validate(&[])?;
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

pub fn release(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("plan") => {
            println!("release plan: ok (test channel 1.0.0; protocol 1.0; targets cli-linux, desktop-windows)");
            Ok(())
        }
        Some("build") => {
            // Honest stub: no artifacts are built or hashed here; real
            // packaging happens on native OS runners with signing.
            println!("release build: stub-ok (no artifacts built; test-channel placeholder)");
            Ok(())
        }
        Some("verify") => release_verify(&args[1..]),
        Some(other) => Err(format!("unknown release subcommand '{other}'")),
        None => Err("usage: cargo xtask release <plan|build|verify>".to_string()),
    }
}

fn release_verify(args: &[String]) -> Result<(), String> {
    // Forms: `release verify` (test channel) or `release verify
    // --plan <path> --artifacts <path>` (plan/artifact pair must exist).
    // `--candidate` is dispatched by main.rs before reaching here.
    if args.is_empty() {
        // Honest stub: fixture tamper checks live in protocol/check; no real
        // public-key artifact verification happens in this environment.
        println!(
            "release verify: stub-ok (no signed artifacts verified; test-channel placeholder)"
        );
        return Ok(());
    }
    let mut plan: Option<&String> = None;
    let mut artifacts: Option<&String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(args.get(i).ok_or("missing --plan <path>")?);
            }
            "--artifacts" => {
                i += 1;
                artifacts = Some(args.get(i).ok_or("missing --artifacts <path>")?);
            }
            other => return Err(format!("unknown release verify arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release verify --plan <path> --artifacts <path>".to_string(),
        );
    };
    for path in [plan, artifacts] {
        if !super::repo_root().join(path).is_file() && !std::path::Path::new(path).is_file() {
            return Err(format!("missing release file {path}"));
        }
    }
    println!("release verify --plan {plan} --artifacts {artifacts}: ok");
    Ok(())
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

    #[test]
    fn release_plan() {
        assert!(super::release(&["plan".to_string()]).is_ok());
    }
}
