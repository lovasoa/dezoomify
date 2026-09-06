//! Stable CLI argument parsing (manual; no new deps). stdout carries
//! machine JSON only with `--json`; human progress goes to stderr.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub input: String,
    pub output: PathBuf,
    pub overwrite: bool,
    pub json: bool,
    pub max_width: Option<u32>,
    pub accept_invalid_certs: bool,
    /// Trusted user headers (`-H "Name: value"` / `--header`), last wins.
    pub headers: BTreeMap<String, String>,
    /// 0-based image selection when several are found. Parsed here; the
    /// native driver currently resolves the first catalog entry (gap).
    pub image_index: Option<usize>,
    /// Tile retry budget. Overrides the native default of 3.
    pub retries: u32,
    /// Minimum delay between requests. Parsed here (see `parse_duration`);
    /// per-tile throttling needs native support (gap), so single-image runs
    /// currently apply no delay.
    pub min_interval: Duration,
    /// Resume folder wired to native `cache_dir`.
    pub tile_cache: Option<PathBuf>,
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut input: Option<String> = None;
    let mut positional_output: Option<PathBuf> = None;
    let mut outfile_option: Option<PathBuf> = None;
    let mut overwrite = false;
    let mut json = false;
    let mut max_width = None;
    let mut accept_invalid_certs = false;
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut image_index: Option<usize> = None;
    let mut retries: u32 = 3;
    let mut min_interval = Duration::ZERO;
    let mut tile_cache: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        let (flag, inline_value) = split_inline_value(&args[i]);
        match flag {
            "--overwrite" => {
                reject_inline_value(flag, inline_value)?;
                overwrite = true;
            }
            "--accept-invalid-certs" => {
                reject_inline_value(flag, inline_value)?;
                accept_invalid_certs = true;
            }
            "--json" => {
                reject_inline_value(flag, inline_value)?;
                json = true;
            }
            "--max-width" => {
                let raw = take_value(args, &mut i, inline_value, "--max-width")?;
                let width: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --max-width value: {raw}"))?;
                if width == 0 {
                    return Err("--max-width must be positive".to_string());
                }
                max_width = Some(width);
            }
            "--image-index" => {
                let raw = take_value(args, &mut i, inline_value, "--image-index")?;
                let index: usize = raw
                    .parse()
                    .map_err(|_| format!("invalid --image-index value: {raw}"))?;
                image_index = Some(index);
            }
            "--retries" => {
                let raw = take_value(args, &mut i, inline_value, "--retries")?;
                let count: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --retries value: {raw}"))?;
                retries = count;
            }
            "--min-interval" => {
                let raw = take_value(args, &mut i, inline_value, "--min-interval")?;
                min_interval =
                    parse_duration(&raw).map_err(|e| format!("invalid --min-interval: {e}"))?;
            }
            "--tile-cache" => {
                let raw = take_value(args, &mut i, inline_value, "--tile-cache")?;
                if raw.is_empty() {
                    return Err("missing value for --tile-cache".to_string());
                }
                tile_cache = Some(PathBuf::from(raw));
            }
            "--outfile" => {
                let raw = take_value(args, &mut i, inline_value, "--outfile")?;
                if raw.is_empty() {
                    return Err("missing value for --outfile".to_string());
                }
                if outfile_option.is_some() {
                    return Err("duplicate --outfile".to_string());
                }
                outfile_option = Some(PathBuf::from(raw));
            }
            "--help" | "-h" => return Err(help()),
            "--version" => return Err(format!("dezoomify-cli {}", env!("CARGO_PKG_VERSION"))),
            "-H" | "--header" => {
                let raw = take_value(args, &mut i, inline_value, flag)?;
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
                if inline_value.is_some() {
                    return Err(format!("unknown flag {positional}"));
                }
                if input.is_none() {
                    input = Some(positional.to_string());
                } else if positional_output.is_none() {
                    positional_output = Some(PathBuf::from(positional));
                } else {
                    return Err("too many positional arguments".to_string());
                }
            }
        }
        i += 1;
    }
    if outfile_option.is_some() && positional_output.is_some() {
        return Err("--outfile conflicts with positional <output>".to_string());
    }
    Ok(Args {
        input: input.ok_or_else(help)?,
        output: outfile_option.or(positional_output).ok_or_else(help)?,
        overwrite,
        json,
        max_width,
        accept_invalid_certs,
        headers,
        image_index,
        retries,
        min_interval,
        tile_cache,
    })
}

fn split_inline_value(arg: &str) -> (&str, Option<String>) {
    if let Some((flag, value)) = arg.split_once('=') {
        if flag.starts_with("--") && flag.len() > 2 {
            return (flag, Some(value.to_string()));
        }
    }
    (arg, None)
}

fn reject_inline_value(flag: &str, inline: Option<String>) -> Result<(), String> {
    if inline.is_some() {
        return Err(format!("{flag} takes no value"));
    }
    Ok(())
}

fn take_value(
    args: &[String],
    i: &mut usize,
    inline: Option<String>,
    flag: &str,
) -> Result<String, String> {
    if let Some(value) = inline {
        if value.is_empty() {
            return Err(format!("missing value for {flag}"));
        }
        return Ok(value);
    }
    *i += 1;
    args.get(*i)
        .cloned()
        .ok_or_else(|| format!("missing value for {flag}"))
}

/// Parse durations like `50ms`, `2s`, `1min`, `1m`, `1h`, `100ns`.
/// Bare `0` means no delay. Mirrors the reference `parse_duration`.
pub fn parse_duration(s: &str) -> Result<Duration, String> {
    let trimmed = s.trim();
    if trimmed == "0" {
        return Ok(Duration::ZERO);
    }
    let digits = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return Err(format!(
            "invalid duration '{s}': expected a number followed by ns, ms, s, min, m, or h"
        ));
    }
    let value: u64 = digits
        .parse()
        .map_err(|_| format!("invalid duration '{s}'"))?;
    let unit = trimmed[digits.len()..].trim();
    match unit {
        "ns" => Ok(Duration::from_nanos(value)),
        "ms" => Ok(Duration::from_millis(value)),
        "s" => Ok(Duration::from_secs(value)),
        "min" | "m" => Ok(Duration::from_secs(value.saturating_mul(60))),
        "h" => Ok(Duration::from_secs(value.saturating_mul(3600))),
        _ => Err(format!(
            "invalid duration '{s}': expected a number followed by ns, ms, s, min, m, or h"
        )),
    }
}

fn help() -> String {
    [
        "usage: dezoomify-cli [options] <input-url> <output>",
        "options:",
        "  --overwrite                 overwrite an existing output file",
        "  --json                      print machine-readable JSON events on stdout",
        "  --max-width <px>            largest level whose width fits (positive integer)",
        "  --accept-invalid-certs      accept insecure TLS certificates (insecure)",
        "  -H, --header \"Name: value\"  HTTP header for tile requests (repeatable, last wins)",
        "  --image-index <n>           pick the nth image when several are found (0-based)",
        "  --retries <n>               tile retry budget (default 3)",
        "  --min-interval <duration>   minimum delay between requests, e.g. 50ms, 2s (default 0)",
        "  --tile-cache <dir>          resume folder reusing downloaded tiles",
        "  --outfile <file>            explicit output file (alternative to positional <output>)",
        "  -h, --help                  show this help",
        "  --version                   show version",
    ]
    .join("\n")
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

    #[test]
    fn header_alias_matches_short_flag() {
        let short = parse(&[
            "-H".to_string(),
            "Referer: https://example.test/viewer".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("short flag");
        let long = parse(&[
            "--header".to_string(),
            "Referer: https://example.test/viewer".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("long flag");
        assert_eq!(short.headers, long.headers);
        assert_eq!(
            long.headers.get("referer").map(String::as_str),
            Some("https://example.test/viewer")
        );
    }

    #[test]
    fn parses_selection_retry_throttle_cache_and_outfile() {
        let args = parse(&[
            "--image-index".to_string(),
            "2".to_string(),
            "--retries".to_string(),
            "5".to_string(),
            "--min-interval".to_string(),
            "200ms".to_string(),
            "--tile-cache".to_string(),
            "cache-dir".to_string(),
            "--outfile".to_string(),
            "explicit.png".to_string(),
            "https://example.com/x.dzi".to_string(),
        ])
        .expect("parse");
        assert_eq!(args.image_index, Some(2));
        assert_eq!(args.retries, 5);
        assert_eq!(args.min_interval, Duration::from_millis(200));
        assert_eq!(args.tile_cache, Some(PathBuf::from("cache-dir")));
        assert_eq!(args.output, PathBuf::from("explicit.png"));
        assert_eq!(args.input, "https://example.com/x.dzi");
    }

    #[test]
    fn outfile_conflicts_with_positional_output() {
        let err = parse(&[
            "https://example.com/x.dzi".to_string(),
            "positional.png".to_string(),
            "--outfile".to_string(),
            "explicit.png".to_string(),
        ])
        .expect_err("conflict must fail");
        assert!(err.contains("--outfile"), "conflict message: {err}");
    }

    #[test]
    fn supports_inline_values() {
        let args = parse(&[
            "--max-width=300".to_string(),
            "--retries=5".to_string(),
            "--min-interval=2s".to_string(),
            "--image-index=1".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("inline values");
        assert_eq!(args.max_width, Some(300));
        assert_eq!(args.retries, 5);
        assert_eq!(args.min_interval, Duration::from_secs(2));
        assert_eq!(args.image_index, Some(1));
    }

    #[test]
    fn parse_duration_units() {
        assert_eq!(parse_duration("0"), Ok(Duration::ZERO));
        assert_eq!(parse_duration("50ms"), Ok(Duration::from_millis(50)));
        assert_eq!(parse_duration("2s"), Ok(Duration::from_secs(2)));
        assert_eq!(parse_duration("29 s"), Ok(Duration::from_secs(29)));
        assert_eq!(parse_duration("2min"), Ok(Duration::from_secs(120)));
        assert_eq!(parse_duration("1m"), Ok(Duration::from_secs(60)));
        assert_eq!(parse_duration("1h"), Ok(Duration::from_secs(3600)));
        assert_eq!(parse_duration("100ns"), Ok(Duration::from_nanos(100)));
        assert!(parse_duration("").is_err());
        assert!(parse_duration("ms").is_err());
        assert!(parse_duration("1j").is_err());
        assert!(parse_duration("1 2 ms").is_err());
    }

    #[test]
    fn retries_default_is_three() {
        let args = parse(&[
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("parse");
        assert_eq!(args.retries, 3);
        assert_eq!(args.min_interval, Duration::ZERO);
        assert_eq!(args.image_index, None);
        assert_eq!(args.tile_cache, None);
    }
}
