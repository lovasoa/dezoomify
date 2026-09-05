//! C2 acceptance: the native pipeline downloads, decodes, assembles, encodes,
//! and writes real output over loopback sockets against `dezoomify-fixture-server`
//! scenarios. Expected results (including the real output digest) are pinned
//! in `testdata/scenarios/native/*/expected/result.json`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use dezoomify_fixture_server::{router, AppState, RouteTable};
use dezoomify_native::pipeline::{self, PipelineConfig};

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
    // The runtime must outlive the server; leak it for the process lifetime.
    std::mem::forget(rt);
    format!("http://{bound}")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-pipeline-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn assembles_dzi_pyramid_from_fixture_scenario() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("dzi");
    let output = out_dir.join("pyramid.png");
    let mut events = 0usize;
    let outcome = pipeline::run(
        &input,
        &output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| events += 1,
    )
    .expect("pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    assert_eq!(outcome.image_size.x, 512);
    assert_eq!(outcome.image_size.y, 512);
    assert!(events > 0, "pipeline emitted progress events");

    let expected: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/scenarios/native/cli-dzi/expected/result.json"
        ))
        .expect("expected result"),
    )
    .expect("expected json");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash"),
        "output digest must match the pinned scenario expectation"
    );

    let bytes = std::fs::read(&output).expect("output file written");
    assert_eq!(
        format!("sha256:{}", {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(&bytes);
            digest
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        }),
        outcome.output_hash
    );

    let decoded = image::load_from_memory(&bytes)
        .expect("output decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (512, 512));
    let pixel = |x: u32, y: u32| {
        let p = decoded.get_pixel(x, y).0;
        (p[0], p[1], p[2])
    };
    assert_eq!(pixel(64, 64), (196, 48, 48), "top-left quadrant red");
    assert_eq!(pixel(448, 64), (48, 168, 64), "top-right quadrant green");
    assert_eq!(pixel(64, 448), (48, 72, 200), "bottom-left quadrant blue");
    assert_eq!(
        pixel(448, 448),
        (232, 220, 96),
        "bottom-right quadrant yellow"
    );
}

#[test]
fn tile_failure_fails_honestly_without_output() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/broken.dzi");
    let out_dir = temp_dir("failure");
    let output = out_dir.join("broken.png");
    let error = pipeline::run(
        &input,
        &output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect_err("pipeline fails on missing tiles");
    assert_eq!(error.code, "tile.download-failed");
    assert!(
        !output.exists(),
        "no output may be written for a failed job"
    );

    let expected: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/scenarios/native/cli-tile-failure/expected/result.json"
        ))
        .expect("expected result"),
    )
    .expect("expected json");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}
