//! Engine invariants for the typed failure path plus deferred follows:
//! transient failures retry and can still succeed, deferred follows stay in
//! the same job, and a spent follow budget rejects further follows.

mod support;

use dezoomify::engine::{Config, EffectResult, Failure, UserCommand};
use dezoomify::model::{HostEffect as Effect, OutputDisposition};
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

fn transient_failure() -> Failure {
    Failure::new("TRANSPORT_TIMEOUT")
}

/// Drive discovery plus selection of the largest level; return its tiles.
fn discover_and_acquire(host: &mut ScriptedHost) -> Vec<u32> {
    host.start().unwrap();
    host.provide_metadata(0, DZI.as_bytes(), None).unwrap();
    let (image, levels) = host.catalog().expect("catalog event");
    host.command(UserCommand::SelectImage { image }).unwrap();
    host.command(UserCommand::SelectLevel {
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
        host.complete_tile(*tile, EffectResult::TileAcquired)
            .unwrap();
    }

    // Attempt 1 fails transiently: the engine issues an explicit wait.
    host.complete_tile(planned[0], EffectResult::TileFailed(transient_failure()))
        .unwrap();
    assert!(
        host.effects
            .iter()
            .any(|effect| matches!(effect, Effect::WaitRetryTimer { .. }))
    );

    // Timer elapses: the retry is re-issued and can still succeed.
    host.complete_timer(planned[0], 1, EffectResult::TimerElapsed)
        .unwrap();
    host.complete_tile(planned[0], EffectResult::TileAcquired)
        .unwrap();
    assert_eq!(host.state(), "Finalizing");
    host.complete_output(EffectResult::OutputCommitted {
        disposition: OutputDisposition::NativePublication,
    })
    .unwrap();
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
    host.provide_metadata(0, BULK_LIST.as_bytes(), None)
        .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    host
}

#[test]
fn deferred_follow_continues_same_job_without_new_id() {
    let mut host = deferred_host();
    // Both entries are still-deferred requests, not selectable images.
    assert!(host.command(UserCommand::SelectImage { image: 0 }).is_err());

    // Follow the first entry in the same job: the engine fetches the
    // follow-up URI and replaces the catalog.
    host.command(UserCommand::FollowDeferred { image: 0 })
        .unwrap();
    assert_eq!(host.state(), "Discovering");
    let follow_request = host
        .effects
        .iter()
        .rev()
        .find_map(|effect| match effect {
            Effect::AcquireResource { request } => Some((request.id, &request.uri)),
            _ => None,
        })
        .expect("follow-up fetch");
    assert_eq!(follow_request.1, "https://example.test/a.dzi");
    let request = follow_request.0;
    host.provide_metadata(request, DZI.as_bytes(), None)
        .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");

    // The replaced catalog drives a complete job to terminal.
    let (image, levels) = host.catalog().expect("replaced catalog");
    host.command(UserCommand::SelectImage { image }).unwrap();
    host.command(UserCommand::SelectLevel {
        level: *levels.last().expect("level"),
    })
    .unwrap();
    for (tile, _, _) in host.tile_effects() {
        host.complete_tile(tile, EffectResult::TileAcquired)
            .unwrap();
    }
    host.complete_output(EffectResult::OutputCommitted {
        disposition: OutputDisposition::NativePublication,
    })
    .unwrap();
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
    host.provide_metadata(0, FIRST.as_bytes(), None).unwrap();
    // First follow consumes the single allowed follow.
    host.command(UserCommand::FollowDeferred { image: 0 })
        .unwrap();
    let request = host
        .effects
        .iter()
        .rev()
        .find_map(|effect| match effect {
            Effect::AcquireResource { request } => Some(request.id),
            _ => None,
        })
        .expect("follow request id");
    host.provide_metadata(request, NESTED.as_bytes(), None)
        .unwrap();
    assert_eq!(host.state(), "AwaitingImageSelection");
    // The budget is spent: a second follow is rejected.
    let err = host
        .command(UserCommand::FollowDeferred { image: 0 })
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
        .provide_metadata(0, BULK_LIST.as_bytes(), None)
        .unwrap();
    let err = tight
        .command(UserCommand::FollowDeferred { image: 0 })
        .unwrap_err();
    assert_eq!(err.code, "job.invalid-state");
    assert_eq!(tight.state(), "AwaitingImageSelection");
}
