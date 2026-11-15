use crate::codecs::NativeFormat;
use dezoomify::model::{Error, Size};

/// Conversion required by output geometry happens during acquisition so failures
/// retain their tile's request context and retry handling.
pub(crate) fn convert_tile(
    tile: &mut crate::encoded_tile::EncodedTile,
    size: Size,
    budget: u64,
    compression: u8,
) -> Result<(), Error> {
    let pixels = u64::from(tile.size.width) * u64::from(tile.size.height);
    crate::tile_budget::memory_check(tile.bytes.len() as u64 + pixels * 16, budget)?;
    let (icc, exif) = crate::codecs::tile_metadata(
        &tile.bytes,
        tile.format,
        budget.saturating_sub(tile.bytes.len() as u64 + pixels * 16),
    )?;
    let budget = budget.saturating_sub(
        (icc.as_ref().map_or(0, Vec::len) as u64 + exif.as_ref().map_or(0, Vec::len) as u64) * 4,
    );
    let image = tile.decode_pixels(&size, budget)?;
    tile.bytes = crate::formats::png::encode(
        &image,
        crate::formats::png::compression_for(compression),
        icc.as_deref(),
        exif.as_deref(),
    )?;
    tile.format = NativeFormat::Image(image::ImageFormat::Png);
    tile.size = size;
    Ok(())
}
