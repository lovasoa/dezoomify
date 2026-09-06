//! Named format selector: `PipelineConfig::format` threads through the job
//! driver to core registry selection. `None`/`auto` auto-detects;
//! a named format selects the single program; unknown names fail typed.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dezoomify_fixture_server::{router, AppState, RouteTable};
use dezoomify_native::pipeline::{PipelineConfig, PipelineEvent};

fn start_fixture_server() -> String {
    let scenarios_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios");
    let routes = RouteTable::load(&scenarios_dir).expect("load routes");
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _guard = rt.enter();
    let listener = rt
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind loopback");
    let bound = listener.local_addr().expect("addr");
    let state = AppState {
        routes: Arc::new(routes),
        scenarios_dir,
        static_dir: None,
        origin: format!("http://{bound}"),
        log: Arc::new(Mutex::new(Vec::new())),
        log_path: None,
    };
    tokio::spawn(async move {
        axum::serve(listener, router(state))
            .await
            .expect("fixture server");
    });
    std::mem::forget(rt);
    format!("http://{bound}")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-format-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn run_with_format(
    input: &str,
    output: &std::path::Path,
    format: Option<String>,
) -> Result<dezoomify_native::pipeline::PipelineOutcome, dezoomify_native::NativeError> {
    let config = PipelineConfig {
        format,
        ..Default::default()
    };
    dezoomify_native::pipeline::run(
        input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event: PipelineEvent| {},
    )
}

#[test]
fn auto_is_the_default() {
    assert_eq!(PipelineConfig::default().format, None);
}

#[test]
fn named_deepzoom_selects_the_single_program() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-ok");
    let output = out_dir.join("named.png");
    let outcome = run_with_format(&input, &output, Some("deepzoom".to_string()))
        .expect("named deepzoom succeeds");
    assert_eq!(outcome.format, "deepzoom");
    assert_eq!(outcome.tile_count, 4);
    assert!(!outcome.partial);
    assert!(output.is_file());
}

#[test]
fn named_format_matches_case_insensitively() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-case");
    let output = out_dir.join("named.png");
    let outcome = run_with_format(&input, &output, Some("DeepZoom".to_string()))
        .expect("case-insensitive named format succeeds");
    assert_eq!(outcome.format, "deepzoom");
}

#[test]
fn explicit_auto_behaves_like_default() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("explicit-auto");
    let output = out_dir.join("auto.png");
    let outcome =
        run_with_format(&input, &output, Some("auto".to_string())).expect("explicit auto succeeds");
    assert_eq!(outcome.format, "deepzoom");
    assert_eq!(outcome.tile_count, 4);
}

#[test]
fn named_mismatch_fails_instead_of_auto_detecting() {
    // A DZI document parsed as IIIF cannot succeed: the named selector must
    // not fall back to auto-detection.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("named-mismatch");
    let output = out_dir.join("mismatch.png");
    let error = run_with_format(&input, &output, Some("iiif".to_string()))
        .expect_err("iiif-only registry cannot parse DZI");
    assert_eq!(error.code, "discovery.failed");
    assert!(!output.exists(), "failed jobs write no output");
}

#[test]
fn unknown_format_fails_typed_without_output() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("unknown-format");
    let output = out_dir.join("unknown.png");
    let error = run_with_format(&input, &output, Some("nope".to_string()))
        .expect_err("unknown format must fail");
    // Stable code, never display-string matching.
    assert_eq!(error.code, "discovery.unknown-dezoomer");
    assert!(
        error.message.contains("nope"),
        "message names the bad format without credentials: {}",
        error.message
    );
    assert!(!output.exists(), "unknown format writes no output");
}
