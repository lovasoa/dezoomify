//! CLI entry point: argument parsing, real download pipeline, honest events.

mod arguments;
mod report;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use arguments::Args;
use dezoomify_native::http::{FetchLimits, TlsPolicy};
use dezoomify_native::pipeline::{PipelineConfig, PipelineEvent};
use dezoomify_native::{pipeline, JobEvent, JobRequest, NativeRuntime};

/// Minimum-interval pacing between bulk images. Ports the reference
/// `Throttler` idea synchronously: per-tile throttling still needs native
/// support, so single-image runs apply no delay.
struct Throttler {
    last: Option<Instant>,
    min_interval: Duration,
}

impl Throttler {
    fn new(min_interval: Duration) -> Self {
        Self {
            last: None,
            min_interval,
        }
    }

    fn wait(&mut self) {
        if self.min_interval.is_zero() {
            self.last = Some(Instant::now());
            return;
        }
        if let Some(last) = self.last {
            let next = last + self.min_interval;
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
        }
        self.last = Some(Instant::now());
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match arguments::parse(&args) {
        Ok(parsed) => parsed,
        Err(message) => {
            if message.starts_with("usage:") || message.starts_with("dezoomify-cli") {
                println!("{message}");
                std::process::exit(0);
            }
            eprintln!("error: {message}");
            std::process::exit(2);
        }
    };
    if parsed.is_bulk_mode() {
        run_bulk(parsed);
        return;
    }
    let (input, output) = match (parsed.input.clone(), parsed.output.clone()) {
        (Some(input), Some(output)) => (input, output),
        _ => match prompt_interactive() {
            Some((input, output)) => (input, output),
            None => {
                // No TTY: print help to stdout, exit 0 (existing contract).
                println!("{}", help_text());
                std::process::exit(0);
            }
        },
    };
    let parsed = Args {
        input: Some(input.clone()),
        output: Some(output.clone()),
        ..parsed
    };
    run_single(parsed, &input, &output);
}

fn help_text() -> String {
    match arguments::parse(&["--help".to_string()]) {
        Err(help) => help,
        Ok(_) => "usage: dezoomify-cli [options] <input-url> <output>".to_string(),
    }
}

/// Prompt for input/output when a terminal is present. Returns `None` when
/// stdin is not a TTY (caller prints help) or on EOF.
fn prompt_interactive() -> Option<(String, PathBuf)> {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        return None;
    }
    let input = prompt_line("Enter an URL or a path to a tiles.yaml file: ")?;
    if input.trim().is_empty() {
        eprintln!("error: no input given");
        std::process::exit(2);
    }
    let output = prompt_line("Enter the output file: ")?;
    if output.trim().is_empty() {
        eprintln!("error: no output given");
        std::process::exit(2);
    }
    Some((input.trim().to_string(), PathBuf::from(output.trim())))
}

fn prompt_line(prompt: &str) -> Option<String> {
    use std::io::Write as _;
    let _ = std::io::stderr().write_all(prompt.as_bytes());
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(0) => None,
        Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
        Err(_) => None,
    }
}

fn pipeline_config_for(parsed: &Args) -> PipelineConfig {
    let mut user_headers = parsed.headers.clone();
    if let Some(referer) = parsed.request_referer() {
        if !user_headers.contains_key("referer") {
            user_headers.insert("referer".to_string(), referer.to_string());
        }
    }
    // `--largest` (or bulk-implied largest) selects the uncapped level,
    // mirroring the reference `should_use_largest` rule.
    let max_width = if parsed.should_use_largest() {
        None
    } else {
        parsed.max_width
    };
    PipelineConfig {
        user_headers,
        max_width,
        max_retries: parsed.retries,
        cache_dir: parsed.tile_cache.clone(),
        fetch: FetchLimits {
            tls: TlsPolicy {
                accept_invalid_certs: parsed.accept_invalid_certs,
            },
            ..FetchLimits::default()
        },
        ..PipelineConfig::default()
    }
}

fn warn_selection_gaps(parsed: &Args) {
    if parsed.dezoomer != "auto" {
        eprintln!(
            "warning: --dezoomer {} is parsed but named formats need native support; auto-detecting instead",
            parsed.dezoomer
        );
    }
    if let Some(height) = parsed.max_height {
        eprintln!(
            "warning: --max-height {height} is parsed but level selection is width-only in native; ignoring the height cap"
        );
    }
    if let Some(level) = parsed.zoom_level {
        eprintln!(
            "warning: --zoom-level {level} is parsed but exact level selection needs native support; saving the automatic level"
        );
    }
    if parsed.parallelism != 16 {
        eprintln!(
            "warning: --parallelism {} is parsed but concurrency needs native support; continuing with 6 concurrent tile fetches",
            parsed.parallelism
        );
    }
    if parsed.retry_delay != std::time::Duration::from_secs(2) {
        eprintln!(
            "warning: --retry-delay is parsed but retry timing needs native support; continuing with engine defaults"
        );
    }
    if parsed.compression != 5 {
        eprintln!(
            "warning: --compression {} is parsed but quality control needs native support; encoding JPEG at quality 92",
            parsed.compression
        );
    }
    if parsed.max_idle_per_host != 32 {
        eprintln!(
            "warning: --max-idle-per-host {} is parsed but connection pooling needs native support; ignoring",
            parsed.max_idle_per_host
        );
    }
    if parsed.timeout != std::time::Duration::from_secs(30) {
        eprintln!(
            "warning: --timeout is parsed but timeout tuning needs native support; continuing with a 60s timeout"
        );
    }
    if parsed.connect_timeout != std::time::Duration::from_secs(6) {
        eprintln!(
            "warning: --connect-timeout is parsed but timeout tuning needs native support; continuing with a 15s connect timeout"
        );
    }
    if parsed.logging != "info" {
        eprintln!(
            "warning: --logging {} is parsed but verbosity control needs native support; reporting through human lines plus --json",
            parsed.logging
        );
    }
    if parsed.retries == 0 {
        eprintln!(
            "warning: --retries 0 is parsed but the job engine clamps to at least 1 retry; continuing with 1"
        );
    }
    if let Some(index) = parsed.image_index {
        if index != 0 {
            eprintln!(
                "warning: --image-index {index} is parsed but the native driver currently resolves the first catalog entry; saving the first image"
            );
        }
    }
    if !parsed.min_interval.is_zero() && !parsed.is_bulk_mode() {
        eprintln!(
            "warning: --min-interval is parsed but per-tile throttling needs native support; continuing without delay"
        );
    }
}

fn run_single(parsed: Args, input: &str, output: &Path) {
    warn_selection_gaps(&parsed);
    let runtime = NativeRuntime::new(1 << 30);
    let output_str = output.to_string_lossy().into_owned();
    let mut handle = match runtime.start(JobRequest {
        input_url: input.to_string(),
        output_path: output_str.clone(),
        overwrite: parsed.overwrite,
    }) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("error: {} ({})", error.message, error.code);
            std::process::exit(1);
        }
    };
    handle.emit("started");
    print_event(parsed.json, handle.events().last().expect("started event"));

    let config = pipeline_config_for(&parsed);
    let json = parsed.json;
    let result = pipeline::run(
        input,
        &output_str,
        parsed.overwrite,
        &config,
        &mut |event: PipelineEvent| {
            handle.emit_detail(&event.kind, event.detail.clone());
            if let Some(last) = handle.events().last() {
                print_event(json, last);
            }
        },
    );
    match result {
        Ok(outcome) => {
            let result = handle.finish(outcome.output_hash.clone());
            if json {
                println!(
                    "{}",
                    report::machine_completed(
                        &handle.id,
                        handle.seq(),
                        &outcome.output_hash,
                        &outcome.format,
                        outcome.image_size.x,
                        outcome.image_size.y,
                        outcome.tile_count,
                    )
                );
            } else {
                eprintln!(
                    "saved {} ({} tiles, {}x{}) {}",
                    outcome.output_path.display(),
                    outcome.tile_count,
                    outcome.image_size.x,
                    outcome.image_size.y,
                    outcome.output_hash,
                );
            }
            drop(result);
        }
        Err(error) => {
            eprintln!("error: {} ({})", error.message, error.code);
            std::process::exit(1);
        }
    }
}

fn run_bulk(parsed: Args) {
    warn_selection_gaps(&parsed);
    let bulk_arg = parsed.bulk.clone().unwrap_or_default();
    let entries = match load_bulk_entries(&bulk_arg, &parsed.headers, parsed.accept_invalid_certs) {
        Ok(entries) => entries,
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
    };
    if entries.is_empty() {
        eprintln!("error: no urls found in bulk file {bulk_arg}");
        std::process::exit(1);
    }
    let base = parsed.bulk_output_file();
    let mut throttler = Throttler::new(parsed.min_interval);
    let mut items: Vec<report::BulkItem> = Vec::new();
    let mut first = true;
    for (index, (url, title)) in entries.iter().enumerate() {
        if !first {
            throttler.wait();
        }
        first = false;
        let output = bulk_output_for(base.as_deref(), title.as_deref(), index);
        let output_str = output.to_string_lossy().into_owned();
        let outcome = run_one_bulk_image(&parsed, url, &output_str);
        match outcome {
            Ok((hash, _tiles)) => {
                let item = report::BulkItem::ok(index, url, &output_str, &hash);
                if parsed.json {
                    println!("{}", report::machine_bulk_item(&item));
                } else {
                    eprintln!("saved {output_str} from {url} ({hash})");
                }
                items.push(item);
            }
            Err((code, message)) => {
                let item = report::BulkItem::failed(index, url, &output_str, &code, &message);
                if parsed.json {
                    println!("{}", report::machine_bulk_item(&item));
                } else {
                    eprintln!("failed {url} -> {output_str}: {code}: {message}");
                }
                items.push(item);
            }
        }
    }
    let succeeded = items.iter().filter(|i| i.status == "ok").count();
    let failed = items.len().saturating_sub(succeeded);
    if parsed.json {
        println!(
            "{}",
            report::machine_bulk_summary(items.len(), succeeded, failed)
        );
    } else {
        eprintln!(
            "{}",
            report::human_bulk_summary(items.len(), succeeded, failed)
        );
    }
    if failed > 0 {
        std::process::exit(1);
    }
}

fn bulk_output_for(base: Option<&Path>, title: Option<&str>, index: usize) -> PathBuf {
    if let Some(base) = base {
        return arguments::generate_bulk_output_name(base, index);
    }
    if let Some(title) = title {
        let clean = sanitize_title(title);
        if !clean.is_empty() {
            return PathBuf::from(format!("{clean}.png"));
        }
    }
    PathBuf::from(format!("dezoomified_{}.png", index + 1))
}

fn sanitize_title(title: &str) -> String {
    let dashed = title.replace(": ", " - ");
    let mut clean = String::new();
    for ch in dashed.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' || ch == ':' {
            clean.push('_');
        } else {
            clean.push(ch);
        }
    }
    clean.trim().to_string()
}

fn run_one_bulk_image(
    parsed: &Args,
    url: &str,
    output: &str,
) -> Result<(String, usize), (String, String)> {
    let runtime = NativeRuntime::new(1 << 30);
    let mut handle = match runtime.start(JobRequest {
        input_url: url.to_string(),
        output_path: output.to_string(),
        overwrite: parsed.overwrite,
    }) {
        Ok(handle) => handle,
        Err(error) => return Err((error.code, error.message)),
    };
    handle.emit("started");
    // Bulk progress stays human on stderr; machine mode emits only
    // bulk-item lines on stdout, so event details never pollute JSON.
    if !parsed.json {
        if let Some(last) = handle.events().last() {
            print_event(false, last);
        }
    }
    let config = pipeline_config_for(parsed);
    let mut events: Vec<PipelineEvent> = Vec::new();
    let result = pipeline::run(
        url,
        output,
        parsed.overwrite,
        &config,
        &mut |event: PipelineEvent| {
            events.push(event.clone());
            handle.emit_detail(&event.kind, event.detail.clone());
            if !parsed.json {
                if let Some(last) = handle.events().last() {
                    print_event(false, last);
                }
            }
        },
    );
    match result {
        Ok(outcome) => {
            let _ = handle.finish(outcome.output_hash.clone());
            Ok((outcome.output_hash, outcome.tile_count))
        }
        Err(error) => Err((error.code, error.message)),
    }
}

fn parse_text_list(content: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let uri = parts.next().unwrap_or_default().trim();
        if uri.is_empty() {
            continue;
        }
        let title = parts
            .next()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        out.push((uri.to_string(), title));
    }
    out
}

fn load_bulk_entries(
    bulk_arg: &str,
    headers: &BTreeMap<String, String>,
    accept_invalid_certs: bool,
) -> Result<Vec<(String, Option<String>)>, String> {
    let path = Path::new(bulk_arg);
    if path.is_file() {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("cannot read bulk file: {e}"))?;
        // A JSON bulk file is a IIIF collection manifest saved to disk.
        if let Some(entries) = extract_iiif_collection_urls(&content, Some(bulk_arg)) {
            return Ok(entries);
        }
        return Ok(parse_text_list(&content));
    }
    if bulk_arg.starts_with("http://") || bulk_arg.starts_with("https://") {
        let body = fetch_bulk_url(bulk_arg, headers, accept_invalid_certs)?;
        if let Some(entries) = extract_iiif_collection_urls(&body, Some(bulk_arg)) {
            return Ok(entries);
        }
        let listed = parse_text_list(&body);
        if !listed.is_empty() {
            return Ok(listed);
        }
        // Single IIIF image manifest URL: one entry (the URL itself).
        if body.trim_start().starts_with('{') {
            return Ok(vec![(bulk_arg.to_string(), None)]);
        }
        return Ok(listed);
    }
    Err(format!("bulk file not found: {bulk_arg}"))
}

fn fetch_bulk_url(
    url: &str,
    headers: &BTreeMap<String, String>,
    accept_invalid_certs: bool,
) -> Result<String, String> {
    use dezoomify_native::http::{fetch, FetchLimits, TlsPolicy, UserHeaders};
    let origin_host = url::parse_host(url);
    let user = UserHeaders::new(headers.clone(), origin_host);
    let limits = FetchLimits {
        tls: TlsPolicy {
            accept_invalid_certs,
        },
        ..FetchLimits::default()
    };
    let outcome =
        fetch(url, &BTreeMap::new(), Some(&user), None, &limits).map_err(|e| e.message.clone())?;
    if !(200..300).contains(&outcome.status) {
        return Err(format!(
            "bulk fetch failed with http status {}",
            outcome.status
        ));
    }
    String::from_utf8(outcome.body).map_err(|e| format!("bulk response is not text: {e}"))
}

/// Best-effort IIIF collection extraction: `manifests`/`members`/`items`
/// object entries with `id`/`@id` plus an optional label. Returns `None`
/// when the text is not JSON or holds no collection entries.
fn extract_iiif_collection_urls(
    text: &str,
    fallback_single: Option<&str>,
) -> Option<Vec<(String, Option<String>)>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    for key in ["manifests", "members", "items", "collections"] {
        if let Some(list) = obj.get(key).and_then(|v| v.as_array()) {
            let mut out = Vec::new();
            for entry in list {
                let Some(map) = entry.as_object() else {
                    continue;
                };
                let id = map
                    .get("id")
                    .or_else(|| map.get("@id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if id.is_empty() || !looks_like_url(id) {
                    continue;
                }
                let title = iiif_label(map.get("label"));
                out.push((id.to_string(), title));
            }
            if !out.is_empty() {
                return Some(out);
            }
        }
    }
    // Single manifest object: keep the source URL as the single entry so
    // `--bulk <manifest-url>` still saves its first image honestly.
    let kind = obj
        .get("@type")
        .or_else(|| obj.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if kind.contains("manifest") || kind.contains("collection") {
        if let Some(single) = fallback_single {
            let title = iiif_label(obj.get("label"));
            return Some(vec![(single.to_string(), title)]);
        }
    }
    None
}

fn iiif_label(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    if !s.trim().is_empty() {
                        return Some(s.trim().to_string());
                    }
                } else if let Some(map) = item.as_object() {
                    for lang in ["en", "@value", "value"] {
                        if let Some(s) = map.get(lang).and_then(|v| v.as_str()) {
                            if !s.trim().is_empty() {
                                return Some(s.trim().to_string());
                            }
                        }
                    }
                }
            }
            None
        }
        serde_json::Value::Object(map) => {
            for lang in ["en", "@value", "value", "none"] {
                if let Some(list) = map.get(lang) {
                    if let Some(found) = iiif_label(Some(list)) {
                        return Some(found);
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn looks_like_url(s: &str) -> bool {
    s.starts_with("http://")
        || s.starts_with("https://")
        || s.contains("://")
        || s.contains('.')
        || s.contains('/')
}

// Small host helper without a new dependency: only the origin host is
// needed to scope credential headers for the bulk-list fetch.
mod url {
    pub fn parse_host(uri: &str) -> Option<String> {
        let after_scheme = uri.split_once("://")?.1;
        let host = after_scheme
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        let host = host.rsplit('@').next().unwrap_or(host);
        let host = host.split(':').next().unwrap_or(host);
        if host.is_empty() {
            None
        } else {
            Some(host.to_string())
        }
    }
}

fn print_event(json: bool, event: &JobEvent) {
    if json {
        println!(
            "{}",
            report::machine_event_detail(&event.job, event.seq, event.kind.as_str(), &event.detail)
        );
    } else {
        let detail = event
            .detail
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(" ");
        if detail.is_empty() {
            eprintln!("{} {}", event.kind, event.job);
        } else {
            eprintln!("{} {} {}", event.kind, event.job, detail);
        }
    }
}
