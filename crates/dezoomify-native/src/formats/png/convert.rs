use crate::codecs::NativeFormat;
use dezoomify::model::{Error, Size};

/// Conversion happens during acquisition so failures retain their tile's request
/// context and retry handling.
pub(crate) fn convert_tile(
    tile: &mut crate::encoded_tile::EncodedTile,
    size: Size,
    compression: u8,
) -> Result<(), Error> {
    let (icc, exif) = crate::codecs::tile_metadata(&tile.bytes, tile.format)?;
    let image = tile.decode_pixels(&size)?;
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
