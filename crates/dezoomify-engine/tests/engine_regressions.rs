//! Engine invariants for the typed failure path plus deferred follows:
//! transient failures retry and can still succeed, deferred follows stay in
//! the same job, and a spent follow budget rejects further follows.

mod support;

use dezoomify_engine::{Config, TileFailure};
use support::JobCommand;
use support::ScriptedHost;

const INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The largest level is a real 2x2 grid with four planned tiles.
const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn budget_config(max_retries: u32) -> Config {
    Config {
        max_retries,
        ..Config::default()
    }
}

fn transient_failure() -> TileFailure {
    TileFailure::new("TRANSPORT_TIMEOUT", None, None, None)
}

/// Drive discovery plus selection of the largest level; return its tiles.
fn discover_and_acquire(host: &mut ScriptedHost) -> Vec<u32> {
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    assert_eq!(host.state(), "AcquiringTiles");
    host.tile_effects()
        .into_iter()
        .map(|(tile, _, _)| tile)
        .collect()
}

#[test]
fn transient_failure_eventually_succeeds_after_retry_wait() {
    let mut host = ScriptedHost::new("job:budget", INPUT_URL, budget_config(2)).unwrap();
    let planned = discover_and_acquire(&mut host);
    // Settle siblings first so the retry accounting is isolated.
    for tile in planned.iter().skip(1) {
        host.apply(JobCommand::TileAcquired { tile: *tile })
            .unwrap();
    }

    // Attempt 1 fails transiently: the engine issues an explicit wait.
    host.apply(JobCommand::TileFailed {
        tile: planned[0],
        failure: transient_failure(),
    })
    .unwrap();
    assert!(host
        .effects
        .iter()
        .any(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("wait-retry")));

    // Timer elapses: the retry is re-issued and can still succeed.
    host.apply(JobCommand::RetryTimerElapsed {
        tile: planned[0],
        attempt: 1,
    })
    .unwrap();
    host.apply(JobCommand::TileAcquired { tile: planned[0] })
        .unwrap();
    assert_eq!(host.state(), "Finalizing");
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
}

const BULK_LIST: &str = "https://example.test/a.dzi\nhttps://example.test/b.dzi\n";

fn deferred_host() -> ScriptedHost {
    let mut host = ScriptedHost::new(
        "job:deferred",
        "https://example.test/list.txt",
        Config::default(),
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: BULK_LIST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    host
}

#[test]
fn deferred_follow_continues_same_job_without_new_id() {
    let mut host = deferred_host();
    // Both entries are still-deferred requests, not selectable images.
    assert!(host.apply(JobCommand::SelectImage { image: 0 }).is_err());

    // Follow the first entry in the same job: the engine fetches the
    // follow-up URI and replaces the catalog.
    host.apply(JobCommand::FollowDeferred { image: 0 }).unwrap();
    assert_eq!(host.state(), "Discovering");
    let follow_request = host
        .effects
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource"))
        .expect("follow-up fetch");
    assert_eq!(
        follow_request
            .get("uri")
            .and_then(serde_json::Value::as_str),
        Some("https://example.test/a.dzi")
    );
    let request = follow_request
        .get("request")
        .and_then(serde_json::Value::as_u64)
        .and_then(|request| u32::try_from(request).ok())
        .expect("follow request id");
    host.apply(JobCommand::ResourceBytes {
        request,
        bytes: DZI.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");

    // The replaced catalog drives a complete job to terminal.
    let (image, levels) = host.catalog().expect("replaced catalog");
    host.apply(JobCommand::SelectImage { image }).unwrap();
    host.apply(JobCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    for (tile, _, _) in host.tile_effects() {
        host.apply(JobCommand::TileAcquired { tile }).unwrap();
    }
    host.apply(JobCommand::FinalizationSucceeded).unwrap();
    assert_eq!(host.state(), "Completed");
}

#[test]
fn deferred_follow_budget_is_bounded() {
    // Bulk-shaped chain: list.txt names mid.txt, mid.txt names inner.txt.
    // The budget (not parsing) stops the second follow.
    const FIRST: &str = "https://example.test/mid.txt\n";
    const NESTED: &str = "https://example.test/inner.txt\n";
    let mut host = ScriptedHost::new(
        "job:budget-follow",
        "https://example.test/list.txt",
        Config {
            max_deferred_follows: 1,
            ..Config::default()
        },
    )
    .unwrap();
    host.start().unwrap();
    host.apply(JobCommand::ResourceBytes {
        request: 0,
        bytes: FIRST.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    // First follow consumes the single allowed follow.
    host.apply(JobCommand::FollowDeferred { image: 0 }).unwrap();
    let request = host
        .effects
        .iter()
        .rev()
        .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-resource"))
        .and_then(|v| v.get("request").and_then(serde_json::Value::as_u64))
        .and_then(|request| u32::try_from(request).ok())
        .expect("follow request id");
    host.apply(JobCommand::ResourceBytes {
        request,
        bytes: NESTED.as_bytes().to_vec(),
        final_uri: None,
    })
    .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    // The budget is spent: a second follow is rejected.
    let err = host
        .apply(JobCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(host.state(), "AwaitingImageSelection");

    // Zero follows allowed: following is rejected up front.
    let mut tight = ScriptedHost::new(
        "job:no-follow",
        "https://example.test/list.txt",
        Config {
            max_deferred_follows: 0,
            ..Config::default()
        },
    )
    .unwrap();
    tight.start().unwrap();
    tight
        .apply(JobCommand::ResourceBytes {
            request: 0,
            bytes: BULK_LIST.as_bytes().to_vec(),
            final_uri: None,
        })
        .unwrap();
    let err = tight
        .apply(JobCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(tight.state(), "AwaitingImageSelection");
}
