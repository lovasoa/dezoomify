fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/generated.json");
    println!("cargo:rerun-if-changed=build.rs");
    // The real window shell needs the Tauri build step to resolve
    // capabilities and embed assets; the lean shell keeps the offline stub.
    #[cfg(feature = "tauri")]
    tauri_build::build();
}
