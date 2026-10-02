//! Focused core tests. Standard Clippy checks enforce Host boundaries.
pub fn run(args: &[String]) -> Result<(), String> {
    match args {
        [] => super::command::cargo_test(&["-p", "dezoomify"]),
        [flag] if flag == "--parity" => {
            super::command::cargo_test(&["-p", "dezoomify", "--test", "core_parity"])
        }
        _ => Err("usage: cargo xtask test core [--parity]".to_string()),
    }
}
