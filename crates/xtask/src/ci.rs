//! `cargo xtask ci <lane>|local|digest`, `test all|live`.

use sha2::{Digest, Sha256};

const LANES: &[&str] = &[
    "check",
    "rust",
    "wasm",
    "browser",
    "ui",
    "app-model",
    "web",
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
        "rust" => super::command::cargo_test(&["--workspace"]),
        "wasm" => super::wasm::run_node_harness(),
        "browser" => super::command::node_test(&["packages/browser-runtime/test/*.test.mjs"], true),
        "ui" => super::test_cmd::test_ui(&[]),
        "app-model" => super::test_cmd::test_app_model(&[]),
        "web" => super::browser::test_web(&["--e2e".to_string()]),
        "desktop" => super::command::node_test(&["apps/desktop/tests/*.test.mjs"], true),
        "extension" => super::extension::test_extension(&[]),
        "protocol" => super::protocol::test_protocol(),
        "security" => {
            super::supply::audit_js()?;
            Ok(())
        }
        _ => Err(format!("unknown lane {lane}")),
    }
}

pub fn test_all() -> Result<(), String> {
    super::test_cmd::run(&[])?;
    super::wasm::run_node_harness()?;
    super::browser::run_e2e()?;
    super::extension::test_extension_integration()
}

pub fn test_live(args: &[String]) -> Result<(), String> {
    super::live::test_live(args)
}

/// Deterministic release-inputs checksum (standalone diagnostic).
///
/// `cargo xtask ci digest` prints the sha256 over the exact files the
/// release plan and verification read (Rust lockfile, release inventory,
/// generated capabilities, fixture manifest), each framed by its relative
/// path so renames change the digest. CI and `release` do not consume it:
/// the release workflow gates on a successful CI run for the exact source
/// sha instead (`.github/workflows/release.yml`), which already pins these
/// committed inputs. The command stays useful for manually comparing
/// release inputs across checkouts; `--check` verifies a recorded value.
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

#[cfg(test)]
mod tests {
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
