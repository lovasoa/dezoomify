//! Stable CLI argument parsing (manual; no new deps). stdout carries
//! machine JSON only with `--json`; human progress goes to stderr.

use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub input: String,
    pub output: PathBuf,
    pub overwrite: bool,
    pub json: bool,
    /// Trusted user headers (`-H "Name: value"`), last occurrence wins.
    pub headers: BTreeMap<String, String>,
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut input: Option<String> = None;
    let mut output: Option<PathBuf> = None;
    let mut overwrite = false;
    let mut json = false;
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--overwrite" => overwrite = true,
            "--json" => json = true,
            "--help" | "-h" => return Err(help()),
            "--version" => return Err("dezoomify-cli 1.0.0".to_string()),
            "-H" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| "missing value for -H".to_string())?;
                let (name, value) = raw
                    .split_once(':')
                    .ok_or_else(|| format!("invalid header (expected \"Name: value\"): {raw}"))?;
                let name = name.trim().to_ascii_lowercase();
                if name.is_empty() {
                    return Err("invalid header: empty name".to_string());
                }
                headers.insert(name, value.trim().to_string());
            }
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
        headers,
    })
}

fn help() -> String {
    "usage: dezoomify-cli [--overwrite] [--json] [-H \"Name: value\"] <input-url> <output>"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers() {
        let args = parse(&[
            "-H".to_string(),
            "Cookie: js_enabled=2".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("parse");
        assert_eq!(
            args.headers.get("cookie").map(String::as_str),
            Some("js_enabled=2")
        );
        assert_eq!(args.input, "https://example.com/x.dzi");
    }
}
