//! A transient failure retries on the exact budget with explicit waits.
//! Timers created while paused are issued on resume; completions that
//! arrive while paused park until resume. The job still reaches full
//! completion.

use dezoomify_engine::{
    DiscoveryInput, Effect, EffectResult, EngineJob, Failure, JobOptions, Lifecycle,
    OutputDisposition, UserCommand,
};

const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

fn timeout() -> Failure {
    Failure::new("TRANSPORT_TIMEOUT")
}

fn main() {
    let mut options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")]);
    options.max_retries = 2;
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

    // Settle siblings first so the retry accounting is isolated.
    let mut update = update;
    for id in tiles.iter().skip(1) {
        update = job
            .complete(*id, EffectResult::TileAcquired)
            .expect("sibling done");
    }
    assert_eq!(update.snapshot.lifecycle, Lifecycle::AcquiringTiles);

    // Fail while paused: the attempt records but no timer issues yet.
    update = job.command(UserCommand::Pause).expect("pause");
    assert!(update.snapshot.paused);
    update = job
        .complete(tiles[0], EffectResult::TileFailed(timeout()))
        .expect("failure");
    assert!(update
        .effects
        .iter()
        .all(|e| !matches!(e, Effect::WaitRetryTimer { .. })));

    // Resume issues the deferred timer with the base backoff.
    update = job.command(UserCommand::Resume).expect("resume");
    let (tile, attempt, delay) = update
        .effects
        .iter()
        .find_map(|e| match e {
            Effect::WaitRetryTimer {
                tile,
                attempt,
                delay_ms,
                ..
            } => Some((*tile, *attempt, *delay_ms)),
            _ => None,
        })
        .expect("deferred timer issued on resume");
    assert_eq!((attempt, delay), (1, 1_000));

    // Answer the timer: the second attempt issues exactly once.
    update = job
        .complete(
            update
                .effects
                .iter()
                .find(|e| matches!(e, Effect::WaitRetryTimer { .. }))
                .expect("timer")
                .id(),
            EffectResult::TimerElapsed,
        )
        .expect("timer elapsed");
    assert_eq!(update.tile_effects().len(), 1, "one re-acquisition");
    let retry_id = update.tile_effects()[0].id();

    // The retried tile succeeds; the job completes fully.
    update = job
        .complete(retry_id, EffectResult::TileAcquired)
        .expect("retry done");
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
    let _ = (tile, attempt);
    eprintln!("retry: 2 attempts, 1 timer of 1000ms, pause parked the timer, full output");
}
