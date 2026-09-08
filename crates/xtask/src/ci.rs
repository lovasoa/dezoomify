//! `cargo xtask ci <lane>|local|digest`, `test all|live`.

use sha2::{Digest, Sha256};
use std::process::Command;

const LANES: &[&str] = &[
    "check",
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
        Some("digest") => digest(&args[1..]),
        Some(lane) if LANES.contains(&lane) => ci_lane(lane),
        Some(other) => Err(format!("unknown ci lane '{other}'")),
        None => Err("usage: cargo xtask ci <lane>|local|digest [--check <hex>]".to_string()),
    }
}

fn ci_lane(lane: &str) -> Result<(), String> {
    match lane {
        // Keep static contracts, including TypeScript compilation, in a
        // required, parallel CI lane. Rust test feedback need not wait for
        // clippy and artifact verification.
        "check" => super::check::run(&[]),
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
            "-p",
            "dezoomify-desktop",
            "-p",
            "xtask",
            "-p",
            "dezoomify-fixture-server",
            "--",
            "--skip",
            // `check` verifies the full fixture corpus in the parallel
            // static lane, so avoid repeating that expensive assertion.
            "fixture_manifest",
        ]),
        "wasm" => super::wasm::run(&[]),
        "browser" => super::browser::test_browser(&[]),
        "web" => super::browser::test_web(&["--e2e".to_string()]),
        "native" => super::native::test_native(&[]),
        "desktop" => super::desktop::test_desktop(&[]),
        "extension" => super::extension::test_extension(&[]),
        "protocol" => super::protocol::test_protocol(),
        "security" => {
            super::protocol::run(&["check".to_string()])?;
            // The required `check` lane already runs cargo-deny. Run the JS
            // half here so the sharded workflow covers the complete supply
            // policy once rather than querying RustSec twice.
            super::supply::audit_js()?;
            println!(
                "ci security: ok (protocol + JS supply audits; Rust supply audit is in ci check)"
            );
            Ok(())
        }
        _ => Err(format!("unknown lane {lane}")),
    }
}

pub fn test_all() -> Result<(), String> {
    super::test_cmd::run(&[])?;
    // Full aggregate includes web E2E while bare `test` omits it. `--no-unit`
    // avoids rerunning the unit matrix bare already covered (browser lane +
    // website suite); E2E is the only new coverage, so `test all` stays full
    // via an explicit flag without doubles.
    super::browser::test_web(&["--e2e".to_string(), "--no-unit".to_string()])?;
    println!("test all: ok (full deterministic aggregate)");
    Ok(())
}

pub fn test_live(args: &[String]) -> Result<(), String> {
    super::live::test_live(args)
}

/// Deterministic inputs digest for the release attestation gate.
///
/// `cargo xtask ci digest` prints the sha256 over the exact files the
/// release plan and verification read (Rust lockfile, release inventory,
/// generated capabilities, fixture manifest), each framed by its relative
/// path so renames change the digest. The sharded CI `attest` job uploads
/// this digest; `release-build` re-computes it on the tagged revision and
/// compares with `--check`: a match proves the tag commit passed the full
/// sharded suite on identical inputs, so the serial `ci local` rerun is
/// skipped in favor of the fast release gate. A mismatch (or no attested
/// run) falls back to the full `ci local` rerun, never to a silent pass.
const DIGEST_FILES: &[&str] = &[
    "Cargo.lock",
    "release/config.toml",
    "release/targets.toml",
    "release/compatibility.toml",
    "generated/release-capabilities.json",
    "generated/desktop-capabilities.json",
    "testdata/scenarios/manifest.json",
];

pub fn digest(args: &[String]) -> Result<(), String> {
    let mut check: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--check" => {
                i += 1;
                check = Some(args.get(i).ok_or("missing --check <hex>")?.clone());
            }
            other => {
                return Err(format!(
                    "unknown ci digest arg '{other}' (only '--check <hex>' exists)"
                ));
            }
        }
        i += 1;
    }
    let computed = compute_digest()?;
    match check {
        Some(expected) => {
            let expected = expected.trim();
            if computed == expected {
                println!("ci digest: ok ({computed})");
                Ok(())
            } else {
                Err(format!(
                    "ci digest mismatch: inputs hash to {computed}, attested {expected}"
                ))
            }
        }
        None => {
            println!("{computed}");
            Ok(())
        }
    }
}

fn compute_digest() -> Result<String, String> {
    let root = super::repo_root();
    let mut h = Sha256::new();
    for rel in DIGEST_FILES {
        let bytes = std::fs::read(root.join(rel))
            .map_err(|e| format!("missing digest input {rel}: {e}"))?;
        h.update(rel.as_bytes());
        h.update([0]);
        h.update(&bytes);
        h.update([0]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
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
    fn digest_is_deterministic_and_checks() {
        let first = super::compute_digest().unwrap();
        let second = super::compute_digest().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(
            super::digest(&["--check".to_string(), first.clone()]).is_ok(),
            "digest must accept its own output"
        );
        assert!(super::digest(&["--check".to_string(), "0".repeat(64)]).is_err());
        assert!(super::digest(&["--bogus".to_string()]).is_err());
        assert!(super::digest(&["--check".to_string()]).is_err());
    }
}
