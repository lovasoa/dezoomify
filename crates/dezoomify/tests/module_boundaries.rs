//! Source-level dependency-direction checks for the consolidated pure crate.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("read source directory") {
        let path = entry.expect("source entry").path();
        if path.is_dir() {
            rust_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

#[test]
fn model_never_depends_on_formats_or_engine() {
    let source = fs::read_to_string("src/model.rs").expect("read canonical model");
    for forbidden in [
        "crate::engine",
        "crate::core",
        "crate::arcgis",
        "crate::iiif",
    ] {
        assert!(
            !source.contains(forbidden),
            "canonical model must point inward and cannot import `{forbidden}`"
        );
    }
}

#[test]
fn formats_never_depend_on_engine() {
    let root = Path::new("src");
    let mut files = Vec::new();
    rust_files(root, &mut files);
    for path in files {
        if path.starts_with(root.join("engine")) || path == root.join("model.rs") {
            continue;
        }
        let source = fs::read_to_string(&path).expect("read Rust source");
        assert!(
            !source.contains("crate::engine"),
            "format/model source {} must not import engine state",
            path.display()
        );
    }
}

#[test]
fn engine_uses_the_shared_tile_program_contract() {
    let source = fs::read_to_string("src/engine/job.rs").expect("read job engine");
    assert!(
        !source.contains("TileSource::"),
        "the engine must start tile work through TileProgramStart, not concrete source variants"
    );
}

#[test]
fn every_rust_source_is_in_the_module_tree() {
    let root = Path::new("src");
    let mut all = Vec::new();
    rust_files(root, &mut all);
    let all: BTreeSet<_> = all.into_iter().collect();
    let mut reachable = BTreeSet::new();
    let mut pending = vec![root.join("lib.rs")];

    while let Some(path) = pending.pop() {
        assert!(
            all.contains(&path),
            "missing module source: {}",
            path.display()
        );
        if !reachable.insert(path.clone()) {
            continue;
        }
        let source = fs::read_to_string(&path).expect("read module source");
        let module_dir = if matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("lib.rs" | "mod.rs")
        ) {
            path.parent().expect("module has a parent").to_path_buf()
        } else {
            path.with_extension("")
        };
        for line in source.lines().map(str::trim) {
            let declaration = line
                .strip_prefix("pub(crate) mod ")
                .or_else(|| line.strip_prefix("pub(super) mod "))
                .or_else(|| line.strip_prefix("pub mod "))
                .or_else(|| line.strip_prefix("mod "));
            let Some(name) = declaration.and_then(|value| value.strip_suffix(';')) else {
                continue;
            };
            let file = module_dir.join(format!("{name}.rs"));
            let nested = module_dir.join(name).join("mod.rs");
            pending.push(if file.exists() { file } else { nested });
        }
    }

    assert_eq!(reachable, all, "Rust source is unreachable from lib.rs");
}
