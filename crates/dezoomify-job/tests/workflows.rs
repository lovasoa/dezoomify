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
    assert_eq!(image["source_kind"], "grid");
    let level = &image["levels"][0];
    // Core normalizes levels to ascending size: the first entry is the
    // smallest level (highest ordinal), the last is the largest.
    assert_eq!(level["id"], "lvl:dzi:0:9");
    assert_eq!(level["tile_width"], 256);

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
