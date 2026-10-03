#![allow(dead_code)]
#![allow(unused_imports)]
#![allow(clippy::result_large_err)]
use dezoomify::model::Progress;
use dezoomify_native::{Controls, JobOptions, NativeHost, OutputTarget, Publication};
use std::path::Path;

pub fn run_options_observed(
    options: JobOptions,
    mut observe: impl FnMut(&Controls, &Progress),
) -> Result<Publication, dezoomify::model::Error> {
    let host = NativeHost::new(options)?;
    let controls = host.controls.clone();
    host.on_progress(move |progress| observe(&controls, &progress));
    run_host(&host)
}

pub fn run_host(host: &NativeHost<'_>) -> Result<Publication, dezoomify::model::Error> {
    let result = host.transport.block_on(dezoomify::dezoomify(
        host.inputs(),
        host.algorithm_options(),
        host,
    ));
    if let Err(error) = &result {
        host.diagnostics.finish(
            if matches!(error.cause(), dezoomify::model::Error::Cancelled) {
                "cancelled"
            } else {
                "failed"
            },
            serde_json::json!({ "error": error }),
        );
    }
    result?;
    host.publication().ok_or_else(|| {
        dezoomify::model::Error::Internal("output was not published".to_string().into())
    })
}

pub fn run_file(
    input_url: &str,
    output: &Path,
    configure: impl FnOnce(&mut JobOptions),
) -> Result<Publication, dezoomify::model::Error> {
    let mut options = JobOptions {
        input_url: input_url.to_string(),
        output: OutputTarget::File(output.to_path_buf()),
        ..JobOptions::default()
    };
    configure(&mut options);
    run_options_observed(options, |_, _| {})
}

pub fn run_with_options(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    on_progress: &mut dyn FnMut(&Progress),
) -> Result<Publication, dezoomify::model::Error> {
    run_options_observed(
        options_for_target(input_url, output, overwrite, options),
        |_, progress| on_progress(progress),
    )
}

pub fn run_with_options_observed(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    observe: impl FnMut(&Controls, &Progress),
) -> Result<Publication, dezoomify::model::Error> {
    run_options_observed(
        options_for_target(input_url, output, overwrite, options),
        observe,
    )
}

fn options_for_target(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
) -> JobOptions {
    let mut options = options.clone();
    options.input_url = input_url.to_string();
    options.output = OutputTarget::File(output.into());
    options.overwrite = overwrite;
    options
}

// ── shared loopback and fixture harnesses ─────────────────────────
// One copy for every integration test binary in this crate.

pub use dezoomify_fixture_server::{start as start_fixture_server, temp_dir};

pub fn http_response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(format!("HTTP/1.1 {status}\r\n").as_bytes());
    out.extend_from_slice(format!("content-type: {content_type}\r\n").as_bytes());
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

pub fn scenario_payload(name: &str) -> Vec<u8> {
    std::fs::read(
        dezoomify_fixture_server::scenarios_dir()
            .join("native/cli-dzi/payloads/fixtures.test/cli")
            .join(name),
    )
    .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
}

pub const DZI_512: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

pub const DZI_256: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="256" Height="256"/>
</Image>
"#;

/// Loopback server mapping request paths to canned byte responses while
/// counting hits per path.
pub fn serve_counted(
    shared: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>,
    counts: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, usize>>>,
) -> String {
    let server = dezoomify_fixture_server::NodeServer::raw("127.0.0.1", move |request| {
        let path = request.path;
        counts
            .lock()
            .expect("lock")
            .entry(path.clone())
            .and_modify(|n| *n += 1)
            .or_insert(1);
        shared
            .lock()
            .expect("lock")
            .get(&path)
            .cloned()
            .unwrap_or_else(|| http_response("404 Not Found", "text/plain", b"not found"))
            .into()
    });
    let origin = server.origin.clone();
    // Stdin closes when the test process exits, so Node cannot outlive it.
    std::mem::forget(server);
    origin
}
