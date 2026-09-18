//! Acquisition settles before the partial decision: failures stash while
//! siblings are in flight, late successes still count, and the decision
//! carries the complete missing list. Answering retry requeues exactly the
//! failed tiles with a fresh attempt budget and preserves successes.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectResult, EngineJob, Failure, JobOptions, Lifecycle,
    OutputDisposition, PartialDecision, UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn main() {
    let mut options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")]);
    options.max_retries = 0;
    let (mut job, update) = EngineJob::start(options).expect("valid options");
    let id = update.metadata_effects()[0].id();
    let update = job
        .provide_metadata(id, dezoomify_engine::ResponseMetadata::new(), DZI)
        .expect("metadata bytes");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AwaitingImageSelection);
    let update = job
        .command(UserCommand::SelectImage { image: 0 })
        .expect("select image");
    let level = update.snapshot.selection.level_count - 1;
    let update = job
        .command(UserCommand::SelectLevel { level })
        .expect("select level");
    let tiles: Vec<_> = update
        .tile_effects()
        .iter()
        .map(|e| {
            (
                e.id(),
                match e {
                    Effect::AcquireTile { tile, .. } => *tile,
                    other => panic!("expected tile effect, got {other:?}"),
                },
            )
        })
        .collect();
    assert_eq!(tiles.len(), 4);

    // First failure with siblings in flight: stashed, not decided.
    let mut update = job
        .complete(
            tiles[0].0,
            EffectResult::TileFailed(Failure::new("TRANSPORT_TIMEOUT")),
        )
        .expect("first failure");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);

    // A late success still counts.
    update = job
        .complete(tiles[1].0, EffectResult::TileAcquired)
        .expect("late success");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);

    // A second failure joins the stash; the last success settles the round
    // and only then does the decision carry the complete missing list.
    update = job
        .complete(
            tiles[2].0,
            EffectResult::TileFailed(Failure {
                code: "TRANSPORT_HTTP_ERROR".to_string(),
                http: Some(403),
                retry_after_ms: None,
                transport: None,
                detail: None,
            }),
        )
        .expect("second failure");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);
    update = job
        .complete(tiles[3].0, EffectResult::TileAcquired)
        .expect("last success");
    assert_eq!(
        update.snapshot.lifecycle,
        Lifecycle::AwaitingPartialDecision
    );
    let mut missing: Vec<u32> = update
        .snapshot
        .decision
        .as_ref()
        .expect("decision")
        .missing
        .iter()
        .map(|(t, _)| *t)
        .collect();
    missing.sort_unstable();
    assert_eq!(missing, vec![tiles[0].1, tiles[2].1]);

    // Retry requeues exactly the failed tiles; successes are never re-fetched.
    update = job
        .command(UserCommand::AnswerPartial {
            decision: PartialDecision::Retry,
        })
        .expect("retry partial");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);
    assert_eq!(update.tile_effects().len(), 2, "only failed tiles requeue");
    for effect in update.effects.clone() {
        if let Effect::AcquireTile { id, .. } = effect {
            update = job
                .complete(id, EffectResult::TileAcquired)
                .expect("requeued done");
        }
    }
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Finalizing);
    let finalize = update.finalize_effects();
    let update = job
        .complete(
            finalize[0].id(),
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert!(update.snapshot.terminal.is_some_and(|t| t.completed()));
    eprintln!("partial: 2 stashed failures, decision after settle, 2 requeued, full output");
}
