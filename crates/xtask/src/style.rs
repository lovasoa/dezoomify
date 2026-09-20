//! `cargo xtask check`: repository-wide prose hygiene.
//!
//! Em dashes (U+2014) are forbidden in every tracked source, doc, and
//! generated file. The codebase communicates ranges and connectors with the
//! en dash (U+2013) and reads prose in ordinary words, so an em dash is
//! always a slip rather than intent. This scan is the single enforcement
//! point: it runs in `check` and the `check` CI lane.
//!
//! The scan deliberately skips the read-only evidence trees where imported
//! history must stay byte-identical: `migration-sources/` and `testdata/`
//! (their contents are captured verbatim from upstream and locked by SHA256).
//! It also skips binary files, which may legitimately contain the U+2014 byte
//! sequence.

use std::path::Path;
use std::process::Command;

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let root = super::repo_root();
    let offenders = scan(&root)?;
    if offenders.is_empty() {
        println!("style: no em dashes");
        return Ok(());
    }
    Err(format!(
        "em dash (U+2014) is forbidden; found in: {}",
        offenders.join(", ")
    ))
}

fn scan(base: &Path) -> Result<Vec<String>, String> {
    // Git owns the source inventory and ignored build directories. Include
    // new source files before staging, but never inspect generated bundles.
    let output = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(base)
        .output()
        .map_err(|e| format!("cannot list repository sources: {e}"))?;
    if !output.status.success() {
        return Err("cannot list repository sources with git ls-files".into());
    }
    let mut found = Vec::new();
    for name in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = std::str::from_utf8(name).map_err(|_| "non-utf8 source path")?;
        if name.starts_with("migration-sources/") || name.starts_with("testdata/") {
            continue;
        }
        let path = base.join(name);
        // A tracked file may have been deleted in the working tree. Do not
        // follow symlinks outside the repository or descend into submodules.
        let metadata = match path.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("cannot inspect {name}: {error}")),
        };
        if !metadata.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {name}: {e}"))?;
        if std::str::from_utf8(&bytes).is_err() {
            // Binary files (e.g. the committed wasm glue) may legitimately
            // contain the U+2014 byte sequence; only text files are policed.
            continue;
        }
        if bytes.windows(3).any(|w| w == "\u{2014}".as_bytes()) {
            found.push(name.to_owned());
        }
    }
    found.sort();
    found.dedup();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::scan;
    use std::fs;
    use std::path::PathBuf;

    fn temp_tree(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xtask-emdash-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).expect("create temp tree");
        assert!(std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&dir)
            .status()
            .unwrap()
            .success());
        dir
    }

    #[test]
    fn scan_flags_a_clean_file_as_clean() {
        let base = temp_tree("clean");
        fs::write(base.join("clean.txt"), "plain ascii prose only\n").unwrap();
        assert!(scan(&base).unwrap().is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_rejects_an_em_dash() {
        let base = temp_tree("reject");
        fs::write(base.join("sub/bad.txt"), "uses an em dash: \u{2014}\n").unwrap();
        let offenders = scan(&base).unwrap();
        assert_eq!(offenders, vec!["sub/bad.txt".to_string()]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_skips_evidence_and_build_output_dirs() {
        let base = temp_tree("skip");
        fs::write(base.join(".gitignore"), "target/\n.output/\n").unwrap();
        for dir in ["target", ".output", "migration-sources", "testdata"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        fs::write(base.join("target/t.txt"), "target \u{2014}\n").unwrap();
        fs::write(base.join(".output/bundle.js"), "bundle \u{2014}\n").unwrap();
        fs::write(base.join("migration-sources/m.txt"), "migration \u{2014}\n").unwrap();
        fs::write(base.join("testdata/t.txt"), "testdata \u{2014}\n").unwrap();
        fs::write(base.join("kept.txt"), "kept \u{2014}\n").unwrap();
        assert_eq!(scan(&base).unwrap(), vec!["kept.txt"]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn scan_skips_binary_files() {
        let base = temp_tree("binary");
        // A real binary: invalid UTF-8 (0xff) that also happens to contain the
        // U+2014 byte sequence, exactly like the committed wasm glue.
        fs::write(base.join("glue.wasm"), [0x00, 0xff, 0xe2, 0x80, 0x94]).unwrap();
        assert!(scan(&base).unwrap().is_empty());
        fs::remove_dir_all(&base).unwrap();
    }
}
