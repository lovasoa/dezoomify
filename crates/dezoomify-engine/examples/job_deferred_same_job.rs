//! Deferred catalog entries resolve inside the same job: following a
//! still-deferred entry fetches its URI with a bounded, cycle-guarded
//! budget and replaces the catalog. No new job is ever created.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectResult, EngineJob, JobOptions, Lifecycle, OutputDisposition,
    UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const BULK_LIST: &[u8] = b"https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn main() {
    let options = JobOptions::new(vec![DiscoveryInput::with_contents(
        "https://example.test/list.txt",
        BULK_LIST.to_vec(),
    )]);
    let (mut job, update) = EngineJob::start(options).expect("valid options");
    assert!(
        update.metadata_effects().is_empty(),
        "inline bytes need no fetch"
    );
    assert_eq!(update.snapshot.selection.deferred.len(), 2);

    let update = job
        .command(UserCommand::FollowDeferred { image: 0 })
        .expect("same-job follow");
    let follow = update.metadata_effects();
    assert_eq!(follow.len(), 1);
    let Effect::AcquireMetadata { uri, .. } = follow[0] else {
        panic!("follow issues a metadata effect");
    };
    assert_eq!(uri, "https://example.test/a.dzi");

    let update = job
        .provide_metadata(
            follow[0].id(),
            dezoomify_engine::ResponseMetadata::new(),
            DZI,
        )
        .expect("followed bytes");
    assert!(
        update.snapshot.selection.deferred.is_empty(),
        "catalog replaced in place"
    );

    let update = job
        .command(UserCommand::SelectImage { image: 0 })
        .expect("select image");
    let level = update.snapshot.selection.level_count - 1;
    let update = job
        .command(UserCommand::SelectLevel { level })
        .expect("select level");
    let tiles: Vec<_> = update.tile_effects().iter().map(|e| e.id()).collect();
    assert_eq!(tiles.len(), 4);
    let mut update = update;
    for id in tiles {
        update = job
            .complete(id, EffectResult::TileAcquired)
            .expect("tile done");
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
    eprintln!("deferred: one job id from list input to terminal");
}
