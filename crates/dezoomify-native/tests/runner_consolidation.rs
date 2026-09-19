//! Consolidated native runner: one engine-driven path for CLI, desktop, and
//! Native Messaging. These tests exercise the REAL pipeline (loopback HTTP,
//! decode, assemble, encode, atomic publication) through [`NativeRunner`]:
//! verbatim engine snapshots, bounded concurrency/retention, partial retry
//! preserving good tiles, and the cancel/publication race.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dezoomify_native::{JobOptions, NativeRunner, OutputTarget};
use dezoomify_protocol::dto::JobState;

fn http_response(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(format!("HTTP/1.1 {status}\r\n").as_bytes());
    out.extend_from_slice(format!("content-type: {content_type}\r\n").as_bytes());
    out.extend_from_slice(format!("content-length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

fn scenario_payload(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios/native/cli-dzi/payloads/fixtures.test/cli")
            .join(name),
    )
    .unwrap_or_else(|e| panic!("read payload {name}: {e}"))
}

const DZI_512: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Format="png" Overlap="0" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn serve_counted(
    shared: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
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

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-native-consolidation-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Engine snapshots forward verbatim with monotonic revisions and exactly one
/// terminal carrying the native publication.
#[test]
fn engine_snapshots_forward_verbatim_with_monotonic_revisions() {
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
    let work = temp_dir("verbatim");
    let output = work.join("verbatim.png");
    let job = NativeRunner::start(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        // Hermetic tile cache: the shared default on-disk cache plus
        // ephemeral-port reuse lets stale entries from earlier runs leak
        // into exact-count assertions. Each test owns a wiped cache dir.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("runner starts");
    let mut revisions = Vec::new();
    let mut terminals = 0;
    let mut saw_acquiring = false;
    loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        assert_eq!(snapshot.job, job.id, "snapshots stay job-scoped");
        // Verbatim engine vocabulary: lifecycle is the protocol JobState, not
        // a runner-local fold.
        assert!(
            matches!(
                snapshot.snapshot.lifecycle,
                JobState::Created
                    | JobState::Discovering
                    | JobState::AwaitingImageSelection
                    | JobState::AwaitingLevelSelection
                    | JobState::Planning
                    | JobState::AcquiringTiles
                    | JobState::AwaitingPartialDecision
                    | JobState::Finalizing
                    | JobState::Cancelling
                    | JobState::Completed
                    | JobState::PartiallyCompleted
                    | JobState::Failed
                    | JobState::Cancelled
            ),
            "lifecycle is the engine vocabulary"
        );
        if snapshot.snapshot.lifecycle == JobState::AcquiringTiles {
            saw_acquiring = true;
        }
        revisions.push(snapshot.snapshot.revision);
        if snapshot.snapshot.terminal.is_some() || snapshot.published.is_some() {
            terminals += 1;
            break;
        }
    }
    assert!(saw_acquiring, "acquisition phase observed verbatim");
    for pair in revisions.windows(2) {
        assert!(
            pair[1] >= pair[0],
            "revisions never move backward: {pair:?}"
        );
    }
    assert_eq!(terminals, 1, "exactly one terminal snapshot");
    let summary = job.join().expect("publication wins the race");
    assert_eq!(summary.tile_count, 4);
    assert_eq!((summary.width, summary.height), (512, 512));
    assert!(!summary.partial);
    assert!(output.exists(), "native publication reaches disk");
    // One reusable transport serves the whole job: 1 metadata + 4 tiles, no
    // per-fetch client rebuild multiplying requests.
    let counts = counts.lock().expect("lock");
    assert_eq!(
        counts.get("/pyr.dzi").copied().unwrap_or(0),
        1,
        "metadata fetched once: {counts:?}"
    );
    for tile in ["0_0", "1_0", "0_1", "1_1"] {
        assert_eq!(
            counts
                .get(&format!("/pyr_files/9/{tile}.png"))
                .copied()
                .unwrap_or(0),
            1,
            "each tile fetched once (no transport retry multiplying the engine budget): {counts:?}"
        );
    }
}

/// Bounded concurrency and honest memory accounting on the real pipeline:
/// peak in-flight never exceeds the engine slot budget, and the accounted
/// peak is canvas plus retained plus encoded.
#[test]
fn bounded_concurrency_and_memory_accounting() {
    use dezoomify_native::pipeline::{PartialPolicy, PipelineConfig};
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
    let config = PipelineConfig {
        max_concurrent: 2,
        partial_policy: PartialPolicy::Fail,
        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = dezoomify_native::pipeline::run(
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
        "one engine slot per tile bounds in-flight work (metadata + timers aside): {}",
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
    use dezoomify_protocol::dto::RecoveryChoice;
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
    let job = NativeRunner::start(JobOptions {
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
    .expect("runner starts");
    // Answer the partial decision with Retry once it surfaces, healing the
    // server first so the requeued attempt succeeds.
    let mut answered = false;
    loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        if let Some(decision) = snapshot.snapshot.decision.as_ref() {
            if !answered {
                answered = true;
                let good = scenario_payload("tile-1_1.png");
                shared.lock().expect("lock").insert(
                    "/pyr_files/9/1_1.png".to_string(),
                    http_response("200 OK", "image/png", &good),
                );
                let _ = job.send(dezoomify_native::UserCommand::AnswerPartial {
                    generation: decision.generation,
                    decision: RecoveryChoice::Retry,
                });
            }
        }
        if snapshot.snapshot.terminal.is_some() || snapshot.published.is_some() {
            break;
        }
    }
    assert!(answered, "partial decision surfaced for retry");
    let summary = job.join().expect("retry heals the job");
    assert_eq!(summary.tile_count, 4);
    assert!(summary.missing.is_empty());
    assert!(!summary.partial);
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
    use dezoomify_native::pipeline::{PartialPolicy, PipelineConfig};
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
    let config = PipelineConfig {
        max_concurrent: 2,
        partial_policy: PartialPolicy::Fail,
        // Hermetic tile cache: never share the default on-disk cache
        // between loopback tests (see verbatim test).
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    };
    let outcome = dezoomify_native::pipeline::run(
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
    let job = NativeRunner::start(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        max_concurrent: 4,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("runner starts");
    // Cancel as soon as acquisition starts, while every tile fetch is still
    // mid-air and decodes are about to begin.
    loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        if snapshot.snapshot.lifecycle == JobState::AcquiringTiles {
            break;
        }
        assert!(
            snapshot.snapshot.terminal.is_none(),
            "no terminal before the decision, got {:?}",
            snapshot.snapshot.terminal
        );
    }
    let _ = job.send(dezoomify_native::UserCommand::Cancel);
    match job.join() {
        Err(error) if error.code == "job.cancelled" => {}
        other => panic!("cancel wins the race, got {other:?}"),
    }
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

/// A stale partial answer carries its own generation to the engine and is
/// rejected there -- never consumed in order. The job fails on the
/// rejection instead of applying the stale choice, and nothing publishes.
#[test]
fn stale_partial_answer_is_engine_rejected_not_consumed() {
    use dezoomify_protocol::dto::RecoveryChoice;
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
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("404 Not Found", "text/plain", b"missing"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    let work = temp_dir("stale-answer");
    let output = work.join("stale.png");
    let job = NativeRunner::start(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        // Hermetic tile cache: the shared default on-disk cache plus
        // ephemeral-port reuse lets stale entries from earlier runs leak
        // into exact-count assertions. Each test owns a wiped cache dir.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("runner starts");
    // Wait for the partial wait, then answer with a generation the engine
    // never issued: the gate carries it through and the engine rejects it.
    let live = loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        if let Some(decision) = snapshot.snapshot.decision.as_ref() {
            break decision.generation;
        }
        assert!(
            snapshot.snapshot.terminal.is_none(),
            "no terminal before the decision, got {:?}",
            snapshot.snapshot.terminal
        );
    };
    let _ = job.send(dezoomify_native::UserCommand::AnswerPartial {
        generation: live.wrapping_add(1000),
        decision: RecoveryChoice::Retry,
    });
    match job.join() {
        Err(error) => {
            assert_ne!(
                error.code, "job.cancelled",
                "stale answer fails, never cancels"
            );
            assert!(
                !output.exists() && !work.join("stale.partial.png").exists(),
                "rejected answer publishes nothing"
            );
        }
        Ok(_) => panic!("stale answer must not be consumed as a valid Retry"),
    }
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
        // One tile never arrives: the driver parks in the partial wait where
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
    let job = NativeRunner::start(JobOptions {
        input_url: format!("{base}/pyr.dzi"),
        output: OutputTarget::File(output.clone()),
        overwrite: true,
        // Hermetic tile cache: see verbatim test.
        cache_dir: Some(work.join("tile-cache")),
        ..Default::default()
    })
    .expect("runner starts");
    // Wait for the partial wait, then cancel: the commit point must refuse.
    loop {
        let snapshot = job
            .snapshots()
            .recv_timeout(Duration::from_secs(60))
            .expect("snapshot arrives");
        if snapshot.snapshot.lifecycle == JobState::AwaitingPartialDecision {
            break;
        }
        assert!(
            snapshot.snapshot.terminal.is_none(),
            "no terminal before the decision, got {:?}",
            snapshot.snapshot.terminal
        );
    }
    let _ = job.send(dezoomify_native::UserCommand::Cancel);
    match job.join() {
        Err(error) if error.code == "job.cancelled" => {}
        other => panic!("cancel wins the race, got {other:?}"),
    }
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
