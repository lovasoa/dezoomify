//! Tile retries and progress; origin pacing is owned by the separate scheduler.
use crate::{Host, model::*, pacing::Scheduler};
use futures_util::{StreamExt, stream};

/// Acquire tiles with bounded concurrency and report completed progress.
/// Reuse the job's scheduler across levels to retain pacing and recovery state.
pub(crate) async fn acquire_tiles(
    tiles: impl Iterator<Item = Result<Tile, Error>>,
    host: &impl Host,
    options: &Options,
    progress: &mut Progress,
    scheduler: &Scheduler,
) -> Result<(), Error> {
    let acquisitions =
        stream::iter(tiles.map(|tile| async { acquire(host, tile?, options, scheduler).await }));
    let mut pending = acquisitions.buffer_unordered(options.max_concurrent as usize);
    while let Some(result) = pending.next().await {
        result?;
        progress.completed += 1;
        host.report(progress.clone());
    }
    Ok(())
}

/// Acquire one tile, retaining its identity and original failure context across retries.
async fn acquire(
    host: &impl Host,
    tile: Tile,
    options: &Options,
    scheduler: &Scheduler,
) -> Result<(), Error> {
    let mut attempt = 0;
    let mut previous_failure = None;
    loop {
        let ticket = scheduler
            .admit(host, tile.source.pacing_url(), tile.index)
            .await?;
        let request = TileAcquisition {
            tile: tile.clone(),
            attempt,
            requires_approval: attempt > options.max_retries,
            previous_failure,
        };
        match host.acquire_tile(request).await {
            Ok(()) => return scheduler.succeeded(host, ticket).await,
            Err(error) if error.is_terminal() || error.is_output() => return Err(error),
            Err(error) => {
                let delay = crate::retry::retry_delay_ms(
                    attempt.saturating_add(1),
                    error.retry_after_ms(),
                    options.retry_base_delay_ms,
                );
                let allowed = attempt < u32::MAX
                    && (attempt < options.max_retries
                        || (options.interactive_retries && error.retryable()));
                let shared = allowed && scheduler.failed(host, ticket, &error, delay).await?;
                if !allowed || (!shared && !error.retryable()) {
                    return Err(Error::TileFailed {
                        tile: tile.index,
                        attempts: attempt.saturating_add(1),
                        cause: Box::new(error),
                    });
                }
                previous_failure = Some(Box::new(error));
                attempt += 1;
                host.checkpoint(Gate::Acquisition).await?;
                if !shared {
                    scheduler.sleep(host, delay as u32).await?
                }
            }
        }
    }
}
