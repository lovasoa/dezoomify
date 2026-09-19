mod support;

use dezoomify_engine::{Config, DiscoveryInput, Effect, RecoveryChoice};
use support::JobCommand;
use support::ScriptedHost;

fn job_id(n: u32) -> String {
    format!("job:{n}")
}

const INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn test_config() -> Config {
    Config::default()
}

/// Provide the DZI document for the outstanding discovery request and
/// Select the first image's last (largest) level. Returns its position.
fn discover_and_select(host: &mut ScriptedHost, _id: u32) -> u32 {
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    assert!(!levels.is_empty());
    host.apply(JobCommand::SelectImage { image }).unwrap();
    let level = *levels.last().expect("level");
    host.apply(JobCommand::SelectLevel { level }).unwrap();
    level
}

#[test]
fn ordered_inputs_fall_back_to_the_next_url_root() {
    let fallback = "https://example.test/fallback.dzi";
    let mut host = ScriptedHost::new_with_inputs(
        vec![
            DiscoveryInput::with_contents(
                "https://example.test/page",
                b"<html>not a viewer</html>",
            ),
            DiscoveryInput::new(fallback),
        ],
        test_config(),
    )
    .unwrap();
    host.start().unwrap();
    assert_eq!(host.state(), "Discovering");
    assert!(host.effects.iter().any(|effect| match effect {
        Effect::AcquireMetadata { uri, .. } => uri == fallback,
        _ => false,
    }));
}

#[test]
fn successful_finalization_completes() {
    let mut host = ScriptedHost::new(&job_id(2), INPUT_URL, test_config()).unwrap();
    let _level_id = discover_and_select(&mut host, 2);
    assert_eq!(host.state(), "AcquiringTiles");

    // The largest 512x512 level with 256px tiles is a 2x2 grid.
    let tiles = host.tile_effects();
    assert_eq!(tiles.len(), 4, "tile effects: {tiles:?}");

    let planned: Vec<u32> = tiles.into_iter().map(|(tile, _, _)| tile).collect();
    for tile in &planned {
        host.apply(JobCommand::TileAcquired { tile: *tile })
            .unwrap();
    }

    assert_eq!(host.state(), "Finalizing");
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_kind().as_deref(), Some("completed"));
}

#[test]
fn keeping_a_partial_result_decodes_only_acquired_tiles() {
    let mut config = test_config();
    config.max_retries = 0;
    let mut host = ScriptedHost::new(&job_id(20), INPUT_URL, config).unwrap();
    let _level_id = discover_and_select(&mut host, 20);
    let planned: Vec<u32> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();

    host.apply(JobCommand::TileAcquired { tile: planned[0] })
        .unwrap();
    host.apply(JobCommand::TileFailed {
        tile: planned[1],
        failure: dezoomify_engine::TileFailure::new("TRANSPORT_TIMEOUT", None, None, None),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    host.apply(JobCommand::TileAcquired { tile: planned[2] })
        .unwrap();
    host.apply(JobCommand::TileAcquired { tile: planned[3] })
        .unwrap();
    assert_eq!(host.state(), "AwaitingPartialDecision");

    host.apply(JobCommand::RecoveryChoice {
        generation: 0,
        choice: RecoveryChoice::Keep,
    })
    .unwrap();

    assert!(host
        .effects
        .iter()
        .any(|effect| { matches!(effect, Effect::FinalizeOutput { partial: true, .. }) }));
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "PartiallyCompleted");
    assert_eq!(host.terminal_kind().as_deref(), Some("partial-completed"));
}

#[test]
fn cancel_in_acquiring_tiles_ignores_late_response() {
    let mut host = ScriptedHost::new(&job_id(3), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 3);
    let tiles: Vec<u32> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    host.apply(JobCommand::TileAcquired { tile: tiles[0] })
        .unwrap();

    assert_eq!(host.state(), "AcquiringTiles");
    host.apply(JobCommand::Cancel).unwrap();
    assert_eq!(host.state(), "Cancelled");

    // Late tile outcome after cancellation is stably rejected with no work.
    let late = host.apply(JobCommand::TileAcquired { tile: tiles[1] });
    assert!(late.is_err());
    assert_eq!(late.unwrap_err().code, "job.post-terminal");
    assert_eq!(host.state(), "Cancelled");
}

#[test]
fn pause_suspends_new_tiles_and_resume_redrives() {
    // Pause keeps progress: in-flight finishes, decoded output is retained,
    // resume re-drives to completion.
    let mut host = ScriptedHost::new(&job_id(6), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 6);
    assert_eq!(host.state(), "AcquiringTiles");
    assert!(!host.is_paused());
    let planned: Vec<u32> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    assert_eq!(planned.len(), 4);
    let effects_before = host.effects.len();
    host.apply(JobCommand::Pause).unwrap();
    assert!(host.is_paused());
    assert_eq!(host.effects.len(), effects_before);
    // In-flight tile finishes while paused: progress is recorded, but no new
    // tile is scheduled and completion is deferred.
    host.apply(JobCommand::TileAcquired { tile: planned[0] })
        .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    assert!(host.is_paused());
    assert_eq!(host.tile_effects().len(), 4);
    // Resume re-drives the pending queue.
    host.apply(JobCommand::Resume).unwrap();
    assert!(!host.is_paused());
    for tile in planned.iter().skip(1) {
        host.apply(JobCommand::TileAcquired { tile: *tile })
            .unwrap();
    }
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
}
