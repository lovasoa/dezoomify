//! Engine regressions for the typed failure path (`JobCommand::TileFailed`
//! plus explicit retry timers):
//!
//! * permanent failures (e.g. HTTP 403) settle after exactly one attempt;
//! * transient failures retry on the exact budget with explicit waits;
//! * acquisition settles before the partial decision, so late in-flight
//!   completions still count and the missing list is complete;
//! * partial retry requeues only the failed tiles with a fresh budget and
//!   preserves successes;
//! * paused timers park until resume;
//! * stale/duplicate completions never double-settle;
//! * finalization/cancel ordering stays exact.

mod support;

use dezoomify_job::{Config, JobCommand, RecoveryChoice, TileFailure};
use support::ScriptedHost;

const INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The largest level is a real 2x2 grid with four planned tiles.
const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn budget_config(max_retries: u32) -> Config {
    Config {
        max_retries,
        ..Config::default()
    }
}

fn transient_failure() -> TileFailure {
    TileFailure::new("TRANSPORT_TIMEOUT", None, None, None)
}

fn http_failure(status: u16) -> TileFailure {
    TileFailure::new("TRANSPORT_HTTP_ERROR", Some(status), None, None)
}

/// Drive discovery plus selection of the largest level; return its tiles.
fn discover_and_acquire(host: &mut ScriptedHost) -> Vec<u32> {
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    host.tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect()
}

fn wait_retry_effects(host: &ScriptedHost) -> Vec<(u32, u32, u64)> {
    host.effects
        .iter()
        .filter(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("wait-retry"))
        .map(|v| {
            (
                v.get("tile")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as u32,
                v.get("attempt")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as u32,
                v.get("delay_ms")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            )
        })
        .collect()
}

fn acquire_count(host: &ScriptedHost, tile: u32) -> usize {
    host.tile_effects()
        .into_iter()
        .filter(|(id, _, probe)| *id == tile && !probe)
        .count()
}

#[test]
fn permanent_403_settles_after_single_attempt() {
    let mut host = ScriptedHost::new("job:403", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);
    assert_eq!(planned.len(), 4);

    // A 403 auth refusal is permanent: no timer, no re-acquisition.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: http_failure(403),
    })
    .unwrap();
    assert_eq!(host.job().tile_attempts_of(planned[0]), 1);
    assert_eq!(acquire_count(&host, planned[0]), 1);
    assert!(wait_retry_effects(&host).is_empty());
    // Siblings are still in flight, so the partial decision waits.
    assert_eq!(host.state(), "AcquiringTiles");

    for tile in planned.iter().skip(1) {
        host.apply(JobCommand::TileOutcome {
            tile: *tile,
            ok: true,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "AwaitingPartialDecision");
    // The missing detail keeps the structured facts, not a boolean.
    let detail = host.job().missing_detail();
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0].0, planned[0]);
    assert_eq!(detail[0].1.len(), 1);
    assert_eq!(detail[0].1[0].http, Some(403));
    assert!(!detail[0].1[0].is_retryable());

    host.apply(JobCommand::RecoveryChoice {
        generation: 0,
        choice: RecoveryChoice::Keep,
    })
    .unwrap();
    assert!(host.effects.iter().any(|effect| {
        effect.get("kind").and_then(serde_json::Value::as_str) == Some("finalize-output")
            && effect.get("partial").and_then(serde_json::Value::as_bool) == Some(true)
    }));
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "PartiallyCompleted");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn transient_failure_retries_exact_budget_with_explicit_waits() {
    let mut host = ScriptedHost::new("job:budget", INPUT_URL, budget_config(2)).unwrap();
    let planned = discover_and_acquire(&mut host);
    // Settle siblings first so the budget accounting is isolated.
    for tile in planned.iter().skip(1) {
        host.apply(JobCommand::TileOutcome {
            tile: *tile,
            ok: true,
        })
        .unwrap();
    }

    // Attempt 1 fails transiently: one explicit wait, no re-acquisition yet.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(wait_retry_effects(&host), vec![(planned[0], 1, 1_000)]);
    assert_eq!(acquire_count(&host, planned[0]), 1);

    // Timer elapses: the second attempt is issued exactly once.
    host.apply(JobCommand::RetryTimerElapsed {
        tile: planned[0],
        attempt: 1,
    })
    .unwrap();
    assert_eq!(acquire_count(&host, planned[0]), 2);

    // Attempt 2 fails: backoff doubles.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(
        wait_retry_effects(&host),
        vec![(planned[0], 1, 1_000), (planned[0], 2, 2_000)]
    );
    host.apply(JobCommand::RetryTimerElapsed {
        tile: planned[0],
        attempt: 2,
    })
    .unwrap();
    assert_eq!(acquire_count(&host, planned[0]), 3);

    // Attempt 3 exhausts the budget (1 initial + 2 retries): the tile
    // settles and, with everything else acquired, the partial decision
    // carries exactly this tile.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(host.job().tile_attempts_of(planned[0]), 3);
    assert_eq!(acquire_count(&host, planned[0]), 3);
    assert_eq!(wait_retry_effects(&host).len(), 2);
    assert_eq!(host.state(), "AwaitingPartialDecision");
}

#[test]
fn stale_timer_completions_are_ignored_without_new_work() {
    let mut host = ScriptedHost::new("job:stale", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);

    // Unknown timer completion is a safe no-op.
    let len = host.transcript().len();
    let outcome = host
        .apply(JobCommand::RetryTimerElapsed {
            tile: planned[0],
            attempt: 7,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);

    // Real timer, then a duplicate completion for the same attempt.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    host.apply(JobCommand::RetryTimerElapsed {
        tile: planned[0],
        attempt: 1,
    })
    .unwrap();
    let len = host.transcript().len();
    let outcome = host
        .apply(JobCommand::RetryTimerElapsed {
            tile: planned[0],
            attempt: 1,
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    assert_eq!(acquire_count(&host, planned[0]), 2);

    // A second failure report with no re-acquisition in between is a
    // duplicate of the settled attempt, not a new attempt.
    host.apply(JobCommand::TileFailed {
        tile: planned[1],
        failure: transient_failure(),
    })
    .unwrap();
    let attempts = host.job().tile_attempts_of(planned[1]);
    let len = host.transcript().len();
    let outcome = host
        .apply(JobCommand::TileFailed {
            tile: planned[1],
            failure: transient_failure(),
        })
        .unwrap();
    assert_eq!(outcome, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.job().tile_attempts_of(planned[1]), attempts);
    assert_eq!(host.transcript().len(), len);
}

#[test]
fn paused_timers_issue_on_resume_and_elapsed_parks_while_paused() {
    let mut host = ScriptedHost::new("job:ptimers", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);

    host.apply(JobCommand::Pause).unwrap();
    // Failure while paused records the attempt but issues no timer yet.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(host.job().tile_attempts_of(planned[0]), 1);
    assert!(wait_retry_effects(&host).is_empty());
    assert_eq!(host.job().pending_retry_count(), 1);

    // Resume starts the deferred timer.
    host.apply(JobCommand::Resume).unwrap();
    assert_eq!(wait_retry_effects(&host), vec![(planned[0], 1, 1_000)]);

    // A second tile fails after resume: its timer issues immediately.
    host.apply(JobCommand::Pause).unwrap();
    host.apply(JobCommand::Resume).unwrap();
    host.apply(JobCommand::TileFailed {
        tile: planned[1],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(wait_retry_effects(&host).len(), 2);

    // Timer elapses while paused: parked, no re-acquisition until resume.
    host.apply(JobCommand::Pause).unwrap();
    host.apply(JobCommand::RetryTimerElapsed {
        tile: planned[1],
        attempt: 1,
    })
    .unwrap();
    assert_eq!(acquire_count(&host, planned[1]), 1);
    host.apply(JobCommand::Resume).unwrap();
    assert_eq!(acquire_count(&host, planned[1]), 2);
}

#[test]
fn late_inflight_completions_settle_before_partial_decision() {
    let mut host = ScriptedHost::new("job:late", INPUT_URL, budget_config(0)).unwrap();
    let planned = discover_and_acquire(&mut host);

    // First failure with siblings still in flight: stashed, not decided.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");

    // A late success still counts toward progress.
    host.apply(JobCommand::TileOutcome {
        tile: planned[1],
        ok: true,
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");

    // A second failure joins the stash; the last success settles the round
    // and only then does the decision carry the complete missing list.
    host.apply(JobCommand::TileFailed {
        tile: planned[2],
        failure: http_failure(403),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    host.apply(JobCommand::TileOutcome {
        tile: planned[3],
        ok: true,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingPartialDecision");
    let mut missing: Vec<u32> = host
        .job()
        .missing_detail()
        .iter()
        .map(|(tile, _)| *tile)
        .collect();
    missing.sort_unstable();
    let mut expected = vec![planned[0], planned[2]];
    expected.sort_unstable();
    assert_eq!(missing, expected);
}

#[test]
fn partial_retry_requeues_only_failed_with_fresh_budget() {
    let mut host = ScriptedHost::new("job:requeue", INPUT_URL, budget_config(0)).unwrap();
    let planned = discover_and_acquire(&mut host);

    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    for tile in planned.iter().skip(1) {
        host.apply(JobCommand::TileOutcome {
            tile: *tile,
            ok: true,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "AwaitingPartialDecision");

    // Retry re-issues exactly the failed tile; successes are preserved.
    host.apply(JobCommand::RecoveryChoice {
        generation: 0,
        choice: RecoveryChoice::Retry,
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    assert_eq!(acquire_count(&host, planned[0]), 2);
    for tile in planned.iter().skip(1) {
        assert_eq!(
            acquire_count(&host, *tile),
            1,
            "successes are never re-fetched"
        );
    }
    assert_eq!(host.job().tile_attempts_of(planned[0]), 0);
    let (completed, total) = host.job().acquisition_progress();
    assert_eq!((completed, total), (3, 4));

    // The requeued tile fails again with zero retries: the decision
    // returns carrying exactly that tile.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingPartialDecision");
    let missing: Vec<u32> = host
        .job()
        .missing_detail()
        .iter()
        .map(|(tile, _)| *tile)
        .collect();
    assert_eq!(missing, vec![planned[0]]);

    host.apply(JobCommand::RecoveryChoice {
        generation: 1,
        choice: RecoveryChoice::Keep,
    })
    .unwrap();
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "PartiallyCompleted");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn success_after_finalization_and_cancel_after_quiescence_stay_rejected() {
    let mut host = ScriptedHost::new("job:order", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);
    for tile in &planned {
        host.apply(JobCommand::TileOutcome {
            tile: *tile,
            ok: true,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "Finalizing");
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");

    // Success after finalization: stably rejected, exactly one terminal.
    for late in [
        JobCommand::TileOutcome {
            tile: planned[0],
            ok: true,
        },
        JobCommand::TileFailed {
            tile: planned[1],
            failure: transient_failure(),
        },
        JobCommand::FinalizationSucceeded,
        JobCommand::Cancel,
    ] {
        let err = host.apply(late).unwrap_err();
        assert_eq!(err.code, "job.post-terminal");
    }
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn cancel_before_commit_releases_once_and_rejects_late_work() {
    let mut host = ScriptedHost::new("job:cancel", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);
    host.apply(JobCommand::TileOutcome {
        tile: planned[0],
        ok: true,
    })
    .unwrap();
    host.apply(JobCommand::Cancel).unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(
        host.effects
            .iter()
            .filter(
                |effect| effect.get("kind").and_then(serde_json::Value::as_str)
                    == Some("cancel-work")
            )
            .count(),
        1
    );
    assert_eq!(host.terminal_count(), 1);

    let len = host.transcript().len();
    let late = host.apply(JobCommand::TileOutcome {
        tile: planned[1],
        ok: true,
    });
    assert!(late.is_err());
    assert_eq!(late.unwrap_err().code, "job.post-terminal");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn large_grid_schedules_linearly_with_bounded_active_tiles() {
    // Synthetic 4096x4096 grid with 256px tiles: 256 planned tiles.
    // Scheduling stays linear (lazy per-completion driving, no eager fan
    // out) and at most `max_concurrent_fetches` tiles are ever active.
    const LARGE_DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="4096" Height="4096"/>
</Image>
"#;
    let started = std::time::Instant::now();
    let mut host = ScriptedHost::new("job:grid", INPUT_URL, Config::default()).unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: LARGE_DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    // Only the concurrency gate is emitted up front, never the whole grid.
    assert_eq!(host.tile_effects().len(), 4);

    let mut answered = std::collections::HashSet::new();
    let mut max_active = 0;
    while host.state() == "AcquiringTiles" {
        let next = host
            .tile_effects()
            .into_iter()
            .map(|(tile, _, probe)| (tile, probe))
            .find(|(tile, probe)| !probe && !answered.contains(tile))
            .map(|(tile, _)| tile);
        let Some(tile) = next else {
            break;
        };
        answered.insert(tile);
        host.apply(JobCommand::TileOutcome { tile, ok: true })
            .unwrap();
        max_active = max_active.max(host.job().in_flight_count());
    }
    assert_eq!(host.state(), "Finalizing");
    assert_eq!(answered.len(), 256);
    assert_eq!(host.tile_effects().len(), 256);
    assert!(max_active <= 4, "concurrency gate holds: {max_active}");
    let (completed, total) = host.job().acquisition_progress();
    assert_eq!((completed, total), (256, 256));
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
    eprintln!("large-grid acquisition took {:?}", started.elapsed());
}

const BULK_LIST: &str = "https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn deferred_host() -> ScriptedHost {
    let mut host = ScriptedHost::new(
        "job:deferred",
        "https://example.test/list.txt",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: BULK_LIST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    host
}

#[test]
fn deferred_follow_continues_same_job_without_new_id() {
    let mut host = deferred_host();
    let seq_before = host.job().seq();
    // Both entries are still-deferred requests, not selectable images.
    assert!(host.apply(JobCommand::SelectImage { image: 0 }).is_err());
    assert_eq!(
        host.deferred_uri_for_test(0),
        Some("https://example.test/a.dzi".to_string())
    );

    // Follow the first entry in the same job: the engine fetches the
    // follow-up URI and replaces the catalog; the revision lineage never
    // forks into a replacement job.
    host.apply(JobCommand::FollowDeferred { image: 0 }).unwrap();
    assert_eq!(host.state(), "Discovering");
    assert!(host.job().seq() > seq_before);
    let follow_request = host
        .effects
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource"))
        .expect("follow-up fetch");
    assert_eq!(
        follow_request
            .get("uri")
            .and_then(serde_json::Value::as_str),
        Some("https://example.test/a.dzi")
    );
    let request = follow_request
        .get("request")
        .and_then(serde_json::Value::as_u64)
        .and_then(|request| u32::try_from(request).ok())
        .expect("follow request id");
    host.apply(JobCommand::ResourceBytes {
        request,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    assert_eq!(host.deferred_uri_for_test(0), None);

    // The replaced catalog drives a complete job to terminal.
    let (image, levels) = host.catalog().expect("replaced catalog");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    for (tile, _, _) in host.tile_effects() {
        host.apply(JobCommand::TileOutcome { tile, ok: true })
            .unwrap();
    }
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn deferred_follow_cycle_is_rejected() {
    // Two-hop cycle: list.txt names mid.txt, mid.txt names list.txt back.
    // The input URL is consumed at start, so following the back edge is a
    // cycle and dies without new work.
    const MID_LIST: &str = "https://example.test/list.txt\n";
    const FIRST_LIST: &str = "https://example.test/mid.txt\n";
    let mut host = ScriptedHost::new(
        "job:cycle",
        "https://example.test/list.txt",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: FIRST_LIST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    host.apply(JobCommand::FollowDeferred { image: 0 }).unwrap();
    let request = host
        .effects
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource"))
        .and_then(|v| v.get("request").and_then(serde_json::Value::as_u64))
        .and_then(|request| u32::try_from(request).ok())
        .expect("follow request id");
    host.apply(JobCommand::ResourceBytes {
        request,
        bytes: MID_LIST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    let len = host.transcript().len();
    let err = host
        .apply(JobCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(host.transcript().len(), len);
}

#[test]
fn deferred_follow_budget_is_bounded() {
    // Bulk-shaped chain: list.txt names mid.txt, mid.txt names inner.txt.
    // Every step resolves single-round-trip, so the budget (not parsing)
    // is what stops the second follow.
    const FIRST: &str = "https://example.test/mid.txt\n";
    const NESTED: &str = "https://example.test/inner.txt\n";
    let mut host = ScriptedHost::new(
        "job:budget-follow",
        "https://example.test/list.txt",
        Config {
            max_deferred_follows: 1,
            ..Config::default()
        },
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: FIRST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    // First follow consumes the single allowed follow.
    host.apply(JobCommand::FollowDeferred { image: 0 }).unwrap();
    let request = host
        .effects
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource"))
        .and_then(|v| v.get("request").and_then(serde_json::Value::as_u64))
        .and_then(|request| u32::try_from(request).ok())
        .expect("follow request id");
    host.apply(JobCommand::ResourceBytes {
        request,
        bytes: NESTED.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    // The budget is spent: a second follow dies with no new work, and the
    // job still honestly awaits selection of whatever is ready.
    let len = host.transcript().len();
    let err = host
        .apply(JobCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(host.transcript().len(), len);
    assert_eq!(host.state(), "AwaitingImageSelection");

    // Zero follows allowed: following is rejected up front.
    let mut tight = ScriptedHost::new(
        "job:no-follow",
        "https://example.test/list.txt",
        Config {
            max_deferred_follows: 0,
            ..Config::default()
        },
    )
    .unwrap();
    tight.start().unwrap();
    tight
        .apply(JobCommand::ResourceBytes {
            request: 0,
            bytes: BULK_LIST.as_bytes().to_vec(),
            final_uri: None,
        })
        .unwrap();
    let err = tight
        .apply(JobCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(tight.state(), "AwaitingImageSelection");
}

#[test]
fn canonical_api_deferred_trace_keeps_one_job_id() {
    use dezoomify_job::engine_api::{DiscoveryInput, Effect, EngineJob, JobOptions, UserCommand};
    // The deferred example on the canonical surface: list input,
    // same-job follow, selection, tiles, terminal -- one EngineJob throughout.
    let options = JobOptions::new(vec![DiscoveryInput::with_contents(
        "https://example.test/list.txt",
        BULK_LIST.as_bytes().to_vec(),
    )]);
    let (mut job, update) = EngineJob::start(options).expect("valid options");
    // Inline list bytes evaluate directly: no fetch, straight to the
    // deferred catalog in the same job.
    assert!(update.metadata_effects().is_empty());
    assert_eq!(update.snapshot.selection.deferred.len(), 2);
    assert_eq!(
        update.snapshot.selection.deferred[0].uri,
        "https://example.test/a.dzi"
    );

    let update = job
        .command(UserCommand::FollowDeferred { image: 0 })
        .expect("same-job follow");
    let follow = update.metadata_effects();
    assert_eq!(follow.len(), 1);
    let Effect::AcquireMetadata { uri, .. } = follow[0] else {
        panic!("follow issues a metadata effect");
    };
    assert_eq!(uri, "https://example.test/a.dzi");
    let id = follow[0].id();
    let update = job
        .provide_metadata(
            id,
            dezoomify_job::engine_api::ResponseMetadata::new(),
            DZI.as_bytes(),
        )
        .expect("followed bytes");
    assert!(update.snapshot.selection.deferred.is_empty());

    let update = job
        .command(UserCommand::SelectImage { image: 0 })
        .expect("select image");
    let level = update.snapshot.selection.level_count - 1;
    let update = job
        .command(UserCommand::SelectLevel { level })
        .expect("select level");
    let tile_ids: Vec<_> = update
        .tile_effects()
        .iter()
        .map(|effect| effect.id())
        .collect();
    assert_eq!(tile_ids.len(), 4);
    let mut update = update;
    for id in tile_ids {
        update = job
            .complete(id, dezoomify_job::engine_api::EffectResult::TileAcquired)
            .expect("tile done");
    }
    let finalize = update.finalize_effects();
    assert_eq!(finalize.len(), 1);
    let update = job
        .complete(
            finalize[0].id(),
            dezoomify_job::engine_api::EffectResult::OutputCommitted {
                disposition: dezoomify_job::engine_api::OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert!(update.snapshot.terminal.is_some_and(|t| t.completed()));
}

#[test]
fn cancel_during_finalizing_wins_over_commit() {
    // Cancel before the output commit: the late commit is rejected and the
    // job rests cancelled with exactly one terminal event and one release.
    let mut host = ScriptedHost::new("job:cancel-final", INPUT_URL, Config::default()).unwrap();
    let planned = discover_and_acquire(&mut host);
    for tile in &planned {
        host.apply(JobCommand::TileOutcome {
            tile: *tile,
            ok: true,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "Finalizing");
    host.apply(JobCommand::Cancel).unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(
        host.effects
            .iter()
            .filter(
                |effect| effect.get("kind").and_then(serde_json::Value::as_str)
                    == Some("cancel-work")
            )
            .count(),
        1
    );
    let late = host.apply(JobCommand::FinalizationSucceeded).unwrap_err();
    assert_eq!(late.code, "job.post-terminal");
    assert_eq!(host.terminal_count(), 1);
}
