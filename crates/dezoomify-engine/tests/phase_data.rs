//! Phase-grouped state proofs for `crates/dezoomify-engine/src/job.rs`.
//!
//! The job groups phase-specific data into single-discriminant enums
//! (`Selection`, `Decision`, `Finalization`) plus one unified probe flight
//! (`ActiveProbe`), so unrelated phases cannot represent each other's data.
//! These tests prove the unrepresentable states through the canonical
//! [`EngineJob`] API:
//!
//! * answering a partial decision with none pending is a single-check
//!   rejection on the decision discriminant, whatever the phase;
//! * a stale generation is rejected while the pending decision survives;
//! * decided data cannot survive the phase exit on any answer arm;
//! * selection locks as phases advance (no image change after the image is
//!   decided, no level before its image, no deferred follow after selection);
//! * finalization answers are valid only while finalization is pending;
//! * probe answers never cross into ordinary tile effects and vice versa.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectId, EffectResult, EngineJob, Failure, JobOptions,
    OutputDisposition, RecoveryChoice, ResponseMetadata,
};
use dezoomify_protocol::dto::JobState;

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

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

fn permanent_403() -> Failure {
    let mut failure = Failure::new("TRANSPORT_HTTP_ERROR");
    failure.http = Some(403);
    failure
}

fn drive_to_partial_decision(job: &mut EngineJob) -> (Vec<EffectId>, u32) {
    let update = select_largest(job);
    let ids = tile_ids(&update);
    // One permanent failure plus three successes settles the round into the
    // partial decision with exactly one missing tile.
    job.complete(ids[0], EffectResult::TileFailed(permanent_403()))
        .expect("failed tile");
    assert_eq!(job.snapshot().lifecycle, JobState::AcquiringTiles);
    for id in ids.iter().skip(1) {
        job.complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(job.snapshot().lifecycle, JobState::AwaitingPartialDecision);
    let generation = job.snapshot().decision.expect("decision").generation;
    (ids, generation)
}

/// Answering a partial decision with none pending is a single-check
/// rejection in every non-decision phase: awaiting image, awaiting level,
/// and mid-acquisition.
#[test]
fn answer_without_pending_decision_is_rejected_in_every_phase() {
    let (mut job, _update) = start_dzi();
    let err = job
        .command(dezoomify_engine::UserCommand::AnswerPartial {
            generation: 0,
            decision: RecoveryChoice::Keep,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert!(job.snapshot().decision.is_none());

    let update = job
        .command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .expect("select image");
    assert_eq!(update.snapshot.lifecycle, JobState::AwaitingLevelSelection);
    let err = job
        .command(dezoomify_engine::UserCommand::AnswerPartial {
            generation: 0,
            decision: RecoveryChoice::Retry,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");

    let update = select_largest(&mut job);
    assert_eq!(job.snapshot().lifecycle, JobState::AcquiringTiles);
    let revision = job.snapshot().revision;
    let err = job
        .command(dezoomify_engine::UserCommand::AnswerPartial {
            generation: 0,
            decision: RecoveryChoice::Discard,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(job.snapshot().revision, revision);
    assert!(job.snapshot().decision.is_none());
    let _ = tile_ids(&update);
}

/// A stale generation is rejected while the pending decision survives
/// untouched; the correct generation still answers afterwards.
#[test]
fn stale_generation_is_rejected_and_pending_survives() {
    let (mut job, _update) = start_dzi();
    let (_ids, generation) = drive_to_partial_decision(&mut job);
    let err = job
        .command(dezoomify_engine::UserCommand::AnswerPartial {
            generation: generation + 1,
            decision: RecoveryChoice::Keep,
        })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    // The pending decision survived the stale answer: same generation,
    // same lifecycle, still answerable.
    let pending = job.snapshot().decision.expect("decision survives");
    assert_eq!(pending.generation, generation);
    assert_eq!(job.snapshot().lifecycle, JobState::AwaitingPartialDecision);
    job.command(dezoomify_engine::UserCommand::AnswerPartial {
        generation,
        decision: RecoveryChoice::Keep,
    })
    .expect("correct generation answers");
    assert_eq!(job.snapshot().lifecycle, JobState::Finalizing);
    assert!(job.snapshot().decision.is_none());
}

/// Decided data cannot survive the phase exit: every answer arm clears the
/// pending decision, so a second answer with the same generation is a
/// none-pending rejection rather than a replay.
#[test]
fn decided_data_cannot_survive_phase_exit() {
    for decision in [
        RecoveryChoice::Retry,
        RecoveryChoice::Keep,
        RecoveryChoice::Discard,
    ] {
        let (mut job, _update) = start_dzi();
        let (_ids, generation) = drive_to_partial_decision(&mut job);
        job.command(dezoomify_engine::UserCommand::AnswerPartial {
            generation,
            decision,
        })
        .expect("answer applies");
        assert!(
            job.snapshot().decision.is_none(),
            "no pending decision after {decision:?}"
        );
        let err = job
            .command(dezoomify_engine::UserCommand::AnswerPartial {
                generation,
                decision,
            })
            .unwrap_err();
        // Retry/Keep leave the job live (none-pending rejection); Discard
        // ends terminal (post-terminal rejection). Either way the decided
        // payload is gone and the same generation never answers twice.
        assert!(
            err.code == "job.invalid-state" || err.code == "job.post-terminal",
            "replay after {decision:?} is none-pending, got {}",
            err.code
        );
    }
}

/// Selection locks as phases advance: a level cannot precede its image, a
/// decided image cannot change, and a deferred follow cannot run after the
/// image is decided.
#[test]
fn selection_locks_across_phase_exits() {
    let (mut job, _update) = start_dzi();
    // No level before its image: the level payload is unrepresentable while
    // awaiting the image.
    let err = job
        .command(dezoomify_engine::UserCommand::SelectLevel { level: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert!(job.snapshot().selection.level.is_none());

    job.command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .expect("select image");
    // The decided image cannot change: a different image is invalid-state.
    let revision = job.snapshot().revision;
    let err = job
        .command(dezoomify_engine::UserCommand::SelectImage { image: 1 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(job.snapshot().revision, revision);
    assert_eq!(job.snapshot().selection.image, Some(0));
    // Repeating the decided image stays a duplicate acknowledgement.
    job.command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .expect("duplicate ignored");
    // A deferred follow cannot run once the image is decided.
    let err = job
        .command(dezoomify_engine::UserCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");

    let update = job
        .command(dezoomify_engine::UserCommand::SelectLevel { level: 0 })
        .expect("select level");
    assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
    // Past selection the image is frozen: even the decided image repeats
    // only as a duplicate, and anything else is invalid-state.
    job.command(dezoomify_engine::UserCommand::SelectImage { image: 0 })
        .expect("decided image repeats as duplicate");
    let err = job
        .command(dezoomify_engine::UserCommand::SelectLevel { level: 99 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
}

/// Finalization answers are valid only while finalization is pending: tile
/// effects cannot claim publication, and a settled finalize effect goes
/// stale instead of settling twice.
#[test]
fn finalization_answers_require_pending_finalization() {
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    // No finalization is pending during acquisition: publication claims on
    // tile effects are wrong-kind and settle nothing.
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
    let finalize_id = job.outstanding_finalize().expect("finalize live");
    job.complete(
        finalize_id,
        EffectResult::OutputCommitted {
            disposition: OutputDisposition::NativePublication,
        },
    )
    .expect("output committed");
    // Settled finalization cannot settle twice: the second claim is stale.
    let err = job
        .complete(
            finalize_id,
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .unwrap_err();
    assert_eq!(err.code, "job.stale-effect");
}

/// Probe and ordinary tile answers never cross: a probe observation aimed
/// at an ordinary tile effect is wrong-kind, and with no probe flight live
/// nothing probe-shaped is answerable.
#[test]
fn probe_and_tile_answers_never_cross() {
    let (mut job, _update) = start_dzi();
    let update = select_largest(&mut job);
    let ids = tile_ids(&update);
    let revision = job.snapshot().revision;
    let err = job
        .complete(ids[0], EffectResult::ProbeMissing)
        .unwrap_err();
    assert_eq!(err.code, "job.wrong-result-kind");
    assert_eq!(job.snapshot().revision, revision);
    // The tile effect survived the wrong-kind probe answer.
    job.complete(ids[0], EffectResult::TileAcquired)
        .expect("tile still completable");
    let kinds: Vec<bool> = update
        .tile_effects()
        .iter()
        .map(|e| matches!(e, Effect::AcquireTile { probe: true, .. }))
        .collect();
    assert!(
        kinds.iter().all(|probe| !probe),
        "grid plan carries no probe flight"
    );
}
