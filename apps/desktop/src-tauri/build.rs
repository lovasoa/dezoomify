fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/generated.json");
    println!("cargo:rerun-if-changed=build.rs");
}
