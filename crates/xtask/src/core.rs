//! `cargo xtask test core [--purity|--parity]`: phase-04 core target.
//! Bare target runs all fast core suites. `--purity` and `--parity` select
//! their owning integration-test targets.

pub fn run(args: &[String]) -> Result<(), String> {
    let mut purity = false;
    let mut parity = false;
    for arg in args {
        match arg.as_str() {
            "--purity" => purity = true,
            "--parity" => parity = true,
            other => {
                return Err(format!(
                    "unknown test core option '{other}' (only --purity|--parity)"
                ));
            }
        }
    }
    if purity && parity {
        return Err("test core accepts at most one of --purity|--parity".to_string());
    }
    if purity {
        return purity_only();
    }
    if parity {
        return parity_only();
    }
    super::command::cargo_test(&["-p", "dezoomify"])
}

fn purity_only() -> Result<(), String> {
    super::command::cargo_test(&["-p", "dezoomify", "--test", "core_purity"])
}

fn parity_only() -> Result<(), String> {
    super::command::cargo_test(&["-p", "dezoomify", "--test", "core_parity"])
}
