//! CLI entry point: argument parsing, real download pipeline, honest events.

mod arguments;
mod report;

use dezoomify_native::http::{FetchLimits, TlsPolicy};
use dezoomify_native::pipeline::{PipelineConfig, PipelineEvent};
use dezoomify_native::{pipeline, JobEvent, JobRequest, NativeRuntime};

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
    let runtime = NativeRuntime::new(1 << 30);
    let mut handle = match runtime.start(JobRequest {
        input_url: parsed.input.clone(),
        output_path: parsed.output.to_string_lossy().into_owned(),
        overwrite: parsed.overwrite,
    }) {
        Ok(handle) => handle,
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
    };
    handle.emit("started");
    print_event(parsed.json, &handle.events().last().expect("started event"));

    let config = PipelineConfig {
        user_headers: parsed.headers.clone(),
        max_width: parsed.max_width,
        fetch: FetchLimits {
            tls: TlsPolicy {
                accept_invalid_certs: parsed.accept_invalid_certs,
            },
            ..FetchLimits::default()
        },
        ..PipelineConfig::default()
    };
    let output = parsed.output.to_string_lossy().into_owned();
    let json = parsed.json;
    let result = pipeline::run(
        &parsed.input,
        &output,
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
                    report::machine_completed(&handle.id, handle.seq(), &outcome.output_hash)
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

fn print_event(json: bool, event: &JobEvent) {
    if json {
        println!(
            "{}",
            report::machine_event_detail(&event.job, event.seq, &event.kind, &event.detail)
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
