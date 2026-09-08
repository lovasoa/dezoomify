//! Hermetic desktop end-to-end: the real lean shell drives real jobs over
//! loopback fixtures with no public network.
//!
//! Coverage mirrors the desktop job path end to end:
//! submit URL (`commands::dispatch` `start_job`) -> choose image/level
//! (`answer_choice` `img:0` / `level:9`) -> `request_destination` (real
//! dialog-path grant via `dispatch_destination`) -> background
//! `pipeline::run` save, with the saved PNG verified against the
//! `native/cli-dzi` golden (dimensions, quadrant placement, sha256). A
//! deep-link confirm flow (parse, confirm gate, confirmed save) and a cancel
//! flow (cancel before destination, terminal once, no output) ride the same
//! hermetic server.
//!
//! Isolation: every test binds its own ephemeral loopback port
//! (`127.0.0.1:0`), writes to its own isolated profile directory under the
//! system temp dir, and uses fixed inputs (no public DNS, no fixed shared
//! ports, no wall-clock assertions). Reports carry the redacted origin plus
//! hashes only, never full URLs, paths, or secrets.

use dezoomify_desktop::commands;
use dezoomify_desktop::deep_link;
use dezoomify_desktop::jobs::{payload_has_forbidden_keys, JobState, JobTable};
use dezoomify_fixture_server::{router, AppState, RouteTable};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const GATEWAY_DZI: &str = "https://fixtures.test/cli/pyramid.dzi";
const EXPECTED_WIDTH: u32 = 512;
const EXPECTED_HEIGHT: u32 = 512;
const EXPECTED_TILES: usize = 4;
// Top-left red, top-right green, bottom-left blue, bottom-right yellow.
const QUADRANTS: [((u32, u32), [u8; 3]); 4] = [
    ((64, 64), [196, 48, 48]),
    ((448, 64), [48, 168, 64]),
    ((64, 448), [48, 72, 200]),
    ((448, 448), [232, 220, 96]),
];

fn scenarios_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../testdata/scenarios")
}

fn golden_output_hash() -> String {
    let text = std::fs::read_to_string(scenarios_dir().join("native/cli-dzi/expected/result.json"))
        .expect("cli-dzi golden");
    let value: serde_json::Value = serde_json::from_str(&text).expect("golden json");
    value["outputHash"]
        .as_str()
        .expect("golden outputHash")
        .to_string()
}

/// Start the deterministic fixture server on an ephemeral loopback port.
/// The bound address implies listen readiness, so no readiness sleep is
/// needed. The runtime outlives the test process slice by design (same
/// pattern as the native pipeline loopback suites).
fn start_fixture_server() -> String {
    let dir = scenarios_dir();
    let routes = RouteTable::load(&dir).expect("load routes");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let _guard = runtime.enter();
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind loopback");
    let bound = listener.local_addr().expect("addr");
    assert!(
        bound.ip().is_loopback(),
        "fixture server must stay on loopback"
    );
    let state = AppState {
        routes: Arc::new(routes),
        scenarios_dir: dir,
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
    std::mem::forget(runtime);
    format!("http://{bound}")
}

fn profile_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dezoomify-desktop-e2e-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("profile dir");
    dir
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", hex_of(&digest))
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn gateway_input(origin: &str) -> String {
    format!("{origin}/fetch?url={GATEWAY_DZI}")
}

fn assert_saved_pyramid(path: &std::path::Path, expected_hash: &str) {
    let bytes = std::fs::read(path).expect("output file written");
    assert_eq!(sha256_hex(&bytes), expected_hash, "saved bytes hash");
    let decoded = image::load_from_memory(&bytes)
        .expect("output decodes")
        .to_rgba8();
    assert_eq!(
        (decoded.width(), decoded.height()),
        (EXPECTED_WIDTH, EXPECTED_HEIGHT),
        "saved dimensions"
    );
    for ((x, y), rgb) in QUADRANTS {
        let p = decoded.get_pixel(x, y).0;
        assert_eq!(
            (p[0], p[1], p[2]),
            (rgb[0], rgb[1], rgb[2]),
            "quadrant placement at {x},{y}"
        );
    }
}

/// Pump background drivers until the job reaches a terminal state.
/// Panics with the redacted transcript tail on timeout (never with paths
/// or full URLs).
fn wait_for_terminal(table: &mut JobTable, job: &str, timeout: Duration) -> JobState {
    let start = Instant::now();
    loop {
        table.poll_drivers();
        if let Some(state) = table.state_of(job) {
            if state.is_terminal() {
                table.poll_drivers();
                return state;
            }
        }
        if start.elapsed() > timeout {
            let tail: Vec<String> = table
                .events_for(job)
                .iter()
                .rev()
                .take(5)
                .map(|e| format!("{}:{}", e.kind, e.seq))
                .collect();
            panic!("job {job} never reached a terminal state; tail={tail:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn assert_transcript_hygiene(table: &mut JobTable, job: &str) {
    let events = table.events_for(job);
    let mut last = 0u64;
    let mut terminals = 0usize;
    for event in &events {
        assert!(event.seq > last, "seq must be strictly monotonic");
        last = event.seq;
        if event.kind == "completed" || event.kind == "cancelled" || event.kind == "failed" {
            terminals += 1;
        }
        assert!(
            !event.detail.contains("/cli/pyramid"),
            "full fixture path leaked into transcript"
        );
    }
    assert_eq!(terminals, 1, "terminal event appears exactly once");
    for emit in table.drain_pending() {
        assert!(
            !payload_has_forbidden_keys(&emit.payload),
            "tile bytes crossed IPC on {}",
            emit.channel
        );
        let text = emit.payload.to_string();
        assert!(
            !text.contains("/cli/pyramid"),
            "full input URL leaked into IPC payload"
        );
    }
    assert!(
        table.drain_pending().is_empty(),
        "drain never replays emits"
    );
}

/// Drive submit -> choose image/level on a fresh table and return the live
/// job id. The destination grant stays separate (see
/// [`grant_destination_until_running`]) so the race with the short-lived
/// discovery worker is handled in one place.
fn submit_and_choose(table: &mut JobTable, input: &str) -> String {
    let started = commands::dispatch(table, "start_job", None, Some(input))
        .expect("start_job accepts the fixture URL");
    let job = started.job.clone();
    let answered = commands::dispatch(table, "answer_choice", Some(&job), Some("img:0"))
        .expect("image choice accepted");
    assert_eq!(answered.job, job);
    assert_eq!(table.state_of(&job), Some(JobState::AwaitingLevelSelection));
    commands::dispatch(table, "answer_choice", Some(&job), Some("level:9"))
        .expect("level choice accepted");
    assert_eq!(table.state_of(&job), Some(JobState::AwaitingDestination));
    job
}

/// Grant the save destination, tolerating the grant racing the short-lived
/// discovery worker: the shell skips spawning the pipeline worker while
/// that handle is still running, so when no worker output arrives within
/// the settle budget the grant is repeated (idempotent for the fresh
/// path) once the worker handle is reaped, which spawns the pipeline.
/// A genuinely running worker speaks within milliseconds, so the common
/// path never waits out the budget.
fn grant_destination_until_running(table: &mut JobTable, job: &str, dest: &std::path::Path) {
    let first = commands::dispatch_destination(table, job, "png", dest, false)
        .expect("destination granted");
    assert!(
        !first.event.contains('/'),
        "destination id must stay opaque, never a path"
    );
    let settle = Instant::now();
    let before = table.events_for(job).len();
    while settle.elapsed() < Duration::from_secs(5) {
        table.poll_drivers();
        if table.state_of(job).is_some_and(|state| state.is_terminal()) {
            return;
        }
        if table.events_for(job).len() > before {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // No worker output: re-grant to spawn now that the discovery handle is
    // reaped. A failure here means the first worker did start after all
    // (its output now exists), so waiting still converges; the waiter
    // reports the transcript tail on timeout.
    let _ = commands::dispatch_destination(table, job, "png", dest, false);
}

fn percent_encode(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Gateway input for an arbitrary fixture URL (loopback only, never public).
fn gateway_input_for(origin: &str, fixture_url: &str) -> String {
    format!("{origin}/fetch?url={fixture_url}")
}

/// Pump until the job reaches `AwaitingPartialDecision` (the interactive
/// dialog cue). Panics with the redacted tail on timeout.
fn wait_for_partial_decision(table: &mut JobTable, job: &str, timeout: Duration) {
    let start = Instant::now();
    loop {
        table.poll_drivers();
        if table.state_of(job) == Some(JobState::AwaitingPartialDecision) {
            return;
        }
        if table.state_of(job).is_some_and(|s| s.is_terminal()) {
            panic!("job {job} reached terminal before the partial dialog");
        }
        if start.elapsed() > timeout {
            let tail: Vec<String> = table
                .events_for(job)
                .iter()
                .rev()
                .take(5)
                .map(|e| format!("{}:{}", e.kind, e.seq))
                .collect();
            panic!("job {job} never asked for a partial decision; tail={tail:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn assert_partial_transcript_hygiene(table: &mut JobTable, job: &str, granted_leaf: &str) {
    let events = table.events_for(job);
    let mut last = 0u64;
    let mut partials = 0usize;
    let mut completes = 0usize;
    for event in &events {
        assert!(event.seq > last, "seq must be strictly monotonic");
        last = event.seq;
        if event.kind == "partial-completed" {
            partials += 1;
        }
        if event.kind == "completed" {
            completes += 1;
        }
        assert!(
            !event.detail.contains("/desktop/tile-failure"),
            "full fixture path leaked into transcript"
        );
        // The granted absolute path never enters the transcript; only the
        // sibling basename may appear in the honest terminal.
        assert!(
            !event.detail.contains(granted_leaf) || event.detail.contains(".partial."),
            "granted leaf must not masquerade as output"
        );
    }
    assert_eq!(partials, 1, "honest partial terminal exactly once");
    assert_eq!(completes, 0, "partial must never also claim complete");
    for emit in table.drain_pending() {
        assert!(
            !payload_has_forbidden_keys(&emit.payload),
            "tile bytes crossed IPC on {}",
            emit.channel
        );
        let text = emit.payload.to_string();
        assert!(
            !text.contains("/desktop/tile-failure"),
            "full input URL leaked into IPC payload"
        );
    }
    assert!(
        table.drain_pending().is_empty(),
        "drain never replays emits"
    );
}

#[test]
fn desktop_e2e_save_flow_verifies_real_png() {
    let origin = start_fixture_server();
    let input = gateway_input(&origin);
    let expected_hash = golden_output_hash();
    let profile = profile_dir("save");
    let dest = profile.join("saved.png");
    assert!(!dest.exists(), "isolated profile starts empty");

    let mut table = JobTable::new();
    let job = submit_and_choose(&mut table, &input);
    grant_destination_until_running(&mut table, &job, &dest);
    let state = wait_for_terminal(&mut table, &job, Duration::from_secs(90));
    assert_eq!(state, JobState::Completed, "save flow completes");
    assert_eq!(table.saved_output_for(&job), Some(dest.clone()));
    assert!(table.saved_output_for("job:unknown").is_none());

    let snapshot = table.output_snapshot_for(&job).expect("output snapshot");
    assert_eq!(
        snapshot.output_hash, expected_hash,
        "digest pins the golden"
    );
    assert_eq!(snapshot.format, "png");
    assert_eq!(
        (snapshot.width, snapshot.height),
        (EXPECTED_WIDTH, EXPECTED_HEIGHT)
    );
    assert_eq!(snapshot.tile_count, EXPECTED_TILES);
    assert_saved_pyramid(&dest, &expected_hash);
    assert_transcript_hygiene(&mut table, &job);

    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn desktop_automatic_save_retains_openable_output() {
    let origin = start_fixture_server();
    let profile = profile_dir("automatic-open");
    let settings = dezoomify_desktop::settings::parse_settings(&serde_json::json!({
        "output_dir": profile,
        "output_format": "png"
    }))
    .unwrap();
    let mut table = JobTable::new();
    let job = table
        .start_job_with_settings(&gateway_input(&origin), &settings)
        .unwrap();
    assert!(table.saved_output_for(&job).is_none());
    assert_eq!(
        wait_for_terminal(&mut table, &job, Duration::from_secs(90)),
        JobState::Completed
    );
    let saved = table
        .saved_output_for(&job)
        .expect("automatic output retained");
    assert_eq!(saved.parent(), Some(profile.as_path()));
    assert_saved_pyramid(&saved, &golden_output_hash());
    let completed = table
        .drain_pending()
        .into_iter()
        .filter(|emit| emit.channel == "dezoomify://job-output")
        .collect::<Vec<_>>();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].payload["tileCount"], EXPECTED_TILES);
    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn desktop_e2e_deep_link_confirm_flow() {
    let origin = start_fixture_server();
    let input = gateway_input(&origin);
    let expected_hash = golden_output_hash();

    // The confirmed source travels as a bounded deep link, never raw.
    let link = format!("dezoomify://open?v=2&src={}", percent_encode(&input));
    let parsed = deep_link::parse_deep_link(&link).expect("deep link parses");
    assert_eq!(parsed.version, 2);
    assert_eq!(parsed.source_url, input);
    assert!(deep_link::requires_confirmation(&parsed));

    // Unconfirmed links perform no effect: the gate refuses first.
    assert!(
        deep_link::apply_after_confirmation(parsed.clone(), false).is_err(),
        "no effect without explicit confirmation"
    );
    let confirmed = deep_link::apply_after_confirmation(parsed, true).expect("confirmed");

    let profile = profile_dir("deep-link");
    let dest = profile.join("handoff.png");
    let mut table = JobTable::new();
    let job = submit_and_choose(&mut table, &confirmed.source_url);
    grant_destination_until_running(&mut table, &job, &dest);
    let state = wait_for_terminal(&mut table, &job, Duration::from_secs(90));
    assert_eq!(state, JobState::Completed, "confirmed handoff saves");
    assert_saved_pyramid(&dest, &expected_hash);
    assert_transcript_hygiene(&mut table, &job);

    // Rejected links stay typed and secret-free: assert the stable
    // `deep-link.rejected` code prefix, never message text.
    let userinfo = format!(
        "dezoomify://open?v=2&src={}",
        percent_encode("https://user:pass@example.com/x")
    );
    let err = deep_link::parse_deep_link(&userinfo).unwrap_err();
    assert_eq!(err, deep_link::DeepLinkError::UserinfoForbidden);
    assert!(err.to_string().starts_with("deep-link.rejected"));

    let smuggled = format!(
        "dezoomify://open?v=2&src={}",
        percent_encode("https://example.com/x?token=abc")
    );
    let err = deep_link::parse_deep_link(&smuggled).unwrap_err();
    assert!(err.to_string().starts_with("deep-link.rejected"));

    let future = "dezoomify://open?v=3&src=https%3A%2F%2Fexample.com%2Fx";
    let err = deep_link::parse_deep_link(future).unwrap_err();
    assert!(err.to_string().starts_with("deep-link.rejected"));

    let unknown = "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx&cookie=abc";
    let err = deep_link::parse_deep_link(unknown).unwrap_err();
    assert!(err.to_string().starts_with("deep-link.rejected"));

    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn desktop_e2e_cancel_flow_leaves_no_output() {
    let origin = start_fixture_server();
    let input = gateway_input(&origin);
    let profile = profile_dir("cancel");
    let ungranted = profile.join("cancelled.png");

    let mut table = JobTable::new();
    // Cancel before any destination grant: deterministic, no worker race.
    let started = commands::dispatch(&mut table, "start_job", None, Some(&input))
        .expect("submit starts a job");
    let job = started.job.clone();
    let outcome =
        commands::dispatch(&mut table, "cancel_job", Some(&job), None).expect("cancel accepted");
    assert_eq!(outcome.event, "cancelled");
    assert_eq!(table.state_of(&job), Some(JobState::Cancelled));
    assert!(
        table.output_hash_for(&job).is_none(),
        "cancel path never reports output"
    );
    assert!(!ungranted.exists(), "no output on the cancel path");

    // Post-terminal inputs are stale with no new effects.
    let before = table.events_for(&job).len();
    let err = commands::dispatch(&mut table, "cancel_job", Some(&job), None).unwrap_err();
    assert_eq!(err.code, "job.stale");
    let err =
        commands::dispatch(&mut table, "answer_choice", Some(&job), Some("img:0")).unwrap_err();
    assert_eq!(err.code, "job.stale");
    assert_eq!(table.events_for(&job).len(), before);
    assert_transcript_hygiene(&mut table, &job);

    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn desktop_e2e_partial_keep_is_honest_with_sibling() {
    let origin = start_fixture_server();
    let input = gateway_input_for(
        &origin,
        "https://fixtures.test/desktop/tile-failure-keep/corrupt.dzi",
    );
    let profile = profile_dir("partial-keep");
    let dest = profile.join("kept.png");
    let sibling = profile.join("kept.partial.png");
    assert!(!dest.exists() && !sibling.exists(), "profile starts empty");

    let mut table = JobTable::new();
    let job = submit_and_choose(&mut table, &input);
    grant_destination_until_running(&mut table, &job, &dest);
    // The driver waits for the explicit dialog choice (no auto-answer).
    wait_for_partial_decision(&mut table, &job, Duration::from_secs(60));
    let pending = table.events_for(&job);
    assert!(
        pending.iter().any(|e| e.kind == "recovery-requested"),
        "partial dialog requested exactly once before any terminal"
    );
    // Explicit keep: the `.partial` sibling carries the bytes and geometry
    // while the granted path stays untouched.
    commands::dispatch(
        &mut table,
        "answer_choice",
        Some(&job),
        Some("partial:keep"),
    )
    .expect("keep choice accepted");
    let state = wait_for_terminal(&mut table, &job, Duration::from_secs(90));
    assert_eq!(
        state,
        JobState::PartiallyCompleted,
        "kept partial ends partial-completed, never completed"
    );
    assert!(sibling.exists(), "kept bytes land at the sibling");
    assert_eq!(table.saved_output_for(&job), Some(sibling.clone()));
    assert!(
        !dest.exists(),
        "granted destination untouched by the partial publish"
    );
    let bytes = std::fs::read(&sibling).expect("sibling written");
    let decoded = image::load_from_memory(&bytes)
        .expect("sibling decodes")
        .to_rgba8();
    assert_eq!(
        (decoded.width(), decoded.height()),
        (EXPECTED_WIDTH, EXPECTED_HEIGHT),
        "kept geometry stays honest"
    );
    let snapshot = table.output_snapshot_for(&job).expect("output snapshot");
    assert_eq!(snapshot.width, EXPECTED_WIDTH);
    assert_eq!(snapshot.height, EXPECTED_HEIGHT);
    assert_eq!(snapshot.output_hash, sha256_hex(&bytes));
    assert_eq!(
        table.output_sibling_for(&job).as_deref(),
        Some("kept.partial.png"),
        "sibling basename only, never the granted path"
    );
    assert!(
        !table.output_missing_for(&job).is_empty(),
        "missing ledger survives to the terminal"
    );
    assert_partial_transcript_hygiene(&mut table, &job, "kept.png");

    let _ = std::fs::remove_dir_all(&profile);
}

#[test]
fn desktop_e2e_partial_discard_fails_honestly_with_no_output() {
    let origin = start_fixture_server();
    let input = gateway_input_for(
        &origin,
        "https://fixtures.test/desktop/tile-failure-fail/broken.dzi",
    );
    let profile = profile_dir("partial-discard");
    let dest = profile.join("discarded.png");
    let sibling = profile.join("discarded.partial.png");

    let mut table = JobTable::new();
    let job = submit_and_choose(&mut table, &input);
    grant_destination_until_running(&mut table, &job, &dest);
    wait_for_partial_decision(&mut table, &job, Duration::from_secs(60));
    commands::dispatch(
        &mut table,
        "answer_choice",
        Some(&job),
        Some("partial:discard"),
    )
    .expect("discard choice accepted");
    let state = wait_for_terminal(&mut table, &job, Duration::from_secs(90));
    assert_eq!(state, JobState::Failed, "discard ends failed");
    let snapshot = table.error_snapshot_for(&job).expect("error snapshot");
    assert_eq!(
        snapshot.code, "tile.download-failed",
        "stable code, never display strings"
    );
    assert!(
        table.output_hash_for(&job).is_none(),
        "discard writes no output"
    );
    assert!(!dest.exists(), "granted destination untouched on discard");
    assert!(!sibling.exists(), "no sibling on the discard path");
    assert!(
        !table
            .events_for(&job)
            .iter()
            .any(|e| e.kind == "partial-completed" || e.kind == "completed"),
        "discard never claims a save"
    );

    let _ = std::fs::remove_dir_all(&profile);
}
