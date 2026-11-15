//! Required source conversion stays in acquisition so failures retain the tile's
//! request context and retry handling. Finalization may decode stored tiles for
//! pyramid generation, but must not reacquire missing source data.
use crate::encoded_tile::EncodedTile;
use dezoomify::model::{Error, ReusedTile, Size};
use std::sync::atomic::AtomicBool;

pub(crate) type SharedTileWriter = std::sync::Arc<std::sync::Mutex<Box<dyn TileWriter>>>;

pub(crate) trait TileWriter: Send {
    /// Remaining space for one encoded input, after retained output, container
    /// indexes, and outstanding input/probe reservations have been withheld.
    fn input_budget(&self) -> u64;
    fn retained_bytes(&self) -> u64;
    fn hold_queued_bytes(&mut self, bytes: u64) -> Result<(), Error>;
    fn release_probe_bytes(&mut self, bytes: u64);
    fn peak_retained(&self) -> u64;
    fn place(&mut self, tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error>;
    fn finish(
        self: Box<Self>,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error>;
}

/// Pyramids require exact extents and payloads their readers can reuse.
pub(crate) fn pyramid_probe_needs_preparation(tile: &EncodedTile, extent: &Size) -> bool {
    *extent != tile.size
        || !matches!(
            tile.format,
            crate::codecs::NativeFormat::Image(image::ImageFormat::Png | image::ImageFormat::Jpeg)
        )
}
