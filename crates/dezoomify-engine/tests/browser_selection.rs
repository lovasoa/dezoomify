use dezoomify_engine::{DiscoveryInput, EngineJob, JobOptions, ResponseMetadata, SelectionPolicy};
use dezoomify_protocol::dto::JobState;

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const BULK: &[u8] = b"https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn browser_options() -> JobOptions {
    let mut options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/list.txt")]);
    options.selection = SelectionPolicy::BrowserLargestFitting {
        max_width: 128,
        max_height: 128,
        max_area: 128 * 128,
    };
    options
}

#[test]
fn browser_policy_follows_deferred_catalog_and_selects_a_fitting_level_in_place() {
    let (mut job, update) = EngineJob::start(browser_options()).expect("start");
    let initial_id = update.metadata_effects()[0].id();
    let update = job
        .provide_metadata(initial_id, ResponseMetadata::new(), BULK)
        .expect("bulk catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::Discovering);
    let follow = update.metadata_effects();
    assert_eq!(
        follow.len(),
        1,
        "same job starts one deferred metadata fetch"
    );

    let update = job
        .provide_metadata(follow[0].id(), ResponseMetadata::new(), DZI)
        .expect("followed catalog");
    assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
    assert_eq!(update.snapshot.selection.image, Some(0));

    assert_eq!(
        update.snapshot.selection.level,
        Some(7),
        "128px is the largest fitting DZI level"
    );
    let tiles = update.tile_effects();
    assert_eq!(tiles.len(), 1, "the selected level is one 128px tile");
    let dezoomify_engine::Effect::AcquireTile { uri, canvas, .. } = tiles[0] else {
        panic!("expected an acquire-tile effect");
    };
    assert!(uri.contains("_files/7/"), "selected DZI path: {uri}");
    assert_eq!(canvas.map(|size| size.width), Some(128));
}

#[test]
fn browser_policy_rejects_zero_canvas_limits_before_starting() {
    let mut options = browser_options();
    options.selection = SelectionPolicy::BrowserLargestFitting {
        max_width: 128,
        max_height: 128,
        max_area: 0,
    };
    let error = EngineJob::start(options).unwrap_err();
    assert_eq!(error.code, "job.invalid-options");
}
