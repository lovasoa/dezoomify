use super::IiifWriter;
use crate::{
    codecs::{tile_metadata, NativeFormat},
    tile_pyramid::{Rect, TileBytes},
};
use dezoomify::model::{Error, Size};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) fn tile_path(
    rect: Rect,
    scale: u32,
    format: NativeFormat,
    canvas: &Size,
    explicit: bool,
) -> String {
    let x = rect.x * scale;
    let y = rect.y * scale;
    let w = rect.w.saturating_mul(scale).min(canvas.width - x);
    let h = rect.h.saturating_mul(scale).min(canvas.height - y);
    format!(
        "{x},{y},{w},{h}/{}/0/default.{}",
        if explicit {
            format!("{},{}", rect.w, rect.h)
        } else {
            format!("{},", rect.w)
        },
        if format == NativeFormat::Image(image::ImageFormat::Jpeg) {
            "jpg"
        } else {
            "png"
        }
    )
}

impl IiifWriter {
    pub(super) fn write_tile(
        &self,
        rect: Rect,
        scale: u32,
        format: NativeFormat,
        canvas: &Size,
        bytes: &[u8],
        cancelled: &AtomicBool,
    ) -> Result<PathBuf, Error> {
        // Different pyramid levels can request the same clipped corner.
        // Reuse its existing payload; writing would also truncate its aliases.
        let existing = self
            .staging
            .path
            .join(tile_path(rect, scale, format, canvas, false));
        if existing.is_file() {
            return Ok(existing);
        }
        let path = self.staging.write(
            &tile_path(rect, scale, format, canvas, false),
            bytes,
            cancelled,
        )?;
        self.staging.alias(
            &path,
            &tile_path(rect, scale, format, canvas, true),
            bytes,
            cancelled,
        )?;
        Ok(path)
    }

    pub(super) fn encode_tile(
        &self,
        rect: Rect,
        scale: u32,
        canvas: &Size,
        pixels: &image::RgbaImage,
        format: NativeFormat,
        cancelled: &AtomicBool,
    ) -> Result<PathBuf, Error> {
        let relative = tile_path(rect, scale, format, canvas, false);
        let public = self.staging.path.join(&relative);
        // Public edge routes can coincide across levels. Preserve their first
        // payload, but keep the generated pixels for the next resampling pass.
        let collision = public.is_file();
        let path = if collision {
            self.staging
                .path
                .join(format!(".pyramid/{scale}/{},{}", rect.x, rect.y))
        } else {
            public
        };
        let mut file = crate::output::StagedFile::new(&path)?;
        // Stream compressed bytes instead of retaining a second tile buffer.
        let result = if format == NativeFormat::Image(image::ImageFormat::Jpeg) {
            crate::formats::jpeg::encode_to(
                file.writer(cancelled),
                pixels,
                dezoomify::model::OutputFormat::Jpeg
                    .codec()
                    .control
                    .quality(self.compression),
                self.icc_profile.as_deref(),
            )
        } else {
            crate::formats::png::encode_to(
                file.writer(cancelled),
                pixels,
                crate::formats::png::compression_for(self.compression),
                self.icc_profile.as_deref(),
                None,
            )
        };
        file.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result?;
        file.publish(&path, false, cancelled)?;
        if !collision {
            self.staging.alias_file(
                &path,
                &tile_path(rect, scale, format, canvas, true),
                cancelled,
            )?;
        }
        Ok(path)
    }

    pub(super) fn read_settled_profile(&mut self, cancelled: &AtomicBool) -> Result<(), Error> {
        // Acquisition has settled and reused probes now have their final order.
        // Read just one profile at a time; no completion-order metadata cache.
        for tile in self.base.tiles.values() {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            let body;
            let bytes = if let TileBytes::Memory(bytes) = &tile.bytes {
                bytes.as_slice()
            } else if let TileBytes::File(path) = &tile.bytes {
                body = std::fs::read(path)
                    .map_err(|e| crate::output::write_failed("tile read failed", &e))?;
                &body
            } else {
                return Err(Error::Internal("unexpected IIIF tile storage".into()));
            };

            if let (Some(icc), _) = tile_metadata(bytes, tile.format)? {
                self.retained += icc.len() as u64;
                self.icc_profile = Some(icc);
                break;
            }
        }
        Ok(())
    }
}
