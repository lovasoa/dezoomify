//! Display-only acquisition: the host shows tiles as ordinary images
//! with no readable bytes, so every tile acknowledges with zero body
//! bytes. The output commits with the display-only disposition, honestly
//! recording that no output file exists.

use dezoomify_engine::{
    DiscoveryInput, EffectResult, EngineJob, JobOptions, Lifecycle, OutputDisposition, UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

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
    let tiles: Vec<_> = update.tile_effects().iter().map(|e| e.id()).collect();
    assert_eq!(tiles.len(), 4);

    // Ordinary image display: no readable bytes cross for any tile.
    let mut update = update;
    for id in tiles {
        update = job
            .complete(id, EffectResult::TileDisplayed)
            .expect("displayed");
    }
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Finalizing);
    let finalize = update.finalize_effects();
    let update = job
        .complete(
            finalize[0].id(),
            EffectResult::OutputCommitted {
                disposition: OutputDisposition::DisplayOnly,
            },
        )
        .expect("display committed");
    assert_eq!(update.snapshot.lifecycle, Lifecycle::Completed);
    let output = update.snapshot.output.expect("output summary");
    assert_eq!(output.disposition, Some(OutputDisposition::DisplayOnly));
    eprintln!("display-only: 4 tiles x 0 body bytes, display-only disposition");
}
