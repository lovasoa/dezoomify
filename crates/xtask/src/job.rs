//! `cargo xtask test job [--transcripts]`: deterministic job-engine gate.
//! Bare target runs all crate tests. `--transcripts` focuses the workflows
//! that own transcript verification.

pub fn run(args: &[String]) -> Result<(), String> {
    if args.len() > 1 {
        return Err("usage: cargo xtask test job [--transcripts]".to_string());
    }
    if args.first().map(String::as_str) == Some("--transcripts") {
        return transcripts_only();
    }
    if !args.is_empty() {
        return Err(format!("unknown test job arg '{}'", args[0]));
    }
    super::command::cargo_test(&["-p", "dezoomify-engine"])
}

fn transcripts_only() -> Result<(), String> {
    super::command::cargo_test(&["-p", "dezoomify-engine", "--test", "workflows"])
}
