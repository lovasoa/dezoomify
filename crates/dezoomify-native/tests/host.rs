use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dezoomify::model::ProgressPhase;
use dezoomify_native::{JobOptions, NativeHost, OutputTarget};
mod support;
use support::{http_response, scenario_payload, serve_counted, temp_dir, DZI_512};

#[test]
fn generic_probe_metadata_uses_final_tile_order_without_refetching() {
    use image::codecs::png::CompressionType;
    use image::ImageDecoder as _;

    let work = temp_dir("probe-metadata");
    let colors = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
    ];
    let mut routes = HashMap::new();
    let mut profiles = Vec::new();
    let mut metadata = Vec::new();
    for (index, color) in colors.into_iter().enumerate() {
        let profile = vec![
            0,
            0,
            2,
            12,
            b'a',
            b'd',
            b's',
            b'p',
            index as u8,
            0,
            0,
            0,
            b'm',
            b'n',
            b't',
            b'r',
            b'R',
            b'G',
            b'B',
            b' ',
        ];
        let exif = vec![b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0, 42, index as u8];
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba(color));
        let png = dezoomify_native::imaging::encode_png(
            &image,
            CompressionType::Fast,
            Some(&profile),
            Some(&exif),
        )
        .unwrap();
        routes.insert(
            format!("/tile-{}_{}.png", index % 2, index / 2),
            http_response("200 OK", "image/png", &png),
        );
        profiles.push(profile);
        metadata.push(exif);
    }
    let counts = Arc::new(Mutex::new(HashMap::new()));
    let base = serve_counted(Arc::new(Mutex::new(routes)), Arc::clone(&counts));
    let output = work.join("image.png");
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/tile-{{{{X}}}}_{{{{Y}}}}.png"),
        output: OutputTarget::File(output.clone()),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    host.transport
        .block_on(dezoomify::dezoomify(
            host.inputs(),
            host.algorithm_options(),
            &host,
        ))
        .unwrap();
    let publication = host.publication().unwrap();
    assert_eq!(publication.tile_count, 4);
    assert!(publication.output.is_complete());
    let mut saved =
        image::codecs::png::PngDecoder::new(std::io::Cursor::new(std::fs::read(output).unwrap()))
            .unwrap();
    assert_eq!(saved.icc_profile().unwrap(), Some(profiles[0].clone()));
    assert_eq!(saved.exif_metadata().unwrap(), Some(metadata[0].clone()));
    let pixels = image::DynamicImage::from_decoder(saved).unwrap().to_rgba8();
    assert_eq!(pixels.dimensions(), (4, 4));
    for (index, color) in colors.into_iter().enumerate() {
        assert_eq!(
            pixels
                .get_pixel((index as u32 % 2) * 2, (index as u32 / 2) * 2)
                .0,
            color
        );
        assert_eq!(
            counts.lock().unwrap()[&format!("/tile-{}_{}.png", index % 2, index / 2)],
            1
        );
    }
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn http_failures_retain_the_request_context_and_transport() {
    use dezoomify::{host::Host, model::*};

    let routes = Arc::new(Mutex::new(HashMap::from([(
        "/blocked".to_string(),
        http_response("403 Forbidden", "text/plain", b"access denied"),
    )])));
    let base = serve_counted(routes, Arc::default());
    let uri = format!("{base}/blocked");
    let work = temp_dir("request-facts");
    let host = NativeHost::new(JobOptions {
        input_url: uri.clone(),
        output: OutputTarget::File(work.join("image.png")),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    host.transport.block_on(async {
        let request = ResourceRequest {
            uri: uri.clone(),
            headers: Vec::new(),
            purpose: RequestPurpose::Metadata,
        };
        let metadata = host
            .fetch(request.clone(), Interaction::Forbidden)
            .await
            .unwrap_err();
        let tile = host
            .acquire_tile(Tile {
                index: 0,
                request: ResourceRequest {
                    purpose: RequestPurpose::Tile,
                    ..request
                },
                placement: TilePlacement {
                    position: Point { x: 0, y: 0 },
                    expected_size: None,
                    canvas: None,
                    processing: ProcessingRecipe::None,
                    role: TileRole::output(),
                },
            })
            .await
            .unwrap_err();
        for (error, kind) in [
            (&metadata, ResourceKind::Metadata),
            (&tile, ResourceKind::Tile),
        ] {
            let Error::Resource {
                request: context,
                resource_kind,
                source,
            } = error
            else {
                panic!("host failures carry request context")
            };
            assert_eq!(context, &uri);
            assert_eq!(*resource_kind, kind);
            assert_eq!(
                **source,
                Error::HttpError {
                    status: 403,
                    request: Some(uri.clone()),
                    retry_after_ms: None,
                    preview: None,
                    transport: ErrorTransport::Native,
                    detail: None,
                }
            );
            assert!(!error.retryable());
            assert!(error.to_string().contains("403"));
        }
        host.settle().await;
    });
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn malformed_encrypted_tile_retains_processing_failure_and_good_partial_pixels() {
    use dezoomify::{host::Host, model::*};
    use image::GenericImageView;

    let work = temp_dir("encrypted-partial");
    let valid = scenario_payload("tile-0_0.png");
    std::fs::write(work.join("good.png"), &valid).unwrap();
    // Encryption marker followed by an impossible plaintext header length.
    std::fs::write(work.join("bad.bin"), [10, 10, 10, 10, 255, 255, 255, 255]).unwrap();
    let output = work.join("image.png");
    let host = NativeHost::new(JobOptions {
        input_url: work.join("tiles.yaml").to_string_lossy().into_owned(),
        output: OutputTarget::File(output.clone()),
        cache_dir: Some(work.join("cache")),
        ..Default::default()
    })
    .unwrap();
    let canvas = Size {
        width: 512,
        height: 256,
    };
    let tile = |index, name: &str| Tile {
        index,
        request: ResourceRequest {
            uri: work.join(name).to_string_lossy().into_owned(),
            headers: Vec::new(),
            purpose: RequestPurpose::Tile,
        },
        placement: TilePlacement {
            position: Point {
                x: index * 256,
                y: 0,
            },
            expected_size: Some(Size {
                width: 256,
                height: 256,
            }),
            canvas: Some(canvas.clone()),
            processing: ProcessingRecipe::GoogleArtsDecrypt,
            role: TileRole::output(),
        },
    };
    host.transport.block_on(async {
        host.acquire_tile(tile(0, "good.png")).await.unwrap();
        let error = host.acquire_tile(tile(1, "bad.bin")).await.unwrap_err();
        let Error::Resource {
            request,
            resource_kind,
            source,
        } = &error
        else {
            panic!("host failures carry request context")
        };
        assert_eq!(
            request,
            &work.join("bad.bin").to_string_lossy().into_owned()
        );
        assert_eq!(*resource_kind, ResourceKind::Tile);
        assert!(
            matches!(&**source, Error::ProcessingFailed { detail: Some(detail) }
                if detail.contains("unencrypted header"))
        );
        assert!(!error.retryable());
        let mut corrupt_image = tile(1, "bad.bin");
        corrupt_image.placement.processing = ProcessingRecipe::None;
        let decode_error = host.acquire_tile(corrupt_image).await.unwrap_err();
        assert!(
            matches!(decode_error.cause(), Error::DecodeFailed { .. }),
            "decode failure: {decode_error}"
        );
        let decision = host
            .choose_partial(MissingTiles {
                missing: vec![MissingTile {
                    tile: 1,
                    failures: vec![error],
                }],
            })
            .await
            .unwrap();
        assert_eq!(decision, RecoveryChoice::Keep);
        let result = host
            .finish(FinishRequest {
                canvas: Some(canvas.clone()),
                format: OutputFormat::Png,
                title: None,
                missing: vec![1],
                reused_tiles: Vec::new(),
            })
            .await
            .unwrap();
        assert!(!result.is_complete());
        assert_eq!(result.missing, vec![1]);
        host.settle().await;
    });
    assert!(!output.exists());
    let partial = image::open(work.join("image.partial.png"))
        .unwrap()
        .to_rgba8();
    let expected = image::load_from_memory(&valid).unwrap().to_rgba8();
    assert_eq!(
        image::imageops::crop_imm(&partial, 0, 0, 256, 256).to_image(),
        expected
    );
    assert!(image::imageops::crop_imm(&partial, 256, 0, 256, 256)
        .pixels()
        .all(|(_, _, pixel)| pixel[3] == 0));
    let report = host.diagnostics.report();
    assert_eq!(report.outcome.unwrap().event, "partial-completed");
    let fields = serde_json::to_value(&report.failures[0].first.fields).unwrap();
    assert_eq!(fields["kind"], "resource");
    assert_eq!(fields["resource_kind"], "tile");
    assert_eq!(fields["source.kind"], "processing-failed");
    assert!(
        fields["source.detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("unencrypted header")),
        "failure record keeps the cause: {fields}"
    );
    std::fs::remove_dir_all(work).unwrap();
}

#[test]
fn automatic_output_uses_the_selected_title_and_avoids_overwriting() {
    let work = temp_dir("automatic-title");
    std::fs::write(work.join("tile.png"), scenario_payload("tile-0_0.png")).unwrap();
    let manifest = work.join("tiles.yaml");
    std::fs::write(&manifest, format!(
        "url_template: '{}'\nx_template: '0'\ny_template: '0'\nvariables:\n  - {{ name: x, from: 0, to: 0 }}\nwidth: 256\nheight: 256\ntitle: 'An image title'\n",
        work.join("tile.png").display(),
    )).unwrap();
    let options = JobOptions {
        input_url: manifest.to_string_lossy().into_owned(),
        output: OutputTarget::AutoDir {
            dir: work.clone(),
            format: dezoomify::model::OutputFormat::Png,
        },
        ..Default::default()
    };
    let first = support::run_options_observed(options.clone(), |_, _| {}).unwrap();
    assert_eq!(first.path.file_name().unwrap(), "An-image-title.png");
    let original = std::fs::read(&first.path).unwrap();
    let second = support::run_options_observed(options, |_, _| {}).unwrap();
    assert_eq!(second.path.file_name().unwrap(), "An-image-title-2.png");
    assert_eq!(std::fs::read(first.path).unwrap(), original);
}

/// Loopback server delaying tile bodies: at cancel time fetches are mid-air
/// and decodes may be starting, so the cancel path must quiesce tracked
/// async tasks and blocking decode tails before reporting the terminal.
fn serve_counted_with_tile_delay(
    shared: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
    tile_delay: Duration,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let shared = Arc::clone(&shared);
            let counts = Arc::clone(&counts);
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
                if path.contains("/pyr_files/") {
                    std::thread::sleep(tile_delay);
                }
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

#[test]
fn bounded_concurrency_and_memory_accounting() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("memory");
    let output = work.join("memory.png");
    let config = JobOptions {
        max_concurrent: 2,
        keep_partial: false,
        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = support::run_with_options(
        &format!("{base}/pyr.dzi"),
        output.to_str().expect("utf8"),
        false,
        &config,
        &mut |_| {},
    )
    .expect("pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    let stats = &outcome.instrumentation;
    assert!(
        stats.peak_inflight <= 2 + 2,
        "one acquisition slot per tile bounds in-flight work: {}",
        stats.peak_inflight
    );
    assert!(stats.bytes_fetched > 0, "fetched bytes accounted");
    assert_eq!(
        stats.canvas_bytes,
        512 * 512 * 4,
        "canvas costs 4 bytes per pixel"
    );
    assert_eq!(
        stats.accounted_peak_bytes,
        stats
            .canvas_bytes
            .saturating_add(stats.peak_retained_bytes)
            .saturating_add(stats.encoded_bytes),
        "accounted peak is canvas plus retained plus encoded"
    );
    assert!(
        stats.peak_retained_bytes <= 512 << 20,
        "retention stays under the output cap on actual retained bytes"
    );
    assert!(output.exists());
}

/// Partial retry preserves good tiles: only the settled-as-failed tile is
/// requeued with a fresh budget, successes are never refetched.
#[test]
fn partial_retry_preserves_good_tiles() {
    use dezoomify::model::RecoveryChoice;
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // The last tile fails transiently until the retry heals it.
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("500 Internal Server Error", "text/plain", b"flaky"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("retry-keep");
    let output = work.join("retry.png");
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        // Generous transient budget so the tile is still retrying when the
        // partial decision arrives; the Retry requeues with a fresh budget.
        max_retries: 1,
        // Hermetic tile cache: see above (ephemeral-port reuse + shared
        // default cache leaks stale entries into exact-count assertions).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let answered = std::rc::Rc::new(std::cell::Cell::new(false));
    let answer_record = answered.clone();
    host.on_partial(move |_| {
        answer_record.set(true);
        let good = scenario_payload("tile-1_1.png");
        shared.lock().expect("lock").insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("200 OK", "image/png", &good),
        );
        Box::pin(async { Ok(RecoveryChoice::Retry) })
    });
    let summary = support::run_host(&host).expect("retry heals the job");
    assert!(answered.get(), "partial decision surfaced for retry");
    assert_eq!(summary.tile_count, 4);
    assert!(summary.output.missing.is_empty());
    assert!(summary.output.is_complete());
    assert!(output.exists());
    let counts = counts.lock().expect("lock");
    // Good tiles are never refetched after the retry: successes preserved.
    for tile in ["0_0", "1_0", "0_1"] {
        assert_eq!(
            counts
                .get(&format!("/pyr_files/9/{tile}.png"))
                .copied()
                .unwrap_or(0),
            1,
            "good tile preserved across retry: {counts:?}"
        );
    }
    assert!(
        counts.get("/pyr_files/9/1_1.png").copied().unwrap_or(0) >= 2,
        "failed tile retried: {counts:?}"
    );
}

/// In-flight decode bytes are tracked and bounded: every blocking decode
/// reserves its body bytes, the peak is reported in the instrumentation,
/// and it never exceeds the live slot budget times the largest body.
#[test]
fn decode_inflight_bytes_are_bounded_and_accounted() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut max_body = 0usize;
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            max_body = max_body.max(bytes.len());
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("decode-budget");
    let output = work.join("decode.png");
    let config = JobOptions {
        max_concurrent: 2,
        keep_partial: false,
        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = support::run_with_options(
        &format!("{base}/pyr.dzi"),
        output.to_str().expect("utf8"),
        false,
        &config,
        &mut |_| {},
    )
    .expect("pipeline succeeds");
    assert_eq!(outcome.tile_count, 4);
    let stats = &outcome.instrumentation;
    assert!(
        stats.peak_decode_inflight_bytes > 0,
        "decode tracking observed live decode work"
    );
    assert!(
        stats.peak_decode_inflight_bytes <= 2 * max_body as u64,
        "in-flight decode bytes stay within the live slot budget: peak {} with 2 slots of at most {max_body} bytes",
        stats.peak_decode_inflight_bytes
    );
    assert!(output.exists());
}

/// Cancel mid-acquisition with slow tiles: the terminal waits for tracked
/// async tasks and blocking decode tails (quiescence including detached
/// tails), then reports cancel with nothing published -- no output, no
/// `.partial` sibling, pre-existing destination byte-identical.
#[test]
fn cancel_during_acquisition_quiesces_without_publication() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1", "1_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
    }
    let base = serve_counted_with_tile_delay(
        Arc::clone(&shared),
        Arc::clone(&counts),
        Duration::from_millis(500),
    );
    let work = temp_dir("cancel-tails");
    let output = work.join("tails.png");
    std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
    let start = Instant::now();
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        max_concurrent: 4,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let controls = host.controls.clone();
    host.on_progress(move |progress| {
        if progress.phase == ProgressPhase::Acquisition {
            controls.cancel();
        }
    });
    let error = support::run_host(&host).expect_err("cancel wins the race");
    assert!(matches!(error.cause(), dezoomify::model::Error::Cancelled));
    assert!(
        start.elapsed() < Duration::from_secs(60),
        "cancel quiesces promptly, including decode tails"
    );
    assert_eq!(
        std::fs::read(&output).expect("sentinel readable"),
        b"pre-existing sentinel",
        "cancel never touches the pre-existing destination"
    );
    assert!(
        !work.join("tails.partial.png").exists(),
        "cancel publishes no partial sibling either"
    );
}

/// Cancel/publication race: the commit point refuses publication once
/// cancellation was requested, so cancel reports quiescence with nothing
/// published and a pre-existing destination stays byte-identical. Cleanup
/// removes only job-owned temp resources, never the destination.
#[test]
fn cancel_publication_race_orders_commit_or_nothing() {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // One tile never arrives: the invocation awaits a partial choice where
        // the cancel race is deterministic.
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("404 Not Found", "text/plain", b"missing"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("cancel-race");
    let output = work.join("race.png");
    std::fs::write(&output, b"pre-existing sentinel").expect("sentinel");
    let start = Instant::now();
    let host = NativeHost::new(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("host initializes");
    let controls = host.controls.clone();
    host.on_partial(move |_| {
        controls.cancel();
        Box::pin(async { Ok(dezoomify::model::RecoveryChoice::Keep) })
    });
    let error = support::run_host(&host).expect_err("cancel wins the race");
    assert!(matches!(error.cause(), dezoomify::model::Error::Cancelled));
    // Cancellation is prompt (bounded gate wait, aborted fetches, joined
    // tasks) and publishes nothing.
    assert!(
        start.elapsed() < Duration::from_secs(60),
        "cancel quiesces promptly"
    );
    assert_eq!(
        std::fs::read(&output).expect("sentinel readable"),
        b"pre-existing sentinel",
        "cancel never touches the pre-existing destination"
    );
    assert!(
        !work.join("race.partial.png").exists(),
        "cancel publishes no partial sibling either"
    );
}
