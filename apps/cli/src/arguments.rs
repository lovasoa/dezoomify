//! Stable CLI argument parsing (manual; no new deps). stdout carries
//! machine JSON only with `--json`; human progress goes to stderr.

use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub input: String,
    pub output: PathBuf,
    pub overwrite: bool,
    pub json: bool,
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut input: Option<String> = None;
    let mut output: Option<PathBuf> = None;
    let mut overwrite = false;
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--overwrite" => overwrite = true,
            "--json" => json = true,
            "--help" | "-h" => return Err(help()),
            "--version" => return Err("dezoomify-cli 1.0.0".to_string()),
            other if other.starts_with('-') => return Err(format!("unknown flag {other}")),
            positional => {
                if input.is_none() {
                    input = Some(positional.to_string());
                } else if output.is_none() {
                    output = Some(PathBuf::from(positional));
                } else {
                    return Err("too many positional arguments".to_string());
                }
            }
        }
        i += 1;
    }
    Ok(Args {
        input: input.ok_or_else(help)?,
        output: output.ok_or_else(help)?,
        overwrite,
        json,
    })
}

fn help() -> String {
    "usage: dezoomify-cli [--overwrite] [--json] <input-url> <output>".to_string()
}
