//! Metadata to terminal trace: discovery, selection, acquisition,
//! finalization, completion. Every planned tile succeeds on its first
//! attempt and the job completes with full output.

use dezoomify_engine::{
    DiscoveryInput, EffectId, EffectResult, EngineJob, JobOptions, Lifecycle, OutputDisposition,
    UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn main() {
    let options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")]);
    let (mut job, update) = EngineJob::start(options).expect("valid options");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Discovering);
    let metadata: Vec<EffectId> = update.metadata_effects().iter().map(|e| e.id()).collect();
    assert_eq!(metadata.len(), 1);

    let update = job
        .provide_metadata(metadata[0], dezoomify_engine::ResponseMetadata::new(), DZI)
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

    let tiles: Vec<EffectId> = update.tile_effects().iter().map(|e| e.id()).collect();
    assert_eq!(tiles.len(), 4, "largest level is a 2x2 grid");
    let mut update = update;
    for id in tiles {
        update = job
            .complete(id, EffectResult::TileAcquired)
            .expect("tile done");
    }
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Finalizing);
    let finalize: Vec<EffectId> = update.finalize_effects().iter().map(|e| e.id()).collect();
    assert_eq!(finalize.len(), 1);

    let update = job
        .complete(
            finalize[0],
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::NativePublication,
            },
        )
        .expect("output committed");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Completed);
    assert!(update.snapshot.terminal.is_some_and(|t| t.completed()));
    let output = update.snapshot.output.expect("output summary");
    assert!(output.complete && output.missing.is_empty());
    eprintln!("happy path: 4 tiles x 1 attempt, complete output");
}
