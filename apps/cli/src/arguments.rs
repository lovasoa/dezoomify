//! Stable CLI argument parsing (manual; no new deps). stdout carries
//! machine JSON only with `--json`; human progress goes to stderr.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub input: Option<String>,
    pub output: Option<PathBuf>,
    pub overwrite: bool,
    pub json: bool,
    /// Format selector, `auto` detects. Named formats need native support.
    pub dezoomer: String,
    /// Select the largest level. Maps to uncapped width for native.
    pub largest: bool,
    pub max_width: Option<u32>,
    /// Height cap. Parsed here; native selection is width-only (gap).
    pub max_height: Option<u32>,
    /// Exact level index, 0 is smallest, out-of-range uses last.
    /// Parsed here; native selection is automatic (gap).
    pub zoom_level: Option<usize>,
    pub accept_invalid_certs: bool,
    /// Trusted user headers (`-H "Name: value"` / `--header`), last wins.
    pub headers: BTreeMap<String, String>,
    /// 0-based image selection when several are found. Parsed here; the
    /// native driver currently resolves the first catalog entry (gap).
    pub image_index: Option<usize>,
    /// Tile retry budget. Overrides the native default of 3. Zero is
    /// accepted here; the job engine clamps to at least 1 (gap).
    pub retries: u32,
    /// Delay before the first retry, then doubling. Parsed here;
    /// the job engine owns retry timing (gap).
    pub retry_delay: Duration,
    /// Output compression, 0 is less, 100 is more. Parsed here;
    /// native encodes JPEG at fixed quality 92 (gap).
    pub compression: u8,
    /// Max idle connections per host. Parsed here; native owns pooling (gap).
    pub max_idle_per_host: usize,
    /// Minimum delay between requests. Parsed here (see `parse_duration`);
    /// per-tile throttling needs native support (gap); bulk runs delay
    /// between images.
    pub min_interval: Duration,
    /// Max time for one request. Parsed here; native uses 60s (gap).
    pub timeout: Duration,
    /// Max time to connect. Parsed here; native uses 15s (gap).
    pub connect_timeout: Duration,
    /// Log verbosity, e.g. `info` or `debug`. Parsed here; the CLI reports
    /// through human lines on stderr plus `--json` on stdout (gap).
    pub logging: String,
    /// Degree of parallelism. Parsed here; native runs 6 concurrent
    /// tile fetches (gap).
    pub parallelism: usize,
    /// Resume folder wired to native `cache_dir`.
    pub tile_cache: Option<PathBuf>,
    /// Bulk source: local text-list file or URL (including IIIF collection
    /// manifests, best-effort). When present, one output per entry.
    pub bulk: Option<String>,
}

impl Args {
    #[must_use]
    pub fn is_bulk_mode(&self) -> bool {
        self.bulk.is_some()
    }

    #[must_use]
    pub fn output_file(&self) -> Option<PathBuf> {
        self.output.clone()
    }

    #[must_use]
    pub fn bulk_output_file(&self) -> Option<PathBuf> {
        self.output_file()
    }

    /// Default `Referer` is the bulk source or input URI when it is http(s),
    /// mirroring the reference client default. Sent only when the user did
    /// not pass an explicit `Referer` header.
    #[must_use]
    pub fn request_referer(&self) -> Option<&str> {
        let candidate = if self.is_bulk_mode() {
            self.bulk.as_deref()
        } else {
            self.input.as_deref()
        };
        candidate.filter(|uri| uri.starts_with("http://") || uri.starts_with("https://"))
    }

    /// Largest wins explicitly, or implicitly in bulk mode when no level
    /// cap was given. Mirrors the reference `should_use_largest`.
    #[must_use]
    pub fn should_use_largest(&self) -> bool {
        self.largest || (self.is_bulk_mode() && !self.has_level_specifying_args())
    }

    #[must_use]
    pub fn has_level_specifying_args(&self) -> bool {
        self.max_width.is_some() || self.max_height.is_some() || self.zoom_level.is_some()
    }
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut input: Option<String> = None;
    let mut positional_output: Option<PathBuf> = None;
    let mut outfile_option: Option<PathBuf> = None;
    let mut overwrite = false;
    let mut json = false;
    let mut dezoomer = "auto".to_string();
    let mut largest = false;
    let mut max_width = None;
    let mut max_height = None;
    let mut zoom_level: Option<usize> = None;
    let mut accept_invalid_certs = false;
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut image_index: Option<usize> = None;
    let mut retries: u32 = 3;
    let mut retry_delay = Duration::from_secs(2);
    let mut compression: u8 = 5;
    let mut max_idle_per_host: usize = 32;
    let mut min_interval = Duration::ZERO;
    let mut timeout = Duration::from_secs(30);
    let mut connect_timeout = Duration::from_secs(6);
    let mut logging = "info".to_string();
    let mut parallelism: usize = 16;
    let mut tile_cache: Option<PathBuf> = None;
    let mut bulk: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let (flag, inline_value) = split_flag_value(&args[i]);
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
            "--dezoomer" | "-d" => {
                let raw = take_value(args, &mut i, inline_value, "--dezoomer")?;
                if raw.is_empty() {
                    return Err("missing value for --dezoomer".to_string());
                }
                dezoomer = raw;
            }
            "--largest" | "-l" => {
                reject_inline_value(flag, inline_value)?;
                largest = true;
            }
            "--max-width" | "-w" => {
                let raw = take_value(args, &mut i, inline_value, "--max-width")?;
                let width: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --max-width value: {raw}"))?;
                if width == 0 {
                    return Err("--max-width must be positive".to_string());
                }
                max_width = Some(width);
            }
            "--max-height" => {
                let raw = take_value(args, &mut i, inline_value, "--max-height")?;
                let height: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --max-height value: {raw}"))?;
                if height == 0 {
                    return Err("--max-height must be positive".to_string());
                }
                max_height = Some(height);
            }
            "-h" => {
                // Old `-h` was `--max-height`; new bare `-h` is help.
                // `-h <px>` (or `-h<px>`) sets the height cap, bare `-h`
                // shows help. Documented in help and user docs.
                if let Some(inline) = inline_value {
                    if inline.is_empty() {
                        return Err("missing value for --max-height".to_string());
                    }
                    let height: u32 = inline
                        .parse()
                        .map_err(|_| format!("invalid --max-height value: {inline}"))?;
                    if height == 0 {
                        return Err("--max-height must be positive".to_string());
                    }
                    max_height = Some(height);
                } else if let Some(next) = args.get(i + 1) {
                    let trimmed = next.trim();
                    if let Ok(height) = trimmed.parse::<u32>() {
                        if height > 0 {
                            i += 1;
                            max_height = Some(height);
                        } else {
                            return Err("--max-height must be positive".to_string());
                        }
                    } else {
                        return Err(help());
                    }
                } else {
                    return Err(help());
                }
            }
            "--zoom-level" => {
                let raw = take_value(args, &mut i, inline_value, "--zoom-level")?;
                let level: usize = raw
                    .parse()
                    .map_err(|_| format!("invalid --zoom-level value: {raw}"))?;
                zoom_level = Some(level);
            }
            "--parallelism" | "-n" => {
                let raw = take_value(args, &mut i, inline_value, "--parallelism")?;
                let value: usize = raw
                    .parse()
                    .map_err(|_| "parallelism must be a positive integer".to_string())?;
                if value == 0 {
                    return Err("parallelism must be a positive integer".to_string());
                }
                parallelism = value;
            }
            "--image-index" => {
                let raw = take_value(args, &mut i, inline_value, "--image-index")?;
                let index: usize = raw
                    .parse()
                    .map_err(|_| format!("invalid --image-index value: {raw}"))?;
                image_index = Some(index);
            }
            "--retries" | "-r" => {
                let raw = take_value(args, &mut i, inline_value, "--retries")?;
                let count: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --retries value: {raw}"))?;
                retries = count;
            }
            "--retry-delay" => {
                let raw = take_value(args, &mut i, inline_value, "--retry-delay")?;
                retry_delay =
                    parse_duration(&raw).map_err(|e| format!("invalid --retry-delay: {e}"))?;
            }
            "--compression" => {
                let raw = take_value(args, &mut i, inline_value, "--compression")?;
                let value: u8 = raw
                    .parse()
                    .map_err(|_| format!("invalid --compression value: {raw}"))?;
                compression = value;
            }
            "--max-idle-per-host" => {
                let raw = take_value(args, &mut i, inline_value, "--max-idle-per-host")?;
                let value: usize = raw
                    .parse()
                    .map_err(|_| format!("invalid --max-idle-per-host value: {raw}"))?;
                max_idle_per_host = value;
            }
            "--min-interval" | "-i" => {
                let raw = take_value(args, &mut i, inline_value, "--min-interval")?;
                min_interval =
                    parse_duration(&raw).map_err(|e| format!("invalid --min-interval: {e}"))?;
            }
            "--timeout" => {
                let raw = take_value(args, &mut i, inline_value, "--timeout")?;
                timeout = parse_duration(&raw).map_err(|e| format!("invalid --timeout: {e}"))?;
            }
            "--connect-timeout" => {
                let raw = take_value(args, &mut i, inline_value, "--connect-timeout")?;
                connect_timeout =
                    parse_duration(&raw).map_err(|e| format!("invalid --connect-timeout: {e}"))?;
            }
            "--logging" => {
                let raw = take_value(args, &mut i, inline_value, "--logging")?;
                if raw.is_empty() {
                    return Err("missing value for --logging".to_string());
                }
                logging = raw;
            }
            "--tile-cache" | "-c" => {
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
            "--bulk" => {
                let raw = take_value(args, &mut i, inline_value, "--bulk")?;
                if raw.is_empty() {
                    return Err("missing value for --bulk".to_string());
                }
                if bulk.is_some() {
                    return Err("duplicate --bulk".to_string());
                }
                bulk = Some(raw);
            }
            "--help" | "-?" => return Err(help()),
            "--version" | "-V" => {
                return Err(format!("dezoomify-cli {}", env!("CARGO_PKG_VERSION")));
            }
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
    let output = outfile_option.or(positional_output);
    // Single mode allows a missing output for title-based auto-naming;
    // a missing input prompts when a terminal is present, else prints help.
    // Bulk mode already allows missing positionals.
    Ok(Args {
        input,
        output,
        overwrite,
        json,
        dezoomer,
        largest,
        max_width,
        max_height,
        zoom_level,
        accept_invalid_certs,
        headers,
        image_index,
        retries,
        retry_delay,
        compression,
        max_idle_per_host,
        min_interval,
        timeout,
        connect_timeout,
        logging,
        parallelism,
        tile_cache,
        bulk,
    })
}

fn split_flag_value(arg: &str) -> (&str, Option<String>) {
    if let Some((flag, value)) = arg.split_once('=') {
        if flag.starts_with("--") && flag.len() > 2 {
            return (flag, Some(value.to_string()));
        }
        if flag.len() == 2 && flag.starts_with('-') && !flag.starts_with("--") {
            return (flag, Some(value.to_string()));
        }
    }
    if arg.len() > 2 && arg.starts_with('-') && !arg.starts_with("--") {
        let short = &arg[..2];
        if matches!(short, "-d" | "-w" | "-n" | "-r" | "-i" | "-c" | "-h" | "-H") {
            let rest = &arg[2..];
            if !rest.is_empty() {
                let value = rest.strip_prefix('=').unwrap_or(rest);
                return (short, Some(value.to_string()));
            }
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

/// Output name for bulk entry `index` (0-based) from a base file.
/// `base_1.ext`, `base_2.ext`, …; extensionless bases gain `_<n>`.
#[must_use]
pub fn generate_bulk_output_name(base: &std::path::Path, index: usize) -> PathBuf {
    let mut result = base.to_path_buf();
    let suffix = format!("_{}", index + 1);
    if let Some(stem) = base.file_stem().and_then(|s| s.to_str()) {
        if let Some(ext) = base.extension().and_then(|e| e.to_str()) {
            result.set_file_name(format!("{stem}{suffix}.{ext}"));
        } else {
            result.set_file_name(format!("{stem}{suffix}"));
        }
    } else {
        result.set_file_name(format!("dezoomified{suffix}.png"));
    }
    result
}

fn help() -> String {
    [
        "usage: dezoomify-cli [options] <input-url> <output>",
        "  or: dezoomify-cli --bulk <file-or-url> [--outfile <file>] [options]",
        "  or: dezoomify-cli with no arguments prompts when a terminal is present",
        "options:",
        "  --overwrite                 overwrite an existing output file",
        "  --json                      print machine-readable JSON events on stdout",
        "  -d, --dezoomer <name>       format to use, or auto to detect (default auto)",
        "  -l, --largest               select the largest level (highest resolution)",
        "  -w, --max-width <px>        largest level whose width fits (positive integer)",
        "  --max-height <px>           largest level whose height fits (positive integer)",
        "                              (-h <px> also sets height; bare -h shows help)",
        "  --zoom-level <n>            select level by index, 0 is smallest, too large uses last",
        "  -n, --parallelism <n>       max concurrent tile downloads (default 16)",
        "  -r, --retries <n>           tile retry budget, 0 means no retries (default 3)",
        "  --retry-delay <duration>    delay before first retry, then doubling (default 2s)",
        "  --compression <0-100>       output compression, 0 is less, 100 is more (default 5)",
        "  -H, --header \"Name: value\"  HTTP header for tile requests (repeatable, last wins)",
        "  --max-idle-per-host <n>     max idle connections per host (default 32)",
        "  --accept-invalid-certs      accept insecure TLS certificates (insecure)",
        "  -i, --min-interval <duration> minimum delay between requests, e.g. 50ms, 2s (default 0)",
        "                              (bulk paces images; single needs native support)",
        "  --timeout <duration>        max time for one request (default 30s)",
        "  --connect-timeout <duration> max time to connect (default 6s)",
        "  --logging <level>           log verbosity, e.g. info, debug (default info)",
        "  -c, --tile-cache <dir>      resume folder reusing downloaded tiles",
        "  --bulk <file-or-url>        text list file (URL plus optional title per line, # comments)",
        "                              or IIIF collection manifest URL; saves one output per entry",
        "  --outfile <file>            explicit output file, or bulk base name (bulk_1.ext, …)",
        "  -h, --help, -?              show this help (use -h <px> or --max-height for height cap)",
        "  -V, --version               show version",
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
        assert_eq!(args.input.as_deref(), Some("https://example.com/x.dzi"));
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
        assert_eq!(args.output, Some(PathBuf::from("explicit.png")));
        assert_eq!(args.input.as_deref(), Some("https://example.com/x.dzi"));
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

    #[test]
    fn bulk_mode_needs_no_positionals() {
        let args = parse(&[
            "--bulk".to_string(),
            "list.txt".to_string(),
            "--outfile".to_string(),
            "base.png".to_string(),
        ])
        .expect("bulk parse");
        assert!(args.is_bulk_mode());
        assert_eq!(args.bulk.as_deref(), Some("list.txt"));
        assert_eq!(args.bulk_output_file(), Some(PathBuf::from("base.png")));
        assert_eq!(args.input, None);
    }

    #[test]
    fn bulk_output_uses_second_positional_when_no_outfile_flag() {
        let args = parse(&[
            "--bulk".to_string(),
            "list.txt".to_string(),
            "ignored-input".to_string(),
            "positional-base.png".to_string(),
        ])
        .expect("bulk parse");
        assert_eq!(
            args.bulk_output_file(),
            Some(PathBuf::from("positional-base.png"))
        );
    }

    #[test]
    fn bulk_single_positional_yields_no_base_name() {
        let args = parse(&["--bulk".to_string(), "list.txt".to_string()]).expect("bulk parse");
        assert_eq!(args.bulk_output_file(), None);
    }

    #[test]
    fn bulk_output_names_gain_an_index_suffix() {
        assert_eq!(
            generate_bulk_output_name(std::path::Path::new("collection.jpg"), 0),
            PathBuf::from("collection_1.jpg")
        );
        assert_eq!(
            generate_bulk_output_name(std::path::Path::new("collection.jpg"), 9),
            PathBuf::from("collection_10.jpg")
        );
        assert_eq!(
            generate_bulk_output_name(std::path::Path::new("out"), 0),
            PathBuf::from("out_1")
        );
    }

    #[test]
    fn parses_dezoomer_largest_height_zoom_parallelism() {
        let args = parse(&[
            "-d".to_string(),
            "iiif".to_string(),
            "-l".to_string(),
            "--max-height".to_string(),
            "800".to_string(),
            "--zoom-level".to_string(),
            "2".to_string(),
            "-n".to_string(),
            "8".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("parse new selection flags");
        assert_eq!(args.dezoomer, "iiif");
        assert!(args.largest);
        assert_eq!(args.max_height, Some(800));
        assert_eq!(args.zoom_level, Some(2));
        assert_eq!(args.parallelism, 8);
        assert!(args.should_use_largest());
        assert!(args.has_level_specifying_args());
    }

    #[test]
    fn short_aliases_match_long_flags() {
        let short = parse(&[
            "-w".to_string(),
            "300".to_string(),
            "-r".to_string(),
            "5".to_string(),
            "-i".to_string(),
            "50ms".to_string(),
            "-c".to_string(),
            "cache-dir".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("short flags");
        let long = parse(&[
            "--max-width".to_string(),
            "300".to_string(),
            "--retries".to_string(),
            "5".to_string(),
            "--min-interval".to_string(),
            "50ms".to_string(),
            "--tile-cache".to_string(),
            "cache-dir".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("long flags");
        assert_eq!(short.max_width, long.max_width);
        assert_eq!(short.retries, long.retries);
        assert_eq!(short.min_interval, long.min_interval);
        assert_eq!(short.tile_cache, long.tile_cache);
    }

    #[test]
    fn dash_h_with_value_sets_max_height() {
        let args = parse(&[
            "-h".to_string(),
            "800".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("parse -h value");
        assert_eq!(args.max_height, Some(800));
    }

    #[test]
    fn dash_h_attached_sets_max_height() {
        let args = parse(&[
            "-h800".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("parse -h800");
        assert_eq!(args.max_height, Some(800));
    }

    #[test]
    fn bare_dash_h_is_help() {
        let err = parse(&["-h".to_string()]).expect_err("bare -h is help");
        assert!(err.starts_with("usage:"), "help text: {err}");
    }

    #[test]
    fn question_mark_is_help_and_v_is_version() {
        let help = parse(&["-?".to_string()]).expect_err("help");
        assert!(help.starts_with("usage:"), "help text: {help}");
        let version = parse(&["-V".to_string()]).expect_err("version");
        assert!(version.starts_with("dezoomify-cli"), "version: {version}");
    }

    #[test]
    fn retries_zero_is_accepted() {
        let args = parse(&[
            "--retries".to_string(),
            "0".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("retries 0 parses");
        assert_eq!(args.retries, 0);
    }

    #[test]
    fn parallelism_rejects_zero() {
        let err = parse(&[
            "--parallelism".to_string(),
            "0".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect_err("parallelism 0 must fail");
        assert!(
            err.contains("parallelism must be a positive integer"),
            "message: {err}"
        );
    }

    #[test]
    fn parses_timing_compression_idle_logging_defaults() {
        let args = parse(&[
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("defaults");
        assert_eq!(args.retry_delay, Duration::from_secs(2));
        assert_eq!(args.compression, 5);
        assert_eq!(args.max_idle_per_host, 32);
        assert_eq!(args.timeout, Duration::from_secs(30));
        assert_eq!(args.connect_timeout, Duration::from_secs(6));
        assert_eq!(args.logging, "info");
        assert_eq!(args.parallelism, 16);
        assert_eq!(args.dezoomer, "auto");
        assert!(!args.largest);
        assert_eq!(args.max_height, None);
        assert_eq!(args.zoom_level, None);
        let timed = parse(&[
            "--retry-delay".to_string(),
            "500ms".to_string(),
            "--compression".to_string(),
            "9".to_string(),
            "--max-idle-per-host".to_string(),
            "8".to_string(),
            "--timeout".to_string(),
            "10s".to_string(),
            "--connect-timeout".to_string(),
            "3s".to_string(),
            "--logging".to_string(),
            "debug".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("timing flags");
        assert_eq!(timed.retry_delay, Duration::from_millis(500));
        assert_eq!(timed.compression, 9);
        assert_eq!(timed.max_idle_per_host, 8);
        assert_eq!(timed.timeout, Duration::from_secs(10));
        assert_eq!(timed.connect_timeout, Duration::from_secs(3));
        assert_eq!(timed.logging, "debug");
    }

    #[test]
    fn request_referer_prefers_http_sources() {
        let single = parse(&[
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("single");
        assert_eq!(single.request_referer(), Some("https://example.com/x.dzi"));
        let bulk = parse(&[
            "--bulk".to_string(),
            "https://example.com/manifest.json".to_string(),
        ])
        .expect("bulk");
        assert_eq!(
            bulk.request_referer(),
            Some("https://example.com/manifest.json")
        );
        let local_bulk =
            parse(&["--bulk".to_string(), "list.txt".to_string()]).expect("local bulk");
        assert_eq!(local_bulk.request_referer(), None);
    }

    #[test]
    fn single_output_may_be_omitted_for_auto_naming() {
        let args = parse(&["https://example.com/x.dzi".to_string()]).expect("output optional");
        assert_eq!(args.input.as_deref(), Some("https://example.com/x.dzi"));
        assert_eq!(args.output, None);
        assert_eq!(args.bulk_output_file(), None);
    }
}
