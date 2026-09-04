//! `cargo xtask sources verify`: lock/prefix verification from phase-00 lock.
//! No fetching; any missing binary, malformed lock, absent object, or mismatch
//! returns nonzero with stable source-name-sorted output.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Lock {
    schema_version: u32,
    sources: Vec<Source>,
}

#[derive(Debug, Deserialize)]
struct Source {
    name: String,
    commit: String,
    tree: String,
    prefix: Option<String>,
    must_equal_prefix: bool,
}

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask sources verify (no options)".to_string());
    }
    let root = super::repo_root();
    let text = std::fs::read_to_string(root.join("docs/migration/source-lock.json"))
        .map_err(|e| format!("cannot read source-lock.json: {e}"))?;
    let lock: Lock =
        serde_json::from_str(&text).map_err(|e| format!("malformed source-lock.json: {e}"))?;
    if lock.schema_version != 1 {
        return Err(format!(
            "unsupported source-lock schema_version {}",
            lock.schema_version
        ));
    }
    let mut sources = lock.sources;
    sources.sort_by(|a, b| a.name.cmp(&b.name));
    for s in &sources {
        if s.commit.len() != 40 || s.tree.len() != 40 {
            return Err(format!("source '{}' has malformed SHAs", s.name));
        }
        super::run_git(&["cat-file", "-e", &format!("{}^{{commit}}", s.commit)]).map_err(|_| {
            format!(
                "source '{}': commit {} absent (no fetch performed)",
                s.name, s.commit
            )
        })?;
        let actual_tree = super::run_git(&["rev-parse", &format!("{}^{{tree}}", s.commit)])?;
        if actual_tree != s.tree {
            return Err(format!(
                "source '{}': tree mismatch (lock {} != object {})",
                s.name, s.tree, actual_tree
            ));
        }
        if s.must_equal_prefix {
            let prefix = s
                .prefix
                .as_deref()
                .ok_or_else(|| format!("source '{}' requires a prefix", s.name))?;
            let status = std::process::Command::new("git")
                .args(["diff", "--quiet", &s.commit, &format!("HEAD:{prefix}")])
                .current_dir(super::repo_root())
                .status()
                .map_err(|e| format!("failed to run git: {e}"))?;
            if !status.success() {
                return Err(format!(
                    "source '{}': prefix {prefix} differs from {}",
                    s.name, s.commit
                ));
            }
        }
        println!("source {} ok ({})", s.name, &s.commit[..7]);
    }
    println!("sources verify: {} sources ok", sources.len());
    Ok(())
}
