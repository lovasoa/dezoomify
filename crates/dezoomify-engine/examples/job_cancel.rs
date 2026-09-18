//! Cancellation releases kept resources exactly once through one
//! idempotent release effect. Cancel before the output commit rests the
//! job cancelled; cancel after the commit is rejected because the job is
//! already terminal.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectResult, EngineJob, JobOptions, Lifecycle, OutputDisposition,
    UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn drive_to_tiles() -> (EngineJob, dezoomify_engine::Update) {
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
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);
    (job, update)
}

fn main() {
    // Cancel before commit: one release effect, cancelled terminal, and the
    // acknowledgement settles idempotently.
    let (mut job, update) = drive_to_tiles();
    let tiles: Vec<_> = update.tile_effects().iter().map(|e| e.id()).collect();
    let _ = job
        .complete(tiles[0], EffectResult::TileAcquired)
        .expect("one tile");
    let update = job.command(UserCommand::Cancel).expect("cancel");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Cancelled);
    let releases: Vec<_> = update
        .effects
        .iter()
        .filter(|e| matches!(e, Effect::CancelRelease { .. }))
        .collect();
    assert_eq!(releases.len(), 1, "exactly one release");
    let update = job
        .complete(releases[0].id(), EffectResult::CleanupAcknowledged)
        .expect("cleanup ack");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Cancelled);
    let late = job
        .complete(tiles[1], EffectResult::TileAcquired)
        .unwrap_err();
    assert_eq!(late.code, "job.post-terminal");

    // Cancel after commit: the late cancel is rejected as post-terminal.
    let (mut job, update) = drive_to_tiles();
    let tiles: Vec<_> = update.tile_effects().iter().map(|e| e.id()).collect();
    let mut update = update;
    for id in tiles {
        update = job
            .complete(id, EffectResult::TileAcquired)
            .expect("tile done");
    }
    let finalize = update.finalize_effects();
    update = job
        .complete(
            finalize[0].id(),
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Completed);
    let late = job.command(UserCommand::Cancel).unwrap_err();
    assert_eq!(late.code, "job.post-terminal");
    eprintln!("cancel: one release before commit, post-terminal cancel rejected after commit");
}
