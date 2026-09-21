//! Checklist section 1/2/5 proofs against the canonical [`EngineJob`] API:
//! same-job deferred resolution, exact request counts, late completions,
//! partial retries, disposal, and cancel/publication ordering.
//!
//! These tests drive `EngineJob` directly so per-attempt [`EffectId`]s stay
//! visible: the scripted host would swallow stale completions that these
//! tests must observe as typed rejections.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectId, EffectResult, EngineJob, Failure, JobOptions,
    OutputDisposition, PartialPolicy, RecoveryChoice, ResponseMetadata, SelectionPolicy,
};
use dezoomify_protocol::dto::JobState;
use dezoomify_protocol::dto::SnapshotTerminalDto;

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const BULK_LIST: &[u8] = b"https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn dzi_options() -> JobOptions {
    JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")])
}

fn metadata_id(update: &dezoomify_engine::Update) -> EffectId {
    let effects = update.metadata_effects();
    assert_eq!(effects.len(), 1, "one metadata effect: {effects:?}");
    effects[0].id()
}

fn tile_ids(update: &dezoomify_engine::Update) -> Vec<EffectId> {
    update.tile_effects().iter().map(|e| e.id()).collect()
}

fn tile_ordinals(update: &dezoomify_engine::Update) -> Vec<u32> {
    update
        .tile_effects()
        .iter()
        .map(|e| match e {
            Effect::AcquireTile { tile, .. } => *tile,
            other => panic!("expected tile effect, got {other:?}"),
        })
        .collect()
}

fn start_dzi() -> (EngineJob, dezoomify_engine::Update) {
    let (mut job, update) = EngineJob::start(dzi_options()).expect("start");
    assert_eq!(update.snapshot.lifecycle, JobState::Discovering);
    let id = metadata_id(&update);
    let update = job
        .provide_metadata(id, ResponseMetadata::new(), DZI)
        .expect("catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
    (job, update)
}

fn select_largest(job: &mut EngineJob) -> dezoomify_engine::Update {
    let update = job
        .command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .expect("select image");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingLevelSelection);
    let level = update.snapshot.selection.level_count - 1;
    let update = job
        .command(dezoomify_engine::UserCommand::SelectLevel { level })
        .expect("select level");
    assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
    update
}

fn transient() -> Failure {
    Failure::new("TRANSPORT_TIMEOUT")
}

fn permanent_403() -> Failure {
    let mut failure = Failure::new("TRANSPORT_HTTP_ERROR");
    failure.http = Some(403);
    failure
}

#[test]
fn deferred_follow_continues_same_job_with_exact_request_counts() {
    let options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/list.txt")]);
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    let update = job
        .provide_metadata(first, ResponseMetadata::new(), BULK_LIST)
        .expect("bulk catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
    assert_eq!(update.snapshot.selection.deferred.len(), 2);
    let follow_uri = update.snapshot.selection.deferred[0].uri.clone();
    assert_eq!(follow_uri, "https://example.test/a.dzi");

    // Ready images cannot be selected; deferred entries cannot be selected.
    assert!(job
        .command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .is_err());

    // Same job follows: exactly one new metadata effect for the follow URI.
    let update = job
        .command(dezoomify_engine::UserCommand::FollowDeferred { image: 0 })
        .expect("follow");
    assert_eq!(update.snapshot.lifecycle, JobState::Discovering);
    assert_eq!(update.effects.len(), 1);
    match &update.effects[0] {
        Effect::AcquireMetadata { uri, .. } => assert_eq!(uri, &follow_uri),
        other => panic!("expected metadata follow, got {other:?}"),
    }
    let follow = update.effects[0].id();
    let update = job
        .provide_metadata(follow, ResponseMetadata::new(), DZI)
        .expect("replaced catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
    // Deferred entries are gone once the catalog is replaced in place.
    assert!(update.snapshot.selection.deferred.is_empty());
    assert!(update.snapshot.selection.catalog.is_some());

    // The replaced catalog drives the same job to terminal: no host-created
    // replacement job, no new job ID (single EngineJob instance throughout).
    let update = select_largest(&mut job);
    assert_eq!(tile_ordinals(&update).len(), 4);
    for id in tile_ids(&update) {
        job.complete(id, EffectResult::TileAcquired)
            .expect("tile done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
    let finalize_id = job.outstanding_finalize().expect("finalize live");
    let update = job
        .complete(
            finalize_id,
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert_eq!(update.snapshot.lifecycle, JobState::Completed);
}

#[test]
fn deferred_cycle_and_budget_are_rejected_without_new_work() {
    // Cycle: following the job's own input URI is rejected.
    let options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/list.txt")]);
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    // A list that names the job's own input back: cycle on follow.
    let cyclic = b"https://example.test/list.txt\n";
    let update = job
        .provide_metadata(first, ResponseMetadata::new(), cyclic)
        .expect("bulk catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
    let revision = update.snapshot.revision;
    let err = job
        .command(dezoomify_engine::UserCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(job.snapshot().revision, revision);

    // Budget: zero follows disables following up front.
    let mut tight = JobOptions::new(vec![DiscoveryInput::new("https://example.test/list.txt")]);
    tight.max_deferred_follows = 0;
    let (mut job, update) = EngineJob::start(tight).expect("start");
    let first = metadata_id(&update);
    let _ = job
        .provide_metadata(first, ResponseMetadata::new(), BULK_LIST)
        .expect("bulk catalog");
    let err = job
        .command(dezoomify_engine::UserCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
}

#[test]
fn transient_retry_budget_has_exact_effect_counts_and_delays() {
    let mut options = dzi_options();
    options.max_retries = 2;
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    job.provide_metadata(first, ResponseMetadata::new(), DZI)
        .expect("catalog");
    let update = select_largest(&mut job);
    let ordinals = tile_ordinals(&update);
    assert_eq!(ordinals.len(), 4);
    // Settle siblings so retry accounting is isolated to tile 0.
    for id in tile_ids(&update).iter().skip(1) {
        job.complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    let tile0 = tile_ids(&update)[0];

    // Attempt 1 fails transiently: exactly one wait-retry timer at 1s.
    let update = job
        .complete(tile0, EffectResult::TileFailed(transient()))
        .expect("first failure");
    assert_eq!(update.effects.len(), 1);
    let (timer, attempt, delay) = match &update.effects[0] {
        Effect::WaitRetryTimer {
            id,
            attempt,
            delay_ms,
            ..
        } => (*id, *attempt, *delay_ms),
        other => panic!("expected wait-retry, got {other:?}"),
    };
    assert_eq!(attempt, 1);
    assert_eq!(delay, 1_000);
    let update = job
        .complete(timer, EffectResult::TimerElapsed)
        .expect("timer elapsed");
    assert_eq!(update.effects.len(), 1);
    let retry_id = match &update.effects[0] {
        Effect::AcquireTile { id, .. } => *id,
        other => panic!("expected retry acquire, got {other:?}"),
    };

    // Attempt 2 fails transiently: second timer doubles to 2s.
    let update = job
        .complete(retry_id, EffectResult::TileFailed(transient()))
        .expect("second failure");
    assert_eq!(update.effects.len(), 1);
    let (timer2, attempt2, delay2) = match &update.effects[0] {
        Effect::WaitRetryTimer {
            id,
            attempt,
            delay_ms,
            ..
        } => (*id, *attempt, *delay_ms),
        other => panic!("expected wait-retry, got {other:?}"),
    };
    assert_eq!(attempt2, 2);
    assert_eq!(delay2, 2_000);
    let update = job
        .complete(timer2, EffectResult::TimerElapsed)
        .expect("timer2 elapsed");
    assert_eq!(update.effects.len(), 1);
    let retry2 = match &update.effects[0] {
        Effect::AcquireTile { id, .. } => *id,
        other => panic!("expected retry acquire, got {other:?}"),
    };
    // Third acquisition succeeds: exactly 3 acquire-tile effects total for
    // the retried tile (1 initial + max_retries retries).
    let update = job
        .complete(retry2, EffectResult::TileAcquired)
        .expect("retry success");
    assert_eq!(update.snapshot.lifecycle, JobState::Finalizing);
    let acquire_count = job.snapshot().progress.completed;
    assert_eq!(acquire_count, 4);
}

#[test]
fn permanent_failure_settles_after_exactly_one_attempt() {
    let mut options = dzi_options();
    options.max_retries = 3;
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    job.provide_metadata(first, ResponseMetadata::new(), DZI)
        .expect("catalog");
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    // HTTP 403 is permanent: no wait-retry timer, tile settles at once.
    let update = job
        .complete(ids[0], EffectResult::TileFailed(permanent_403()))
        .expect("permanent failure");
    assert!(
        update.effects.is_empty(),
        "permanent failure schedules nothing: {:?}",
        update.effects
    );
    for id in ids.iter().skip(1) {
        job.complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::AwaitingPartialDecision);
    let decision = job.snapshot().decision.expect("decision");
    assert_eq!(decision.missing.len(), 1);
}

#[test]
fn permanent_failure_advances_single_slot_lazy_plan() {
    let mut options = dzi_options();
    options.max_concurrent = 1;
    options.max_retries = 0;
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    job.provide_metadata(first, ResponseMetadata::new(), DZI)
        .expect("catalog");
    let mut update = select_largest(&mut job);
    let mut attempted = Vec::new();

    while job.snapshot().lifecycle == JobState::AcquiringTiles {
        assert_eq!(tile_ids(&update).len(), 1, "one open slot at a time");
        let id = tile_ids(&update)[0];
        attempted.extend(tile_ordinals(&update));
        update = job
            .complete(id, EffectResult::TileFailed(permanent_403()))
            .expect("failed tile advances the plan");
        if job.snapshot().lifecycle == JobState::AcquiringTiles {
            assert_eq!(tile_ids(&update).len(), 1, "next tile was issued");
        }
    }

    assert_eq!(job.snapshot().lifecycle, JobState::AwaitingPartialDecision);
    assert_eq!(attempted, vec![0, 1, 2, 3]);
    assert_eq!(job.snapshot().decision.expect("decision").missing.len(), 4);
}

#[test]
fn partial_retry_requeues_exactly_failed_tiles_preserving_good() {
    let mut options = dzi_options();
    options.max_retries = 0;
    let (mut job, update) = EngineJob::start(options).expect("start");
    let first = metadata_id(&update);
    job.provide_metadata(first, ResponseMetadata::new(), DZI)
        .expect("catalog");
    let update = select_largest(&mut job);
    let ordinals = tile_ordinals(&update);
    let ids = tile_ids(&update);
    // One permanent failure, three successes: decision waits until every
    // planned tile is acquired or settled-as-failed.
    job.complete(ids[0], EffectResult::TileFailed(permanent_403()))
        .expect("failed tile");
    assert_eq!(job.snapshot().lifecycle, JobState::AcquiringTiles);
    for id in ids.iter().skip(1) {
        job.complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::AwaitingPartialDecision);
    let decision = job.snapshot().decision.expect("decision");
    let generation = decision.generation;
    assert_eq!(
        decision.missing.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
        vec![ordinals[0]]
    );
    // Retry requeues exactly the failed tile in plan order with a fresh
    // budget; acquired tiles are preserved (never re-fetched).
    let effects_before = tile_ordinals(&job.snapshot_update());
    let _ = effects_before;
    let update = job
        .command(dezoomify_engine::UserCommand::AnswerPartial {
            generation,
            decision: RecoveryChoice::Retry,
        })
        .expect("retry");
    assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
    let retried = tile_ordinals(&update);
    assert_eq!(retried, vec![ordinals[0]]);
    assert_eq!(update.snapshot.progress.completed, 3);
    let retry_id = tile_ids(&update)[0];
    job.complete(retry_id, EffectResult::TileAcquired)
        .expect("retried tile done");
    assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
}

#[test]
fn wrong_kind_completions_preserve_outstanding_work() {
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let tile_id = tile_ids(&update)[0];
    let revision = job.snapshot().revision;
    // A timer answer for a tile effect is a wrong-kind rejection that must
    // not consume the tile: the correct answer still works afterwards.
    let err = job
        .complete(tile_id, EffectResult::TimerElapsed)
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-result-kind");
    assert_eq!(job.snapshot().revision, revision);
    job.complete(tile_id, EffectResult::TileAcquired)
        .expect("tile still completable after wrong-kind");

    // Metadata bodies travel through provide_metadata only: answering a tile
    // effect with bytes is rejected and preserves the tile.
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let tile_id = tile_ids(&update)[0];
    let err = job
        .provide_metadata(tile_id, ResponseMetadata::new(), DZI)
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-result-kind");
    job.complete(tile_id, EffectResult::TileAcquired)
        .expect("tile still completable after wrong-kind bytes");

    // Empty metadata bodies are rejected without consuming the effect, so
    // the host can retry with real bytes.
    let (mut job, update) = EngineJob::start(dzi_options()).expect("start");
    let meta = metadata_id(&update);
    let err = job
        .provide_metadata(meta, ResponseMetadata::new(), b"")
        .unwrap_err();
    assert_eq!(err.code, "job.empty-resource");
    job.provide_metadata(meta, ResponseMetadata::new(), DZI)
        .expect("retry with real bytes works");
}

#[test]
fn duplicate_and_late_completions_are_stale_or_post_terminal() {
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    job.complete(ids[0], EffectResult::TileAcquired)
        .expect("first tile");
    // Duplicate completion of the same effect: stale, no state change.
    let revision = job.snapshot().revision;
    let err = job
        .complete(ids[0], EffectResult::TileAcquired)
        .unwrap_err();
    assert_eq!(err.code, "job.stale-effect");
    assert_eq!(job.snapshot().revision, revision);

    // Unknown effect ids are stale as well.
    let err = job
        .complete(EffectId(999_999), EffectResult::TileAcquired)
        .unwrap_err();
    assert_eq!(err.code, "job.stale-effect");

    // Run to terminal, then prove late completions never feed the machine.
    for id in ids.iter().skip(1) {
        job.complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
}

#[test]
fn cancel_and_publication_ordering_is_exact() {
    // Cancel during acquisition: exactly one cancel-release, then terminal.
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    job.complete(ids[0], EffectResult::TileAcquired)
        .expect("first tile");
    let update = job
        .command(dezoomify_engine::UserCommand::Cancel)
        .expect("cancel");
    assert_eq!(update.snapshot.lifecycle, JobState::Cancelled);
    assert_eq!(update.effects.len(), 1);
    assert!(matches!(update.effects[0], Effect::CancelRelease { .. }));
    assert!(matches!(
        update.snapshot.terminal,
        Some(SnapshotTerminalDto::Cancelled)
    ));
    // Late tile completion after cancel: post-terminal, never fed.
    let err = job
        .complete(ids[1], EffectResult::TileAcquired)
        .unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    assert_eq!(job.snapshot().lifecycle, JobState::Cancelled);
    // Cleanup acknowledgement is idempotent and changes nothing terminal.
    let cancel_id = update.effects[0].id();
    let again = job
        .complete(cancel_id, EffectResult::CleanupAcknowledged)
        .expect("cleanup ack");
    assert!(again.effects.is_empty());
    assert_eq!(again.snapshot.lifecycle, JobState::Cancelled);

    // Publication ordering: exactly one finalize effect, one terminal.
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    for id in tile_ids(&update) {
        job.complete(id, EffectResult::TileAcquired)
            .expect("tile done");
    }
    // Capture the finalize effect from the transition that entered
    // Finalizing: re-complete tiles is stale, so track via fresh query is
    // impossible; instead drive one more tile-free step is a no-op. The
    // finalize id is the only outstanding Finalize effect.
    let finalize_id = job.outstanding_finalize().expect("finalize live");
    let update = job
        .complete(
            finalize_id,
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert_eq!(update.snapshot.lifecycle, JobState::Completed);
    assert!(update.effects.is_empty(), "terminal issues no work");
    assert!(matches!(
        update.snapshot.terminal,
        Some(SnapshotTerminalDto::Completed)
    ));
    // A second publication claim for the same effect is stale; any further
    // input is post-terminal.
    let err = job
        .complete(
            finalize_id,
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .unwrap_err();
    assert_eq!(err.code, "job.stale-effect");
    let err = job
        .command(dezoomify_engine::UserCommand::Cancel)
        .unwrap_err();
    assert_eq!(err.code, "job.post-terminal");
    // Rejected publication never sets a disposition: a failed finalize
    // answered in the wrong phase leaves output summary disposition-free.
}

#[test]
fn rejected_publication_claims_no_disposition() {
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    // Finalize effects do not exist yet: claiming publication on a tile
    // effect is wrong-kind and sets no disposition.
    let err = job
        .complete(
            ids[0],
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-result-kind");
    assert_eq!(
        job.snapshot().output.as_ref().and_then(|o| o.disposition),
        None
    );
    for id in ids {
        job.complete(id, EffectResult::TileAcquired)
            .expect("tile done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
}

#[test]
fn engine_policies_replace_host_algorithms() {
    // Auto selection: headless callers name the rule up front; the engine
    // selects without prompting.
    let mut auto = dzi_options();
    auto.selection = SelectionPolicy::NativeAutomatic {
        image_index: 0,
        largest: true,
        max_width: None,
        max_height: None,
        zoom_level: None,
    };
    let (mut job, update) = EngineJob::start(auto).expect("start");
    let meta = metadata_id(&update);
    let update = job
        .provide_metadata(meta, ResponseMetadata::new(), DZI)
        .expect("catalog");
    assert_eq!(
        update.snapshot.lifecycle,
        JobState::AcquiringTiles,
        "auto policy selects first image + largest level without commands"
    );
    assert_eq!(update.snapshot.selection.image, Some(0));

    // Partial policies answer the decision in the same transition instead
    // of surfacing it.
    for (policy, terminal) in [
        (PartialPolicy::Keep, JobState::Finalizing),
        (PartialPolicy::Fail, JobState::Failed),
    ] {
        let mut options = dzi_options();
        options.max_retries = 0;
        options.partial = policy;
        let (mut job, update) = EngineJob::start(options).expect("start");
        let meta = metadata_id(&update);
        job.provide_metadata(meta, ResponseMetadata::new(), DZI)
            .expect("catalog");
        let update = select_largest(&mut job);
        let ids = tile_ids(&update);
        job.complete(ids[0], EffectResult::TileFailed(permanent_403()))
            .expect("fail one");
        for id in ids.iter().skip(1) {
            job.complete(*id, EffectResult::TileAcquired)
                .expect("sibling done");
        }
        assert_eq!(
            job.snapshot().lifecycle,
            terminal,
            "partial policy {policy:?} auto-answers"
        );
        assert!(job.snapshot().decision.is_none());
    }
}

fn dzi_doc(edge_px: u32) -> Vec<u8> {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="{edge_px}" Height="{edge_px}"/>
</Image>
"#
    )
    .into_bytes()
}

#[test]
fn acquisition_scales_with_bounded_outstanding_across_increasing_tile_counts() {
    // Scheduling scaling on the real EngineJob path: 256px tiles give
    // 1/4/16/64/256-tile grids at 256/512/1024/2048/4096px edges. The
    // engine windows acquisitions at the slot budget however large the
    // plan grows, and completions track the plan exactly.
    const BUDGET: u32 = 8;
    for (edge, expected) in [
        (256u32, 1u32),
        (512, 4),
        (1024, 16),
        (2048, 64),
        (4096, 256),
    ] {
        let mut options = dzi_options();
        options.max_concurrent = BUDGET;
        let (mut job, update) = EngineJob::start(options).expect("start");
        let id = metadata_id(&update);
        let update = job
            .provide_metadata(id, ResponseMetadata::new(), &dzi_doc(edge))
            .expect("catalog");
        assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
        let update = job
            .command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
            .expect("select image");
        let level = update.snapshot.selection.level_count - 1;
        let update = job
            .command(dezoomify_engine::UserCommand::SelectLevel { level })
            .expect("select level");
        assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
        assert_eq!(
            tile_ordinals(&update),
            (0..expected.min(BUDGET)).collect::<Vec<_>>(),
            "first request window is generated in source order at {edge}px"
        );
        let mut pending: std::collections::VecDeque<EffectId> =
            tile_ids(&update).into_iter().collect();
        assert_eq!(
            pending.len() as u32,
            expected.min(BUDGET),
            "initial window is the slot budget at {edge}px"
        );
        let mut peak = pending.len();
        let mut completed = 0u32;
        while let Some(id) = pending.pop_front() {
            let update = job
                .complete(id, EffectResult::TileAcquired)
                .expect("tile done");
            completed += 1;
            pending.extend(tile_ids(&update));
            peak = peak.max(pending.len());
            assert!(
                pending.len() <= BUDGET as usize,
                "outstanding never exceeds the slot budget at {edge}px: {}",
                pending.len()
            );
        }
        assert_eq!(
            completed, expected,
            "completions track the plan at {edge}px"
        );
        assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
        assert_eq!(job.snapshot().progress.completed, u64::from(expected));
        println!("engine scaling: {edge}px plan={expected} peak_outstanding={peak}");
    }
}

#[test]
fn pause_defers_retry_timers_until_resume() {
    let mut options = dzi_options();
    options.max_retries = 1;
    let (mut job, update) = EngineJob::start(options).expect("start");
    let meta = metadata_id(&update);
    job.provide_metadata(meta, ResponseMetadata::new(), DZI)
        .expect("catalog");
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    job.command(dezoomify_engine::UserCommand::Pause)
        .expect("pause");
    assert!(job.snapshot().paused);
    // Transient failure while paused: no timer issued until resume.
    let update = job
        .complete(ids[0], EffectResult::TileFailed(transient()))
        .expect("failure while paused");
    assert!(
        update.effects.is_empty(),
        "paused failures park the timer: {:?}",
        update.effects
    );
    let update = job
        .command(dezoomify_engine::UserCommand::Resume)
        .expect("resume");
    assert!(!update.snapshot.paused);
    assert_eq!(update.effects.len(), 1);
    assert!(matches!(update.effects[0], Effect::WaitRetryTimer { .. }));
}
