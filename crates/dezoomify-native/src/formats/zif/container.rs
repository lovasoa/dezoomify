use super::{failed, Profile, ZifWriter};
use crate::{
    codecs::NativeFormat,
    tile_pyramid::{Rect, StoredTile, TileBytes},
};
use crate::{tile_budget::memory_check, tile_output::TileWriter};
use dezoomify::model::{Error, Size};
use std::sync::atomic::{AtomicBool, Ordering};

impl ZifWriter {
    pub(super) fn initialize(
        &mut self,
        selected: Profile,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        let (codec, color) = match selected {
            Profile::PngRgb => (zif_tiff::Codec::Png, zif_tiff::ColorModel::Rgb),
            Profile::Jpeg { .. } => (zif_tiff::Codec::Jpeg, zif_tiff::ColorModel::YCbCr),
        };
        let mut builder = zif_tiff::Writer::new()
            .dimensions((
                u64::from(self.base.size.width),
                u64::from(self.base.size.height),
            ))
            .tile_size((self.base.cell.width, self.base.cell.height))
            .map_err(failed)?
            .codec(codec)
            .color_model(color)
            .channels(3)
            .map_err(failed)?;
        if let Profile::Jpeg { sampling } = selected {
            builder = if matches!(sampling, (1, 1) | (2, 2)) {
                builder.ycbcr_subsampling(sampling)
            } else {
                builder.preserve_nonstandard_ycbcr_subsampling(sampling)
            }
            .map_err(failed)?;
        }
        if matches!(selected, Profile::Jpeg { sampling } if sampling != (1, 1)) {
            // Source reuse is independent of our 4:4:4 pixel encoder. Only
            // declared source levels are written for a subsampled container.
            for level in std::iter::once(&self.base).chain(&self.source_levels) {
                builder = builder.level(
                    zif_tiff::LevelConfig::new(
                        (u64::from(level.size.width), u64::from(level.size.height)),
                        (level.cell.width, level.cell.height),
                    )
                    .map_err(failed)?,
                );
            }
        } else {
            builder = builder.pyramid();
        }
        let mut writer = builder.build().map_err(failed)?;
        let result = zif_tiff::std::RangeWriter::wrap(self.staging.writer(cancelled))
            .apply(writer.init().map_err(failed)?)
            .map_err(failed);
        self.staging.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        self.profile = Some(selected);
        self.writer = Some(writer);
        Ok(())
    }

    pub(super) fn store(
        &mut self,
        level: usize,
        rect: Rect,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<StoredTile, Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        memory_check(self.retained_bytes() + bytes.len() as u64 * 2, self.budget)?;
        let writer = self.writer.as_mut().expect("initialized ZIF writer");
        let batch = writer
            .put_tile_at_level(
                level,
                (
                    u64::from(rect.x / self.base.cell.width),
                    u64::from(rect.y / self.base.cell.height),
                ),
                bytes,
            )
            .map_err(failed)?;
        // Initialization was applied separately; the first action is the tile
        // payload, followed by its offset and length index updates.
        let offset = batch
            .actions()
            .first()
            .ok_or_else(|| Error::Internal("missing ZIF tile action".into()))?
            .offset;
        let result = zif_tiff::std::RangeWriter::wrap(self.staging.writer(cancelled))
            .apply(batch)
            .map_err(failed);
        self.staging.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        let format = match self.profile.expect("initialized ZIF profile") {
            Profile::Jpeg { .. } => NativeFormat::Image(image::ImageFormat::Jpeg),
            Profile::PngRgb => NativeFormat::Image(image::ImageFormat::Png),
        };
        Ok(StoredTile {
            rect,
            size: Size {
                width: rect.w,
                height: rect.h,
            },
            format,
            bytes: TileBytes::Range {
                path: self.staging.path().to_path_buf(),
                offset,
                length: bytes.len() as u64,
            },
        })
    }
}
