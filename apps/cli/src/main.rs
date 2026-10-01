//! CLI argument parsing, native Host configuration, and progress reporting.

// Failures map to stderr diagnostics and exit codes
// instead of panicking (see `dezoomify::model` for the shared contract policy).
#![deny(clippy::unwrap_used)]

mod arguments;
mod report;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use arguments::Args;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};

/// Minimum-interval pacing between bulk images.
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
    let has_args = !args.is_empty();
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
    if has_args {
        run_single_from_cli(parsed);
    } else {
        run_interactive_loop(parsed);
    }
}

fn help_text() -> String {
    match arguments::parse(&["--help".to_string()]) {
        Err(help) => help,
        Ok(_) => "usage: dezoomify-cli [options] <input-url> <output>".to_string(),
    }
}

/// One-shot single run for command-line invocation. Missing input prompts
/// once when a terminal is present, else prints help; missing output
/// auto-names from the fallback. Pickers prompt when no selector was given
/// and a terminal is present.
fn run_single_from_cli(parsed: Args) {
    let input = match parsed.input.clone() {
        Some(input) => input,
        None => match prompt_input() {
            Some(input) => input,
            None => {
                println!("{}", help_text());
                std::process::exit(0);
            }
        },
    };
    if input.trim().is_empty() {
        eprintln!("error: no input given");
        std::process::exit(2);
    }
    let output = match parsed.output.clone() {
        Some(output) => output,
        None => single_auto_output(),
    };
    let mut parsed = Args {
        input: Some(input.clone()),
        output: Some(output.clone()),
        ..parsed
    };
    if !apply_pickers(&mut parsed) {
        if report::show_warning(&parsed.logging) {
            eprintln!("warning: Reached end of input. Exiting...");
        }
        std::process::exit(0);
    }
    let ok = run_single_inner(&parsed, &input, &output);
    if !ok {
        std::process::exit(1);
    }
}

/// No-args terminal loop: repeat
/// prompts until EOF, continue after failures, exit 1 when any run failed.
fn run_interactive_loop(base: Args) {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        println!("{}", help_text());
        std::process::exit(0);
    }
    let mut has_errors = false;
    loop {
        let input = match prompt_input() {
            Some(input) => input,
            None => {
                if report::show_warning(&base.logging) {
                    eprintln!("warning: Reached end of input. Exiting...");
                }
                break;
            }
        };
        if input.trim().is_empty() {
            eprintln!("error: no input given");
            has_errors = true;
            continue;
        }
        let output = single_auto_output();
        let mut parsed = Args {
            input: Some(input.clone()),
            output: Some(output.clone()),
            ..base.clone()
        };
        if !apply_pickers(&mut parsed) {
            if report::show_warning(&parsed.logging) {
                eprintln!("warning: Reached end of input. Exiting...");
            }
            break;
        }
        if !run_single_inner(&parsed, &input, &output) {
            has_errors = true;
        }
    }
    if has_errors {
        std::process::exit(1);
    }
}

/// Prompt for pickers when no selector was given and a terminal is present.
/// Returns false on EOF (caller exits the loop), true otherwise. Bulk mode
/// never prompts: the first image and automatic level win.
fn apply_pickers(parsed: &mut Args) -> bool {
    use std::io::IsTerminal as _;
    if parsed.is_bulk_mode() || !std::io::stdin().is_terminal() {
        return true;
    }
    if parsed.image_index.is_none() {
        match image_picker() {
            Some(index) => parsed.image_index = Some(index),
            None => return false,
        }
    }
    if !parsed.has_level_specifying_args() && !parsed.largest {
        match level_picker() {
            Some(index) => parsed.zoom_level = Some(index),
            None => return false,
        }
    }
    true
}

/// Prompt for an image index before starting the job. Out-of-range indices
/// select the last image. Loops until a number or EOF.
fn image_picker() -> Option<usize> {
    loop {
        let line = prompt_line("Which image do you want to download? ")?;
        let trimmed = line.trim();
        if let Ok(index) = trimmed.parse::<usize>() {
            return Some(index);
        }
        eprintln!("error: '{trimmed}' is not a valid image number");
    }
}

/// Interactive level picker, same shape as the image picker. Any number is
/// accepted and out-of-range uses the last level.
fn level_picker() -> Option<usize> {
    loop {
        let line = prompt_line("Which level do you want to download? ")?;
        let trimmed = line.trim();
        if let Ok(index) = trimmed.parse::<usize>() {
            return Some(index);
        }
        eprintln!("error: '{trimmed}' is not a valid level number");
    }
}

/// Prompt for the input URI when a terminal is present. Returns `None` on
/// non-TTY or EOF.
fn prompt_input() -> Option<String> {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        return None;
    }
    let input = prompt_line("Enter an URL or a path to a tiles.yaml file: ")?;
    Some(input.trim().to_string())
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

fn job_options_for(parsed: &Args, input: &str, output: &Path) -> JobOptions {
    let mut user_headers = parsed.headers.clone();
    if let Some(referer) = parsed.request_referer() {
        if !user_headers.contains_key("referer") {
            user_headers.insert("referer".to_string(), referer.to_string());
        }
    }
    // Largest-image selection ignores dimension caps.
    let max_width = if parsed.should_use_largest() {
        None
    } else {
        parsed.max_width
    };
    JobOptions {
        input_url: input.to_string(),
        output: OutputTarget::File(output.to_path_buf()),
        overwrite: parsed.overwrite,
        format: Some(parsed.format.clone()),
        image_index: parsed.image_index,
        zoom_level: parsed.zoom_level,
        largest: parsed.should_use_largest(),
        max_width,
        max_height: parsed.max_height,
        max_retries: parsed.retries,
        retry_base_delay: parsed.retry_delay,
        keep_partial: parsed.keep_partial,
        compression: parsed.compression,
        headers: user_headers,
        cache_dir: parsed.tile_cache.clone(),
        timeout: parsed.timeout,
        connect_timeout: parsed.connect_timeout,
        max_idle_per_host: parsed.max_idle_per_host,
        accept_invalid_certs: parsed.accept_invalid_certs,
        max_concurrent: parsed.parallelism,
        min_interval: parsed.min_interval,
        ..JobOptions::default()
    }
}

fn run_single_inner(parsed: &Args, input: &str, output: &Path) -> bool {
    let level = parsed.logging.as_str();
    let json = parsed.json;
    let job_id = format!("job:cli-{}", std::process::id());
    let result = run_native(parsed, input, output, true);
    match result {
        Ok((summary, terminal_seq)) => {
            let Some(size) = summary.output.canvas.as_ref() else {
                eprintln!("error: saved output has no dimensions (internal)");
                return false;
            };
            if json {
                println!(
                    "{}",
                    report::machine_completed(&report::CompletedOutput {
                        job: &job_id,
                        seq: terminal_seq,
                        format: &summary.source_format,
                        width: size.width,
                        height: size.height,
                        tile_count: summary.tile_count,
                        partial: !summary.output.is_complete(),
                    })
                );
            } else if report::show_success(level) {
                if !summary.output.is_complete() {
                    eprintln!(
                        "kept partial {} ({} tiles, {}x{}) (missing tiles left blank)",
                        summary.path.display(),
                        summary.tile_count,
                        size.width,
                        size.height,
                    );
                } else {
                    eprintln!(
                        "saved {} ({} tiles, {}x{})",
                        summary.path.display(),
                        summary.tile_count,
                        size.width,
                        size.height,
                    );
                }
            }
            true
        }
        Err(error) => {
            eprintln!("error: {error} ({})", error.cause().kind());
            false
        }
    }
}

fn progress_view(
    progress: &dezoomify::model::Progress,
) -> (&'static str, BTreeMap<String, String>) {
    use dezoomify::model::ProgressPhase;
    let kind = match progress.phase {
        ProgressPhase::Discovery | ProgressPhase::Planning => "discovery",
        ProgressPhase::Acquisition => "downloading",
        ProgressPhase::Output => "encoding",
    };
    (
        kind,
        BTreeMap::from([
            ("acquired".into(), progress.completed.to_string()),
            ("total".into(), progress.total.unwrap_or(0).to_string()),
        ]),
    )
}

fn run_bulk(parsed: Args) {
    let level = parsed.logging.clone();
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
            Ok((_tiles, actual_output)) => {
                let item = report::BulkItem::ok(index, url, &actual_output);
                if parsed.json {
                    println!("{}", report::machine_bulk_item(&item));
                } else if report::show_success(&level) {
                    eprintln!("saved {actual_output} from {url}");
                }
                items.push(item);
            }
            Err(error) => {
                let item = report::BulkItem::failed(index, url, &output_str, &error);
                if parsed.json {
                    println!("{}", report::machine_bulk_item(&item));
                } else {
                    eprintln!(
                        "failed {url} -> {output_str}: {error} ({})",
                        error.cause().kind()
                    );
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
    } else if report::show_success(&level) {
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
    PathBuf::from(format!("dezoomify_{}.png", index + 1))
}

/// Choose a PNG path in the current directory, adding `_0001` collision suffixes.
fn single_auto_output() -> PathBuf {
    let base_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut path = base_dir.join("dezoomify.png");
    if !path.exists() {
        return path;
    }
    for i in 1.. {
        let candidate = base_dir.join(format!("dezoomify_{i:04}.png"));
        if !candidate.exists() {
            path = candidate;
            break;
        }
    }
    path
}

fn sanitize_title(title: &str) -> String {
    // Keep readable titles: ": " becomes " - ". Remaining illegal characters
    // (path separators, Windows-reserved `<>:\"/\\|?*`, controls, NUL)
    // become underscores.
    let dashed = title.replace(": ", " - ");
    let mut clean = String::with_capacity(dashed.len());
    for ch in dashed.chars() {
        if ch == '/'
            || ch == '\\'
            || ch == ':'
            || ch == '\0'
            || ch == '?'
            || ch == '"'
            || ch == '*'
            || ch == '<'
            || ch == '>'
            || ch == '|'
            || ch.is_control()
        {
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
) -> Result<(usize, String), dezoomify::model::Error> {
    run_native(parsed, url, Path::new(output), false).map(|(publication, _)| {
        (
            publication.tile_count,
            publication.path.to_string_lossy().into_owned(),
        )
    })
}

#[allow(clippy::result_large_err)] // Preserve the shared error until CLI presentation.
fn run_native(
    parsed: &Args,
    input: &str,
    output: &Path,
    individual: bool,
) -> Result<(dezoomify_native::Publication, u64), dezoomify::model::Error> {
    use dezoomify::model::Error;
    let started = Instant::now();
    let mut progress_gate = report::ProgressGate::default();
    let sequence = std::cell::Cell::new(1u64);
    let job_id = format!("job:cli-{}", std::process::id());
    let visible = individual || !parsed.json;
    let host = NativeHost::with_diagnostics(
        job_options_for(parsed, input, output),
        report::job_diagnostics(&parsed.logging),
    )?;
    if visible {
        print_progress(
            parsed.json,
            &job_id,
            1,
            "started",
            &BTreeMap::new(),
            &parsed.logging,
        );
    }
    host.on_progress(|progress| {
        let (kind, detail) = progress_view(&progress);
        if visible && (parsed.json || progress_gate.allow(kind, started.elapsed())) {
            sequence.set(sequence.get() + 1);
            print_progress(
                parsed.json,
                &job_id,
                sequence.get(),
                kind,
                &detail,
                &parsed.logging,
            );
        }
    });
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .inspect_err(|error| {
            host.diagnostics.finish(
                if matches!(error.cause(), Error::Cancelled) {
                    "cancelled"
                } else {
                    "failed"
                },
                serde_json::json!({ "error": error }),
            );
        })?;
    let publication = host.publication().ok_or_else(|| Error::Internal {
        failure: "output was not published".to_string().into(),
    })?;
    Ok((publication, sequence.get() + 1))
}

fn print_progress(
    json: bool,
    job: &str,
    seq: u64,
    kind: &str,
    detail: &BTreeMap<String, String>,
    logging: &str,
) {
    if json {
        println!("{}", report::machine_event_detail(job, seq, kind, detail));
        return;
    }
    if !report::show_progress(logging) {
        return;
    }
    let flat = detail
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        eprintln!("{kind} {job}");
    } else {
        eprintln!("{kind} {job} {flat}");
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
    let outcome = fetch(url, &BTreeMap::new(), Some(&user), &limits).map_err(|e| e.to_string())?;
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
