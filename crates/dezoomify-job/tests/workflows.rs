mod support;

use dezoomify_job::{Config, JobResponse};
use support::ScriptedHost;

fn job_id(n: u32) -> String {
    format!("job:{n}")
}

const INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The core parses it into a deepzoom catalog with ten grid levels; the
/// largest carries four tiles with deterministic `image_files` URIs.
const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn test_config() -> Config {
    Config::default()
}

/// Provide the DZI document for the outstanding discovery request and
/// select the first image's last (largest) level. Returns the level id.
fn discover_and_select(host: &mut ScriptedHost, id: u32) -> String {
    host.start().unwrap();
    host.apply(JobResponse::ResourceBytes {
        job: job_id(id),
        request: "req:0".to_string(),
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    let (image_id, level_ids) = host.catalog().expect("catalog event");
    assert!(image_id.starts_with("img:"), "wire image id: {image_id}");
    assert!(!level_ids.is_empty());
    host.apply(JobResponse::SelectedImage {
        job: job_id(id),
        image: image_id,
    })
    .unwrap();
    let level_id = level_ids.last().expect("level").clone();
    host.apply(JobResponse::SelectedLevel {
        job: job_id(id),
        level: level_id.clone(),
    })
    .unwrap();
    level_id
}

#[test]
fn discover_success_minimal() {
    let mut host = ScriptedHost::new(&job_id(1), INPUT_URL, test_config()).unwrap();
    host.start().unwrap();
    assert_eq!(host.state(), "Discovering");
    host.apply(JobResponse::ResourceBytes {
        job: job_id(1),
        request: "req:0".to_string(),
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();

    assert_eq!(host.state(), "AwaitingImageSelection");
    assert_eq!(host.terminal_count(), 0);
    // No background work: queues are drained after every step.
    assert_eq!(host.job().pending_effect_count(), 0);
    assert_eq!(host.job().pending_event_count(), 0);

    // The catalog event carries the real projected catalog: a deepzoom
    // image whose levels each declare exact geometry.
    let (image_id, level_ids) = host.catalog().expect("catalog event");
    assert_eq!(image_id, "img:dzi:0");
    assert!(level_ids.len() >= 2, "levels: {level_ids:?}");
    let catalog_event = host
        .events
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("catalog"))
        .expect("catalog event");
    let image = &catalog_event["images"][0];
    assert_eq!(image["format"], "deepzoom");
    assert_eq!(image["readiness"], "ready");
    assert_eq!(image["width"], 512);
    assert_eq!(image["height"], 512);
    assert_eq!(image["sourceKind"], "grid");
    let level = &image["levels"][0];
    // Core normalizes levels to ascending size: the first entry is the
    // smallest level (highest ordinal), the last is the largest.
    assert_eq!(level["id"], "lvl:dzi:0:9");
    assert_eq!(level["tileWidth"], 256);

    // The discovery fetch effect targets the input URL with metadata purpose.
    assert!(host.effects.iter().any(|effect| {
        effect.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource")
            && effect.get("uri").and_then(serde_json::Value::as_str) == Some(INPUT_URL)
            && effect.get("purpose").and_then(serde_json::Value::as_str) == Some("metadata")
    }));

    let transcript = host.transcript();
    for phase in ["Discovering", "AwaitingImageSelection"] {
        let prefix = format!("event:job-state:{phase}:seq:");
        assert!(
            transcript.iter().any(|line| line.starts_with(&prefix)),
            "missing job-state event for {phase}: {transcript:?}"
        );
    }
    assert!(seqs_are_sorted(transcript));
}

#[test]
fn destination_grant_flow_completes() {
    let mut host = ScriptedHost::new(&job_id(2), INPUT_URL, test_config()).unwrap();
    let _level_id = discover_and_select(&mut host, 2);
    assert_eq!(host.state(), "AwaitingDestination");
    host.apply(JobResponse::DestinationGranted {
        job: job_id(2),
        destination: "dst:0".to_string(),
    })
    .unwrap();

    // The largest 512x512 level with 256px tiles is a real 2x2 grid.
    let tiles = host.tile_effects();
    assert_eq!(tiles.len(), 4, "tile effects: {tiles:?}");
    assert!(tiles.iter().all(|(tile, uri, probe)| {
        tile.starts_with("tile:") && uri.starts_with("https://example.test/image_files/") && !probe
    }));
    assert!(
        tiles.iter().all(|(_, uri, _)| uri.ends_with(".jpg")),
        "tile URIs carry the DZI format: {tiles:?}"
    );

    // Respond with the real planned tile ids.
    let planned: Vec<String> = tiles.into_iter().map(|(tile, _, _)| tile).collect();
    for tile in &planned {
        host.apply(JobResponse::TileOutcome {
            job: job_id(2),
            tile: tile.clone(),
            ok: true,
        })
        .unwrap();
    }

    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
    assert_eq!(host.job().terminal_kind(), Some("completed"));
    assert_eq!(host.job().pending_effect_count(), 0);
    assert_eq!(host.job().pending_event_count(), 0);

    let transcript = host.transcript();
    for phase in [
        "Planning",
        "AcquiringTiles",
        "ProcessingTiles",
        "Encoding",
        "Finalizing",
        "Publishing",
        "CleaningUp",
        "Completed",
    ] {
        let prefix = format!("event:job-state:{phase}:seq:");
        assert!(
            transcript.iter().any(|line| line.starts_with(&prefix)),
            "missing job-state event for {phase}: {transcript:?}"
        );
    }
    assert!(transcript.contains(&"state:AcquiringTiles".to_string()));
    assert!(transcript.contains(&"state:Completed".to_string()));
    assert_eq!(
        transcript
            .iter()
            .filter(|line| line.starts_with("event:completed:"))
            .count(),
        1
    );
    assert!(seqs_are_sorted(transcript));
    assert!(transcript.len() >= 30);
    // Progress reported the real plan size.
    assert!(host.events.iter().any(|event| {
        event.get("kind").and_then(serde_json::Value::as_str) == Some("progress")
            && event.get("total").and_then(serde_json::Value::as_u64) == Some(4)
            && event.get("acquired").and_then(serde_json::Value::as_u64) == Some(0)
    }));
}

#[test]
fn keeping_a_partial_result_decodes_only_acquired_tiles() {
    let mut config = test_config();
    config.max_retries = 0;
    let mut host = ScriptedHost::new(&job_id(20), INPUT_URL, config).unwrap();
    let _level_id = discover_and_select(&mut host, 20);
    host.apply(JobResponse::DestinationGranted {
        job: job_id(20),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    let planned: Vec<String> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();

    host.apply(JobResponse::TileOutcome {
        job: job_id(20),
        tile: planned[0].clone(),
        ok: true,
    })
    .unwrap();
    host.apply(JobResponse::TileOutcome {
        job: job_id(20),
        tile: planned[1].clone(),
        ok: false,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingPartialDecision");

    host.apply(JobResponse::PartialKeep {
        job: job_id(20),
        keep: true,
    })
    .unwrap();

    let decoded: Vec<&str> = host
        .effects
        .iter()
        .filter(|effect| {
            effect.get("kind").and_then(serde_json::Value::as_str) == Some("decode-pixels")
        })
        .filter_map(|effect| effect.get("tile").and_then(serde_json::Value::as_str))
        .collect();
    assert_eq!(decoded, vec![planned[0].as_str()]);
    assert_eq!(host.state(), "PartiallyCompleted");
    assert_eq!(host.job().terminal_kind(), Some("partial-completed"));
}

#[test]
fn cancel_in_acquiring_tiles_ignores_late_response() {
    let mut host = ScriptedHost::new(&job_id(3), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 3);
    host.apply(JobResponse::DestinationGranted {
        job: job_id(3),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    let tiles: Vec<String> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    host.apply(JobResponse::TileOutcome {
        job: job_id(3),
        tile: tiles[0].clone(),
        ok: true,
    })
    .unwrap();

    assert_eq!(host.state(), "AcquiringTiles");
    host.apply(JobResponse::Cancel { job: job_id(3) }).unwrap();
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.terminal_count(), 1);

    let len_after_cancel = host.transcript().len();
    // Late tile outcome after cancellation is stably rejected with no work.
    let late = host.apply(JobResponse::TileOutcome {
        job: job_id(3),
        tile: tiles[1].clone(),
        ok: true,
    });
    assert!(late.is_err());
    assert_eq!(late.unwrap_err().code, "job.post-terminal");
    assert_eq!(host.state(), "Cancelled");
    assert_eq!(host.transcript().len(), len_after_cancel);
    assert_eq!(host.terminal_count(), 1);
    for phase in ["Cancelling", "CleaningUp", "Cancelled"] {
        let prefix = format!("event:job-state:{phase}:seq:");
        assert!(
            host.transcript()
                .iter()
                .any(|line| line.starts_with(&prefix)),
            "missing job-state event for {phase}"
        );
    }
    assert!(host.transcript().contains(&"state:Cancelled".to_string()));
}

#[test]
fn probe_driven_generic_level_resolves_through_observations() {
    // A generic template URL drives the core's probe step machine: the
    // host observes tile geometry and the plan resolves into a real grid.
    // In-area probes return full 256px tiles; outside probes return the
    // 1x1 placeholder shape, which the core treats as missing.
    const TEMPLATE: &str = "https://example.test/generic/placeholder.svg?x={{X}}&y={{Y}}";
    let mut host = ScriptedHost::new(&job_id(4), TEMPLATE, test_config()).unwrap();
    host.start().unwrap();
    // Generic templates are immediate: discovery completes at start.
    let (image_id, level_ids) = host.catalog().expect("catalog event");
    assert_eq!(image_id, "img:generic:image");
    assert_eq!(level_ids, vec!["lvl:generic:level".to_string()]);
    host.apply(JobResponse::SelectedImage {
        job: job_id(4),
        image: image_id,
    })
    .unwrap();
    host.apply(JobResponse::SelectedLevel {
        job: job_id(4),
        level: "lvl:generic:level".to_string(),
    })
    .unwrap();
    host.apply(JobResponse::DestinationGranted {
        job: job_id(4),
        destination: "dst:0".to_string(),
    })
    .unwrap();

    // Answer every probe according to its coordinates until the plan
    // resolves into ordinary tile acquisition.
    let mut rounds = 0;
    while host.state() == "Planning" {
        rounds += 1;
        assert!(rounds <= 256, "probe loop did not resolve");
        let probe = host
            .tile_effects()
            .into_iter()
            .rfind(|(_, _, probe)| *probe)
            .expect("outstanding probe");
        let (tile, uri) = (probe.0, probe.1);
        let query = uri.split_once('?').expect("probe uri query").1;
        let mut coordinates = query
            .split('&')
            .map(|part| part.split_once('=').unwrap().1.parse::<u32>().unwrap());
        let x = coordinates.next().unwrap();
        let y = coordinates.next().unwrap();
        // In-area probes return real tiles; the 1x1 placeholder shape is
        // how the fixture marks missing tiles.
        let (width, height) = if x < 2 && y < 2 { (256, 256) } else { (1, 1) };
        host.apply(JobResponse::ProbeOutcome {
            job: job_id(4),
            tile,
            available: true,
            width,
            height,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "AcquiringTiles");
    let planned: Vec<(String, String, bool)> = host
        .tile_effects()
        .into_iter()
        .filter(|(_, _, probe)| !*probe)
        .collect();
    assert_eq!(planned.len(), 4, "resolved 2x2 grid: {planned:?}");
    assert!(
        planned
            .iter()
            .all(|(tile, uri, _)| tile.starts_with("tile:")
                && uri.starts_with("https://example.test/generic/placeholder.svg?x=")),
        "planned URIs follow the template: {planned:?}"
    );
}

/// Regression: core discovery is a poll - the same request stays
/// outstanding until its outcome arrives. The engine must emit exactly
/// one acquire-resource effect per outstanding request and return;
/// looping on the poll until it yields `None` would allocate without
/// bound and freeze the host. Pin the bounded shape of `start()`.
#[test]
fn discovery_poll_emits_one_effect_per_outstanding_request() {
    fn acquire_resource_count(host: &ScriptedHost) -> usize {
        host.effects
            .iter()
            .filter(|v| {
                v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource")
            })
            .count()
    }
    let mut host = ScriptedHost::new(&job_id(5), INPUT_URL, test_config()).unwrap();
    host.start().unwrap();
    // The DZI input has exactly one outstanding metadata fetch.
    assert_eq!(
        acquire_resource_count(&host),
        1,
        "one effect per outstanding core request"
    );
    assert_eq!(host.job().pending_effect_count(), 0);
    assert_eq!(host.job().pending_event_count(), 0);
    assert_eq!(host.state(), "Discovering");
    // While the fetch is unanswered nothing new is emitted: the poll
    // reports the same request and the engine waits instead of growing.
    let err = host.apply(JobResponse::TileOutcome {
        job: job_id(5),
        tile: "tile:0".to_string(),
        ok: true,
    });
    assert!(err.is_err());
    assert_eq!(
        acquire_resource_count(&host),
        1,
        "unanswered fetches emit no further effects"
    );
    assert_eq!(host.state(), "Discovering");
}

fn seqs_are_sorted(transcript: &[String]) -> bool {
    let seqs: Vec<u64> = transcript
        .iter()
        .filter_map(|line| line.rsplit(":seq:").next())
        .filter_map(|suffix| suffix.split(':').next())
        .filter_map(|num| num.parse::<u64>().ok())
        .collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    seqs == sorted
}

#[test]
fn pause_suspends_new_tiles_and_resume_redrives() {
    // Pause v1 (suspend-acquisition): pause stops scheduling new tiles,
    // in-flight finishes, decoded output is retained, resume re-drives.
    // The 19 states are unchanged; pause is an orthogonal overlay.
    let mut host = ScriptedHost::new(&job_id(6), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 6);
    host.apply(JobResponse::DestinationGranted {
        job: job_id(6),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    assert!(!host.job().is_paused());
    let planned: Vec<String> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    assert_eq!(planned.len(), 4);
    // Pause before any tile completes: no new effects, FIFO preserved.
    let effects_before = host.effects.len();
    host.apply(JobResponse::Pause { job: job_id(6) }).unwrap();
    assert!(host.job().is_paused());
    assert_eq!(host.effects.len(), effects_before);
    assert!(host
        .transcript()
        .iter()
        .any(|line| line.starts_with("event:paused:")));
    // Duplicate pause is Ignored with no new work.
    let len = host.transcript().len();
    let dup = host.apply(JobResponse::Pause { job: job_id(6) }).unwrap();
    assert_eq!(dup, dezoomify_job::Outcome::Ignored);
    assert_eq!(host.transcript().len(), len);
    // In-flight tile finishes while paused: progress is recorded, but no new
    // tile is scheduled and completion is deferred.
    host.apply(JobResponse::TileOutcome {
        job: job_id(6),
        tile: planned[0].clone(),
        ok: true,
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    assert!(host.job().is_paused());
    let tile_effects = host.tile_effects().len();
    assert_eq!(tile_effects, 4, "no new acquire-tile while paused");
    // Resume re-drives the pending queue in FIFO order.
    host.apply(JobResponse::Resume { job: job_id(6) }).unwrap();
    assert!(!host.job().is_paused());
    assert!(host
        .transcript()
        .iter()
        .any(|line| line.starts_with("event:resumed:")));
    // Finish the rest: the job completes with exactly one terminal.
    for tile in planned.iter().skip(1) {
        host.apply(JobResponse::TileOutcome {
            job: job_id(6),
            tile: tile.clone(),
            ok: true,
        })
        .unwrap();
    }
    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
    assert!(seqs_are_sorted(host.transcript()));
}

#[test]
fn pause_defers_completion_until_resume() {
    // All tiles finish while paused: completion waits for resume.
    let mut host = ScriptedHost::new(&job_id(7), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 7);
    host.apply(JobResponse::DestinationGranted {
        job: job_id(7),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    let planned: Vec<String> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    host.apply(JobResponse::Pause { job: job_id(7) }).unwrap();
    for tile in &planned {
        host.apply(JobResponse::TileOutcome {
            job: job_id(7),
            tile: tile.clone(),
            ok: true,
        })
        .unwrap();
    }
    // Every tile arrived but the job stays acquiring while paused.
    assert_eq!(host.state(), "AcquiringTiles");
    assert_eq!(host.terminal_count(), 0);
    host.apply(JobResponse::Resume { job: job_id(7) }).unwrap();
    assert_eq!(host.state(), "Completed");
    assert_eq!(host.terminal_count(), 1);
}

#[test]
fn pause_preserves_retry_wakeup_and_rejects_post_terminal() {
    let mut host = ScriptedHost::new(&job_id(8), INPUT_URL, test_config()).unwrap();
    let _ = discover_and_select(&mut host, 8);
    host.apply(JobResponse::DestinationGranted {
        job: job_id(8),
        destination: "dst:0".to_string(),
    })
    .unwrap();
    let planned: Vec<String> = host
        .tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect();
    // Resume without pause is invalid-state with no work.
    let err = host
        .apply(JobResponse::Resume { job: job_id(8) })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    // Cancel wins while paused; pause afterwards is post-terminal.
    host.apply(JobResponse::Pause { job: job_id(8) }).unwrap();
    host.apply(JobResponse::Cancel { job: job_id(8) }).unwrap();
    assert_eq!(host.state(), "Cancelled");
    let late = host.apply(JobResponse::Pause { job: job_id(8) });
    assert!(late.is_err());
    assert_eq!(late.unwrap_err().code, "job.post-terminal");
    assert_eq!(planned.len(), 4);
}
