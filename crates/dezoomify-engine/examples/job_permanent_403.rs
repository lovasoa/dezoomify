//! A permanent refusal (HTTP 403) settles its tile after exactly one
//! attempt: no timer effect, no re-acquisition. Siblings still complete,
//! and only then does the partial decision arrive with the refusal detail.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectId, EffectResult, EngineJob, Failure, JobOptions, Lifecycle,
    OutputDisposition, PartialDecision, UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn refused() -> Failure {
    Failure {
        code: "TRANSPORT_HTTP_ERROR".to_string(),
        http: Some(403),
        retry_after_ms: None,
        transport: None,
        detail: None,
    }
}

fn main() {
    let options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")]);
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
    let tiles: Vec<(EffectId, u32)> = update
        .tile_effects()
        .iter()
        .map(|e| match e {
            Effect::AcquireTile { id, tile, .. } => (*id, *tile),
            other => panic!("expected tile effect, got {other:?}"),
        })
        .collect();
    assert_eq!(tiles.len(), 4);

    // The 403 refusal settles tile 0 with no timer and no re-acquisition.
    let update = job
        .complete(tiles[0].0, EffectResult::TileFailed(refused()))
        .expect("403");
    assert!(update
        .effects
        .iter()
        .all(|e| !matches!(e, Effect::WaitRetryTimer { .. })));
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);

    // Siblings complete; only then does the decision arrive.
    let mut update = update;
    for (id, _) in tiles.iter().skip(1) {
        update = job
            .complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(
        update.snapshot.lifecycle,
        Lifecycle::AwaitingPartialDecision
    );
    let decision = update.snapshot.decision.expect("partial decision");
    assert_eq!(decision.missing.len(), 1);
    assert_eq!(decision.missing[0].0, tiles[0].1);
    assert_eq!(decision.missing[0].1[0].http, Some(403));

    let update = job
        .command(UserCommand::AnswerPartial {
            decision: PartialDecision::Keep,
        })
        .expect("keep partial");
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
    assert!(matches!(
        update.snapshot.terminal,
        Some(dezoomify_engine::Terminal::PartiallyCompleted { .. })
    ));
    eprintln!("403: 1 attempt, 0 timers, 0 re-acquisitions, partial output");
}
