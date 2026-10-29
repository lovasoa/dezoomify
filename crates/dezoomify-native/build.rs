use std::{env, path::Path, process::Command};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for input in [
        "build.rs",
        "viewer",
        "../../scripts/build-iiif-viewer.mjs",
        "../../pnpm-lock.yaml",
    ] {
        println!("cargo:rerun-if-changed={input}");
    }
    for package in ["esbuild", "openseadragon"] {
        let manifest = root.join("node_modules").join(package).join("package.json");
        assert!(
            manifest.is_file(),
            "workspace dependency `{package}` is missing; run `pnpm install --frozen-lockfile` from the repository root"
        );
    }
    let status = Command::new("node")
        .arg(root.join("scripts/build-iiif-viewer.mjs"))
        .arg(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"))
        .current_dir(root)
        .status()
        .expect("IIIF viewer needs Node; run cargo xtask setup first");
    assert!(
        status.success(),
        "IIIF viewer build failed; run cargo xtask setup to install workspace dependencies"
    );
}
