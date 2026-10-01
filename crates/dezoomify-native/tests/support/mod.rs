#![allow(dead_code)]
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
    host.publication()
        .ok_or_else(|| dezoomify::model::Error::Internal {
            failure: "output was not published".to_string().into(),
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

pub fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-tests-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

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

/// Thin adapter: one published result as the shared golden records it.
pub fn golden_result(outcome: &Publication) -> dezoomify_fixture_server::GoldenResult {
    let canvas = outcome.output.canvas.as_ref().expect("published canvas");
    dezoomify_fixture_server::GoldenResult {
        image_size: (canvas.width as u64, canvas.height as u64),
        tile_count: outcome.tile_count as u64,
        output_format: outcome.output.format.as_str().to_string(),
        partial: !outcome.output.is_complete(),
    }
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
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let shared = std::sync::Arc::clone(&shared);
            let counts = std::sync::Arc::clone(&counts);
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while head.len() < 8192 {
                    let Ok(n) = stream.read(&mut byte) else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    head.extend_from_slice(&byte);
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let path = String::from_utf8_lossy(&head)
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                counts
                    .lock()
                    .expect("lock")
                    .entry(path.clone())
                    .and_modify(|n| *n += 1)
                    .or_insert(1);
                let body = shared
                    .lock()
                    .expect("lock")
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| http_response("404 Not Found", "text/plain", b"not found"));
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// The whole scenario corpus served on an allocated loopback port.
pub fn start_fixture_server() -> String {
    let scenarios_dir = dezoomify_fixture_server::scenarios_dir();
    let routes = dezoomify_fixture_server::RouteTable::load(&scenarios_dir).expect("load routes");
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _guard = rt.enter();
    let listener = rt
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind loopback");
    let bound = listener.local_addr().expect("addr");
    let state = dezoomify_fixture_server::AppState {
        routes: std::sync::Arc::new(routes),
        scenarios_dir,
        static_dir: None,
        origin: format!("http://{bound}"),
        log: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        log_path: None,
    };
    tokio::spawn(async move {
        axum::serve(listener, dezoomify_fixture_server::router(state))
            .await
            .expect("fixture server");
    });
    // The runtime must outlive the server; leak it for the process lifetime.
    std::mem::forget(rt);
    format!("http://{bound}")
}
