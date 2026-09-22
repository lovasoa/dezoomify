use dezoomify::engine::{DiscoveryInput, EngineJob, JobOptions, ResponseMetadata, SelectionPolicy};
use dezoomify::model::{HostEffect as Effect, JobState, Terminal};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

const BULK: &[u8] = b"https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn native_options(input: DiscoveryInput) -> JobOptions {
    let mut options = JobOptions::new(vec![input]);
    options.selection = SelectionPolicy::NativeAutomatic {
        image_index: 0,
        largest: false,
        max_width: None,
        max_height: None,
        zoom_level: None,
    };
    options
}

fn discovered_dzi(
    largest: bool,
    max_width: Option<u32>,
    max_height: Option<u32>,
    zoom_level: Option<usize>,
) -> dezoomify::engine::Update {
    let mut options = native_options(DiscoveryInput::with_contents(
        "https://example.test/image.dzi",
        DZI,
    ));
    options.selection = SelectionPolicy::NativeAutomatic {
        image_index: 0,
        largest,
        max_width,
        max_height,
        zoom_level,
    };
    let (_, update) = EngineJob::start(options).expect("start and select");
    update
}

#[test]
fn native_zoom_level_precedes_largest_and_caps_and_clamps_to_last() {
    let exact = discovered_dzi(true, Some(64), Some(64), Some(3));
    assert_eq!(exact.snapshot.lifecycle, JobState::AcquiringTiles);
    assert_eq!(exact.snapshot.selection.level, Some(3));

    let clamped = discovered_dzi(false, None, None, Some(usize::MAX));
    assert_eq!(clamped.snapshot.lifecycle, JobState::AcquiringTiles);
    assert_eq!(
        clamped.snapshot.selection.level,
        Some(clamped.snapshot.selection.level_count - 1)
    );
}

#[test]
fn native_largest_bypasses_caps_and_default_selects_max_area() {
    let largest = discovered_dzi(true, Some(64), Some(64), None);
    let default = discovered_dzi(false, None, None, None);
    let last = largest.snapshot.selection.level_count - 1;
    assert_eq!(largest.snapshot.selection.level, Some(last));
    assert_eq!(default.snapshot.selection.level, Some(last));
}

#[test]
fn native_caps_choose_largest_fit_and_fallback_to_smallest_width() {
    let fitting = discovered_dzi(false, Some(128), Some(96), None);
    assert_eq!(fitting.snapshot.selection.level, Some(6));

    let fallback = discovered_dzi(false, Some(0), None, None);
    assert_eq!(fallback.snapshot.selection.level, Some(0));
}

#[test]
fn native_image_index_clamps_and_follows_deferred_entry_in_same_job() {
    let mut options = native_options(DiscoveryInput::new("https://example.test/list.txt"));
    options.selection = SelectionPolicy::NativeAutomatic {
        image_index: usize::MAX,
        largest: false,
        max_width: None,
        max_height: None,
        zoom_level: None,
    };
    let (mut job, started) = EngineJob::start(options).expect("start");
    let metadata = started.metadata_effects()[0]
        .correlation()
        .expect("correlated effect");
    let deferred = job
        .provide_metadata(metadata, ResponseMetadata::new(), BULK)
        .expect("bulk catalog");
    assert_eq!(deferred.snapshot.lifecycle, JobState::Discovering);
    let follow_uri = deferred
        .effects
        .iter()
        .find_map(|effect| match effect {
            Effect::AcquireResource { request } => Some(request.uri.as_str()),
            _ => None,
        })
        .expect("same-job deferred fetch");
    assert_eq!(follow_uri, "https://example.test/b.dzi");
    assert_eq!(deferred.snapshot.revision, started.snapshot.revision + 1);

    let follow = deferred.metadata_effects()[0]
        .correlation()
        .expect("correlated effect");
    let selected = job
        .provide_metadata(follow, ResponseMetadata::new(), DZI)
        .expect("resolved catalog");
    assert_eq!(selected.snapshot.revision, deferred.snapshot.revision + 1);
    assert_eq!(selected.snapshot.lifecycle, JobState::AcquiringTiles);
    assert_eq!(selected.snapshot.selection.image, Some(0));
    assert_eq!(
        selected.snapshot.selection.level,
        Some(selected.snapshot.selection.level_count - 1)
    );
}

#[test]
fn native_deferred_follow_rejection_keeps_typed_failure() {
    let mut options = native_options(DiscoveryInput::new("https://example.test/list.txt"));
    options.max_deferred_follows = 0;
    let (mut job, started) = EngineJob::start(options).expect("start");
    let metadata = started.metadata_effects()[0]
        .correlation()
        .expect("correlated effect");
    let update = job
        .provide_metadata(metadata, ResponseMetadata::new(), BULK)
        .expect("typed terminal failure");
    let Some(Terminal::Failed { error }) = update.snapshot.terminal else {
        panic!("expected failed terminal");
    };
    assert_eq!(error.code, "discovery.deferred");
}
