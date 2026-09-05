//! `cargo xtask check`: repository-wide prose hygiene.
//!
//! Em dashes (U+2014) are forbidden in every tracked source, doc, and
//! generated file. The codebase communicates ranges and connectors with the
//! en dash (U+2013) and reads prose in ordinary words, so an em dash is
//! always a slip rather than intent. This scan is the single enforcement
//! point: it runs in `check` (and therefore `cargo xtask test`) and in the
//! `rust` CI lane.
//!
//! The scan deliberately skips the read-only evidence trees where imported
//! history must stay byte-identical: `migration-sources/` and `testdata/`
//! (their contents are captured verbatim from upstream and locked by SHA256).
//! It also skips binary files, which may legitimately contain the U+2014 byte
//! sequence.

use std::path::Path;

/// Relative directory names that are never scanned.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    "dist",
    "artifacts",
    "target-wasm",
    "wasm-package",
    // Read-only imported evidence: never edited, never scanned.
    "migration-sources",
    "testdata",
];

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let root = super::repo_root();
    let offenders = scan(&root, &root)?;
    if offenders.is_empty() {
        println!("style: no em dashes");
        return Ok(());
    }
    Err(format!(
        "em dash (U+2014) is forbidden; found in: {}",
        offenders.join(", ")
    ))
}

fn scan(base: &Path, dir: &Path) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<_> = entries
        .map(|e| e.map_err(|e| format!("dir entry: {e}")))
        .collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if SKIP_DIRS.contains(&name) {
                    continue;
                }
            }
            found.extend(scan(base, &path)?);
            continue;
        }
        let bytes =
            std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if std::str::from_utf8(&bytes).is_err() {
            // Binary files (e.g. the committed wasm glue) may legitimately
            // contain the U+2014 byte sequence; only text files are policed.
            continue;
        }
        if bytes.windows(3).any(|w| w == "\u{2014}".as_bytes()) {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip prefix: {e}"))?
                .to_str()
                .ok_or("non-utf8 path")?
                .to_string();
            found.push(rel);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::{scan, SKIP_DIRS};
    use std::fs;
    use std::path::PathBuf;

    fn temp_tree(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xtask-emdash-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).expect("create temp tree");
        dir
    }

    #[test]
    fn scan_flags_a_clean_file_as_clean() {
        let base = temp_tree("clean");
        fs::write(base.join("clean.txt"), "plain ascii prose only\n").unwrap();
        assert!(scan(&base, &base).unwrap().is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_rejects_an_em_dash() {
        let base = temp_tree("reject");
        fs::write(base.join("sub/bad.txt"), "uses an em dash: \u{2014}\n").unwrap();
        let offenders = scan(&base, &base).unwrap();
        assert_eq!(offenders, vec!["sub/bad.txt".to_string()]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_skips_evidence_and_build_output_dirs() {
        let base = temp_tree("skip");
        for dir in ["target", "migration-sources", "testdata"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        fs::write(base.join("target/t.txt"), "target \u{2014}\n").unwrap();
        fs::write(base.join("migration-sources/m.txt"), "migration \u{2014}\n").unwrap();
        fs::write(base.join("testdata/t.txt"), "testdata \u{2014}\n").unwrap();
        fs::write(base.join("kept.txt"), "kept \u{2014}\n").unwrap();
        assert_eq!(scan(&base, &base).unwrap(), vec!["kept.txt"]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_skips_binary_files() {
        let base = temp_tree("binary");
        // A real binary: invalid UTF-8 (0xff) that also happens to contain the
        // U+2014 byte sequence, exactly like the committed wasm glue.
        fs::write(base.join("glue.wasm"), [0x00, 0xff, 0xe2, 0x80, 0x94]).unwrap();
        assert!(scan(&base, &base).unwrap().is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn repo_is_free_of_em_dashes() {
        // The whole-point guard: the workspace must cleanly pass.
        assert!(
            super::verify(&[]).is_ok(),
            "repo must contain no em dashes (U+2014); run `cargo xtask check` for the list"
        );
    }

    #[test]
    fn skip_dirs_cover_evidence_and_build_output() {
        for dir in [
            ".git",
            "target",
            "node_modules",
            "migration-sources",
            "testdata",
        ] {
            assert!(SKIP_DIRS.contains(&dir), "must skip {dir}");
        }
    }
}
