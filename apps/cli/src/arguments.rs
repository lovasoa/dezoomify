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
    /// Format selector, `auto` detects. Named formats are validated
    /// CLI-side against the known format list; unknown names fail.
    /// Wired to native `format` (`None`/`auto` auto-detects, named selects
    /// the single program, unknown fails typed).
    pub dezoomer: String,
    /// Select the largest level. Maps to uncapped width plus the native
    /// largest flag (bulk-implied when no level cap was given).
    pub largest: bool,
    pub max_width: Option<u32>,
    /// Height cap, wired to native `max_height` (largest fitting area wins).
    pub max_height: Option<u32>,
    /// Exact level index, 0 is smallest, out-of-range uses last.
    /// Wired to native `zoom_level`; wins over largest and size caps.
    pub zoom_level: Option<usize>,
    pub accept_invalid_certs: bool,
    /// Trusted user headers (`-H "Name: value"` / `--header`), last wins.
    pub headers: BTreeMap<String, String>,
    /// 0-based image selection when several are found, wired to native
    /// `image_index`; out-of-range uses the last image.
    pub image_index: Option<usize>,
    /// Tile retry budget, wired to native `max_retries`. Zero means no
    /// retries and is passed through unchanged.
    pub retries: u32,
    /// Delay before the first retry, then doubling. Wired to native
    /// `retry_delay` (plus deterministic per-tile jitter).
    pub retry_delay: Duration,
    /// Output compression, 0 is less, 100 is more. Wired to native
    /// `compression`: JPEG quality is `100 - compression`, PNG tiers map
    /// 0-19 fast, 20-60 balanced, above high.
    pub compression: u8,
    /// Max idle connections per host, wired to native fetch limits.
    pub max_idle_per_host: usize,
    /// Minimum delay between requests (see `parse_duration`). Wired to
    /// native per-tile staggering; bulk runs also pace images.
    pub min_interval: Duration,
    /// Max time for one request, wired to native fetch `timeout`.
    pub timeout: Duration,
    /// Max time to connect, wired to native fetch `connect_timeout`.
    pub connect_timeout: Duration,
    /// Log verbosity: error, warn, info, debug, trace (default info).
    /// Controls human stderr verbosity; `--json` stdout is unchanged.
    pub logging: String,
    /// Degree of parallelism, wired to native `max_concurrent`.
    pub parallelism: usize,
    /// Resume folder wired to native `cache_dir`.
    pub tile_cache: Option<PathBuf>,
    /// Bulk source: local text-list file or URL (including IIIF collection
    /// manifests, best-effort). When present, one output per entry.
    pub bulk: Option<String>,
    /// Partial output policy: keep a partial image with blank regions when
    /// some tiles fail after retries (default, reference `PartialDownload`
    /// file behavior), published to a `.partial` sibling (`out.png` becomes
    /// `out.partial.png`) so it never masquerades as a complete save.
    /// `--no-partial` discards instead with
    /// `tile.download-failed` and no output. `--keep-partial` is the
    /// explicit opt-in spelling of the default; last flag wins.
    pub keep_partial: bool,
    /// Pause v1 demonstration: pause the engine after this many tiles are
    /// acquired (suspend new scheduling, finish in-flight, retain decoded),
    /// then resume and complete. Wired to native `pause_after`. `None`
    /// disables the demonstration.
    pub pause_after: Option<usize>,
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
    let mut keep_partial = true;
    let mut pause_after: Option<usize> = None;
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
            "--keep-partial" => {
                reject_inline_value(flag, inline_value)?;
                keep_partial = true;
            }
            "--no-partial" => {
                reject_inline_value(flag, inline_value)?;
                keep_partial = false;
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
            "--max-height" | "-h" => {
                let raw = take_value(args, &mut i, inline_value, "--max-height")?;
                let height: u32 = raw
                    .parse()
                    .map_err(|_| format!("invalid --max-height value: {raw}"))?;
                if height == 0 {
                    return Err("--max-height must be positive".to_string());
                }
                max_height = Some(height);
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
                logging = validate_logging(&raw)?;
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
            "--pause-after" => {
                let raw = take_value(args, &mut i, inline_value, "--pause-after")?;
                let count: usize = raw
                    .parse()
                    .map_err(|_| format!("invalid --pause-after value: {raw}"))?;
                if pause_after.is_some() {
                    return Err("duplicate --pause-after".to_string());
                }
                pause_after = Some(count);
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
    validate_dezoomer(&dezoomer)?;
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
        keep_partial,
        pause_after,
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

/// Known `--dezoomer` format names, mirroring the core registry order
/// (`dezoomify-core/src/core/registry.rs` snapshot). `auto` is the
/// pseudo-name for automatic detection and is always accepted.
#[must_use]
pub fn known_dezoomers() -> &'static [&'static str] {
    &[
        "custom",
        "google_arts_and_culture",
        "zoomify",
        "iiif",
        "deepzoom",
        "generic",
        "krpano",
        "iipimage",
        "xlimage",
        "topviewer",
        "fsi",
        "lizardtech",
        "vls",
        "hungaricana",
        "wmts",
        "arcgis",
        "pnav",
        "bulk_text",
    ]
}

/// Validate a `--dezoomer` value: `auto` or a known format (case-insensitive,
/// matching the core `registry_for`). Unknown names fail with a typed error
/// listing the expected values; they are rejected outright rather than
/// silently using auto-detection.
fn validate_dezoomer(name: &str) -> Result<(), String> {
    if name == "auto" {
        return Ok(());
    }
    if known_dezoomers()
        .iter()
        .any(|known| known.eq_ignore_ascii_case(name))
    {
        return Ok(());
    }
    Err(format!(
        "unknown dezoomer '{name}' (expected one of: auto, {})",
        known_dezoomers().join(", ")
    ))
}

/// Validate a `--logging` value and normalize to lowercase.
/// Real levels mirror the reference `init_log` verbosity: error, warn, info,
/// debug, trace (case-insensitive). Unknown values fail with a typed error.
fn validate_logging(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "error" | "warn" | "info" | "debug" | "trace" => Ok(normalized),
        _ => Err(format!(
            "invalid --logging value: {raw} (expected one of: error, warn, info, debug, trace)"
        )),
    }
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
        result.set_file_name(format!("dezoomify{suffix}.png"));
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
        "  -h, --max-height <px>       largest level whose height fits (positive integer)",
        "  --zoom-level <n>            select level by index, 0 is smallest, too large uses last",
        "  --image-index <n>           select image by index, 0 is first, too large uses last",
        "  --pause-after <n>           pause after n tiles, then resume (Pause v1 demo)",
        "  -n, --parallelism <n>       max concurrent tile downloads (default 16)",
        "  -r, --retries <n>           tile retry budget, 0 means no retries (default 3)",
        "  --retry-delay <duration>    delay before first retry, then doubling (default 2s)",
        "  --compression <0-100>       output compression, 0 is less, 100 is more (default 5)",
        "  -H, --header \"Name: value\"  HTTP header for tile requests (repeatable, last wins)",
        "  --max-idle-per-host <n>     max idle connections per host (default 32)",
        "  --accept-invalid-certs      accept insecure TLS certificates (insecure)",
        "  -i, --min-interval <duration> minimum delay between requests, e.g. 50ms, 2s (default 0)",
        "                              (bulk paces images; per-tile requests are staggered)",
        "  --timeout <duration>        max time for one request (default 30s)",
        "  --connect-timeout <duration> max time to connect (default 6s)",
        "  --logging <level>           log verbosity: error, warn, info, debug, trace (default info)",
        "  -c, --tile-cache <dir>      resume folder reusing downloaded tiles",
        "  --keep-partial              keep partial output with blank regions on tile failure (default,",
        "                              saved to a .partial sibling: out.png becomes out.partial.png)",
        "  --no-partial                discard partial output on tile failure (fail with no output)",
        "  --bulk <file-or-url>        text list file (URL plus optional title per line, # comments)",
        "                              or IIIF collection manifest URL; saves one output per entry",
        "  --outfile <file>            explicit output file (.png, .jpg, .jpeg, .tif, .tiff, .zif, .webp, .iiif,",
        "                              or extensionless iiif-dir), or bulk base name (bulk_1.ext, …)",
        "  -?, --help                  show this help",
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
    fn unknown_dezoomer_fails_with_typed_error() {
        let err = parse(&[
            "--dezoomer".to_string(),
            "nope".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect_err("unknown dezoomer must fail");
        assert!(
            err.contains("unknown dezoomer 'nope'"),
            "typed error: {err}"
        );
        assert!(err.contains("auto"), "lists auto: {err}");
        let ok = parse(&[
            "--dezoomer".to_string(),
            "IIIF".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("known names validate case-insensitively");
        assert_eq!(ok.dezoomer, "IIIF");
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
    fn bare_dash_h_needs_a_value() {
        let err = parse(&["-h".to_string()]).expect_err("bare -h needs a value");
        assert!(
            err.contains("missing value for --max-height"),
            "height value required: {err}"
        );
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
    fn logging_accepts_real_levels_and_rejects_unknown() {
        for level in ["error", "warn", "info", "debug", "trace", "DEBUG"] {
            let args = parse(&[
                "--logging".to_string(),
                level.to_string(),
                "https://example.com/x.dzi".to_string(),
                "out.png".to_string(),
            ])
            .expect("level parses");
            assert!(
                ["error", "warn", "info", "debug", "trace"].contains(&args.logging.as_str()),
                "normalized level: {}",
                args.logging
            );
        }
        let err = parse(&[
            "--logging".to_string(),
            "verbose".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect_err("unknown level must fail");
        assert!(
            err.contains("invalid --logging value"),
            "typed error: {err}"
        );
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

    #[test]
    fn pause_after_parses_and_rejects_bad_values() {
        let args = parse(&[
            "--pause-after".to_string(),
            "2".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("pause-after parses");
        assert_eq!(args.pause_after, Some(2));
        let inline = parse(&[
            "--pause-after=0".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("inline pause-after parses");
        assert_eq!(inline.pause_after, Some(0));
        let err = parse(&[
            "--pause-after".to_string(),
            "nope".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect_err("bad pause-after must fail");
        assert!(err.contains("invalid --pause-after"), "typed error: {err}");
        let dup = parse(&[
            "--pause-after".to_string(),
            "1".to_string(),
            "--pause-after".to_string(),
            "2".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect_err("duplicate pause-after must fail");
        assert!(dup.contains("duplicate --pause-after"), "duplicate: {dup}");
        let defaults = parse(&[
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("defaults");
        assert_eq!(defaults.pause_after, None);
    }

    #[test]
    fn keep_partial_defaults_to_keep_and_last_flag_wins() {
        let args = parse(&[
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("defaults");
        assert!(args.keep_partial, "partial output is kept by default");
        let kept = parse(&[
            "--keep-partial".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("keep-partial parses");
        assert!(kept.keep_partial);
        let discarded = parse(&[
            "--no-partial".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("no-partial parses");
        assert!(!discarded.keep_partial);
        let last_wins = parse(&[
            "--no-partial".to_string(),
            "--keep-partial".to_string(),
            "https://example.com/x.dzi".to_string(),
            "out.png".to_string(),
        ])
        .expect("last flag wins");
        assert!(last_wins.keep_partial);
    }
}
