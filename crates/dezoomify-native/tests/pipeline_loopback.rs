//! C2 acceptance: the native pipeline downloads, decodes, assembles, encodes,
//! and writes real output over loopback sockets against `dezoomify-fixture-server`
//! scenarios. Expected results (including the real output digest) are pinned
//! in `testdata/scenarios/native/*/expected/result.json`.
//!
//! Raw-TCP tests cover flows the gateway cannot express (deferred follows
//! need runtime-port absolute URLs): a canned per-path responder serves list
//! files, metadata, and tiles on a fresh loopback port per test.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use dezoomify_fixture_server::{router, AppState, RouteTable};
use dezoomify_native::pipeline::{self, PartialPolicy, PipelineConfig};

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
        output.to_str().expect("utf8 output"),
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
        output.to_str().expect("utf8 output"),
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

fn scenario_expected(name: &str) -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../testdata/scenarios/native")
                .join(name)
                .join("expected/result.json"),
        )
        .unwrap_or_else(|e| panic!("expected result for {name}: {e}")),
    )
    .expect("expected json")
}

fn sha256_of_file(path: &std::path::Path) -> String {
    let bytes = std::fs::read(path).expect("output file written");
    format!("sha256:{}", {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    })
}

#[test]
fn corrupt_tile_fails_like_a_missing_tile() {
    // A 200 response with undecodable bytes exhausts retries exactly like a
    // 404: deterministic decode failures are not retried forever, and the
    // terminal code stays `tile.download-failed`.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/corrupt.dzi");
    let out_dir = temp_dir("corrupt");
    let output = out_dir.join("corrupt.png");
    let error = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect_err("pipeline fails on corrupt tiles");
    assert_eq!(error.code, "tile.download-failed");
    assert!(
        !output.exists(),
        "no output may be written for a failed job"
    );
    let expected = scenario_expected("cli-corrupt-tile");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}

#[test]
fn partial_keep_policy_encodes_acquired_tiles() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/corrupt.dzi");
    let out_dir = temp_dir("partial");
    let output = out_dir.join("partial.png");
    let config = PipelineConfig {
        partial_policy: PartialPolicy::Keep,
        ..Default::default()
    };
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {},
    )
    .expect("keep policy publishes a partial");
    assert!(outcome.partial, "kept output is marked partial");
    assert_eq!(outcome.tile_count, 3);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    // The corrupt quadrant stays blank (transparent black), the rest decodes.
    let bytes = std::fs::read(&output).expect("partial output written");
    let decoded = image::load_from_memory(&bytes)
        .expect("partial output decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (512, 512));
    let pixel = |x: u32, y: u32| {
        let p = decoded.get_pixel(x, y).0;
        (p[0], p[1], p[2])
    };
    assert_eq!(pixel(64, 64), (196, 48, 48), "top-left quadrant red");
    assert_eq!(pixel(64, 448), (48, 72, 200), "bottom-left quadrant blue");
    assert_eq!(
        (pixel(448, 448).0, pixel(448, 448).1, pixel(448, 448).2),
        (0, 0, 0),
        "corrupt quadrant stays blank"
    );
    let expected = scenario_expected("cli-partial-keep");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
    assert_eq!(outcome.output_hash, sha256_of_file(&output));
}

#[test]
fn max_width_selects_the_largest_fitting_level() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("max-width");
    let output = out_dir.join("narrow.png");
    let config = PipelineConfig {
        max_width: Some(300),
        ..Default::default()
    };
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {},
    )
    .expect("capped pipeline succeeds");
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (256, 256));
    assert_eq!(outcome.tile_count, 1);
    assert!(!outcome.partial);
    let expected = scenario_expected("cli-max-width");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
    assert_eq!(outcome.output_hash, sha256_of_file(&output));
}

#[test]
fn probe_planned_grid_matches_the_fixed_grid_output() {
    // A generic template has no fixed geometry: the driver answers probe
    // effects with observed tile sizes until the job resolves a real grid.
    // The assembled output must equal the fixed-grid pyramid byte for byte.
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/probe/{{{{X}}}}/{{{{Y}}}}.png");
    let out_dir = temp_dir("probe");
    let output = out_dir.join("probe.png");
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("probe-driven pipeline succeeds");
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    assert_eq!(outcome.tile_count, 4);
    let expected = scenario_expected("cli-probe-grid");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
    let pyramid = scenario_expected("cli-dzi");
    assert_eq!(
        outcome.output_hash,
        pyramid["outputHash"].as_str().expect("outputHash"),
        "probe planning assembles the identical output"
    );
}

#[test]
fn existing_output_without_overwrite_is_refused() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("denied");
    let output = out_dir.join("exists.png");
    std::fs::write(&output, b"previous bytes").expect("pre-existing output");
    let mut events = 0usize;
    let error = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| events += 1,
    )
    .expect_err("overwrite refusal fails");
    assert_eq!(error.code, "native.internal");
    assert_eq!(events, 0, "refusal happens before any work");
    assert_eq!(
        std::fs::read(&output).expect("output preserved"),
        b"previous bytes",
        "refused runs never touch the existing file"
    );
    let expected = scenario_expected("cli-destination-denied");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}

#[test]
fn jpg_output_decodes_at_full_size() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("jpg");
    let output = out_dir.join("pyramid.jpg");
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("jpeg pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    assert!(!outcome.partial);
    let bytes = std::fs::read(&output).expect("jpeg output written");
    assert!(
        bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "jpeg output carries the SOI marker"
    );
    let decoded = image::load_from_memory(&bytes)
        .expect("jpeg output decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (512, 512));
    assert_eq!(outcome.output_hash, sha256_of_file(&output));
    assert_eq!(
        outcome.output_hash,
        "sha256:474715c2ea1a569aab318058cb49002b800c09c223fcb20288edb75a30946349",
        "jpeg bytes are deterministic; pin the golden"
    );
}

#[test]
fn tiff_output_decodes_losslessly() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("tiff");
    let output = out_dir.join("pyramid.tif");
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("tiff pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    let bytes = std::fs::read(&output).expect("tiff output written");
    let decoded = image::load_from_memory(&bytes)
        .expect("tiff output decodes")
        .to_rgba8();
    assert_eq!((decoded.width(), decoded.height()), (512, 512));
    let pixel = |x: u32, y: u32| {
        let p = decoded.get_pixel(x, y).0;
        (p[0], p[1], p[2])
    };
    assert_eq!(pixel(64, 64), (196, 48, 48), "top-left quadrant red");
    assert_eq!(
        pixel(448, 448),
        (232, 220, 96),
        "bottom-right quadrant yellow"
    );
    assert_eq!(outcome.output_hash, sha256_of_file(&output));
    assert_eq!(
        outcome.output_hash,
        "sha256:00332ec92fd2380ed6edc188227e4a05639d2be6c72416e83a65f9110ee69081",
        "tiff bytes are deterministic; pin the golden"
    );
}

#[test]
fn iiif_dir_writes_manifest_and_addressable_tiles() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("iiif-dir");
    let output = out_dir.join("pyramid");
    let outcome = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("iiif-dir pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    assert!(!outcome.partial);
    // The manifest is spec-shaped: v2 context, real dimensions, one tile
    // block matching the files on disk.
    let info: serde_json::Value = serde_json::from_slice(
        &std::fs::read(output.join("info.json")).expect("info.json written"),
    )
    .expect("info.json parses");
    assert_eq!(info["width"], 512);
    assert_eq!(info["height"], 512);
    assert_eq!(info["tiles"][0]["width"], 512);
    assert_eq!(info["tiles"][0]["scaleFactors"], serde_json::json!([1]));
    // Each tile sits at its real IIIF request path, so a plain static file
    // server answers IIIF URLs, plus one full-image overview.
    let tile = output.join("0,0,512,512/512,/0/default.jpg");
    let overview = output.join("full/max/0/default.jpg");
    for path in [&tile, &overview] {
        let bytes = std::fs::read(path).expect("tile file written");
        assert!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]), "tile is jpeg");
        let decoded = image::load_from_memory(&bytes)
            .expect("tile decodes")
            .to_rgba8();
        assert_eq!((decoded.width(), decoded.height()), (512, 512));
    }
    assert_eq!(
        outcome.output_hash,
        "sha256:4a18d893a4a85c7ebc5ecb23f03564e90123af3b5abca540b9546ba0e9a1c3a3",
        "iiif-dir bytes are deterministic; pin the golden"
    );
}

#[test]
fn tile_cache_reuses_tiles_after_the_server_loses_them() {
    // First run populates the cache; then the tiles vanish from the server
    // (interrupted save) while the metadata stays. The second run reuses the
    // cached bodies and publishes the identical digest without refetching.
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_shared_map(Arc::clone(&shared));
    let tiles = ["0_0", "1_0", "0_1", "1_1"];
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in tiles {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let input = format!("{base}/pyr.dzi");
    let out_dir = temp_dir("tile-cache");
    let cache_dir = out_dir.join("cache");
    let config = PipelineConfig {
        cache_dir: Some(cache_dir.clone()),
        ..Default::default()
    };
    let first = out_dir.join("first.png");
    let outcome = pipeline::run(
        &input,
        first.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {},
    )
    .expect("first run populates the cache");
    let entries: Vec<_> =
        std::fs::read_dir(cache_dir.join(dezoomify_native::cache::job_namespace(&input)))
            .expect("job namespace written")
            .collect();
    assert_eq!(entries.len(), 4, "one cache entry per tile");
    // The tiles are gone from the server; only the metadata survives.
    {
        let mut map = shared.lock().expect("lock");
        for tile in tiles {
            map.remove(&format!("/pyr_files/9/{tile}.png"));
        }
    }
    let second = out_dir.join("second.png");
    let resumed = pipeline::run(
        &input,
        second.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {},
    )
    .expect("second run reuses the cache");
    assert_eq!(resumed.output_hash, outcome.output_hash);
    assert_eq!(resumed.tile_count, 4);
    assert!(!resumed.partial);
}

#[test]
fn tiny_canvas_budget_fails_before_any_write() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("canvas");
    let output = out_dir.join("huge.png");
    let config = PipelineConfig {
        max_canvas_bytes: 1024,
        ..Default::default()
    };
    let error = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {},
    )
    .expect_err("canvas budget fails");
    assert_eq!(error.code, "output.canvas-limit");
    assert!(
        error.message.contains("512x512")
            && error.message.contains("1048576 bytes")
            && error.message.contains("--max-width"),
        "canvas-limit names the size, the required memory, and the next action: {}",
        error.message
    );
    assert!(!output.exists(), "over-budget jobs write nothing");
    let expected = scenario_expected("cli-canvas-limit");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}

#[test]
fn cancellation_before_publish_writes_nothing() {
    let origin = start_fixture_server();
    let input = format!("{origin}/fetch?url=https://fixtures.test/cli/pyramid.dzi");
    let out_dir = temp_dir("cancel");
    let output = out_dir.join("cancelled.png");
    let cancel = Arc::new(AtomicBool::new(false));
    let config = PipelineConfig {
        cancel_flag: Arc::clone(&cancel),
        ..Default::default()
    };
    let error = pipeline::run(
        &input,
        output.to_str().expect("utf8 output"),
        false,
        &config,
        &mut |_event| {
            // Cancel as soon as acquisition starts: in-flight batches drain,
            // publish never runs, temp output never appears.
            cancel.store(true, Ordering::SeqCst);
        },
    )
    .expect_err("cancelled jobs fail");
    assert_eq!(error.code, "job.cancelled");
    assert!(!output.exists(), "cancelled jobs write nothing");
    let expected = scenario_expected("cli-cancel");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}

// ---------------------------------------------------------------------------
// Raw-TCP loopback: deferred follows need runtime-port absolute URLs, which
// committed fixtures cannot express.
// ---------------------------------------------------------------------------

fn http_response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(format!("HTTP/1.1 {status}\r\n").as_bytes());
    out.extend_from_slice(format!("content-type: {content_type}\r\n").as_bytes());
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

/// Serve a shared path → response map on loopback with one thread per
/// connection (tile fetches run concurrently). Unknown paths 404. The map
/// is read per request, so callers bind first, learn the port, then publish
/// port-dependent bodies (deferred lists need absolute runtime URLs).
fn serve_shared_map(shared: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
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

fn scenario_payload(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli")
            .join(name),
    )
    .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
}

fn solid_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut image = image::RgbaImage::new(width, height);
    for pixel in image.pixels_mut() {
        *pixel = image::Rgba([rgb[0], rgb[1], rgb[2], 255]);
    }
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    image::ImageEncoder::write_image(
        encoder,
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )
    .expect("encode solid tile");
    bytes
}

const DZI_512: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const DZI_256: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="256" Height="256"/>
</Image>
"#;

#[test]
fn deferred_bulk_entry_resolves_to_identical_output() {
    // The list names one image by absolute URL; the driver follows it with a
    // fresh bounded job instead of failing the typed `job.no-images`.
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_shared_map(Arc::clone(&shared));
    let tiles = ["0_0", "1_0", "0_1", "1_1"];
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/list.txt".to_string(),
            http_response(
                "200 OK",
                "text/plain",
                format!("{base}/pyr.dzi\n").as_bytes(),
            ),
        );
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in tiles {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }

    let out_dir = temp_dir("deferred");
    let output = out_dir.join("deferred.png");
    let outcome = pipeline::run(
        &format!("{base}/list.txt"),
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("deferred follow succeeds");
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (512, 512));
    assert_eq!(outcome.tile_count, 4);
    let expected = scenario_expected("cli-deferred");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
}

#[test]
fn self_referential_deferred_list_hits_the_resolution_limit() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_shared_map(Arc::clone(&shared));
    shared.lock().expect("lock").insert(
        "/self.txt".to_string(),
        http_response(
            "200 OK",
            "text/plain",
            format!("{base}/self.txt\n").as_bytes(),
        ),
    );

    let out_dir = temp_dir("deferred-limit");
    let output = out_dir.join("loop.png");
    let error = pipeline::run(
        &format!("{base}/self.txt"),
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect_err("self-deferral exhausts the bound");
    assert_eq!(error.code, "discovery.deferred");
    assert!(!output.exists());
    let expected = scenario_expected("cli-deferred-limit");
    assert_eq!(error.code, expected["code"].as_str().expect("code"));
}

#[test]
fn first_catalog_entry_wins_with_two_deferred_images() {
    // The bulk list names red before blue; the driver follows the first
    // entry only, so the output is solid red at the first image's size.
    let red_tile = solid_png(256, 256, [196, 48, 48]);
    let blue_tile = solid_png(256, 256, [48, 72, 200]);
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_shared_map(Arc::clone(&shared));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/two.txt".to_string(),
            http_response(
                "200 OK",
                "text/plain",
                format!("{base}/red.dzi\n{base}/blue.dzi\n").as_bytes(),
            ),
        );
        map.insert(
            "/red.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_256.as_bytes()),
        );
        map.insert(
            "/blue.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_256.as_bytes()),
        );
        map.insert(
            "/red_files/8/0_0.png".to_string(),
            http_response("200 OK", "image/png", &red_tile),
        );
        map.insert(
            "/blue_files/8/0_0.png".to_string(),
            http_response("200 OK", "image/png", &blue_tile),
        );
    }

    let out_dir = temp_dir("multi-image");
    let output = out_dir.join("first.png");
    let outcome = pipeline::run(
        &format!("{base}/two.txt"),
        output.to_str().expect("utf8 output"),
        false,
        &PipelineConfig::default(),
        &mut |_event| {},
    )
    .expect("first entry resolves");
    assert_eq!((outcome.image_size.x, outcome.image_size.y), (256, 256));
    assert_eq!(outcome.tile_count, 1);
    let bytes = std::fs::read(&output).expect("output written");
    let decoded = image::load_from_memory(&bytes).expect("decodes").to_rgba8();
    assert_eq!(decoded.get_pixel(8, 8).0[0..3], [196, 48, 48]);
    assert_eq!(decoded.get_pixel(200, 200).0[0..3], [196, 48, 48]);
    let expected = scenario_expected("cli-multi-image");
    assert_eq!(
        outcome.output_hash,
        expected["outputHash"].as_str().expect("outputHash")
    );
}
