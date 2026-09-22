//! Source-level dependency-direction checks for the consolidated pure crate.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

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
