use super::{tiles::tile_path, IiifWriter};
use crate::{
    codecs::NativeFormat,
    tile_pyramid::{downsample, StoredTile, TileBytes, TileLevel},
};
use dezoomify::model::{Error, ReusedTile, Size};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

impl IiifWriter {
    pub(super) fn finish(
        mut self,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        if !self.base.regular {
            let order = crate::tile_geometry::TileOrder::new(reused);
            let mut tiles = BTreeMap::new();
            for (index, tile) in std::mem::take(&mut self.base.tiles) {
                let index = order.index(index, tile.rect.x, tile.rect.y);
                tiles.insert(index, tile);
            }
            self.base.tiles = tiles;
        }
        let format = if self
            .base
            .tiles
            .values()
            .all(|tile| tile.format == NativeFormat::Image(image::ImageFormat::Jpeg))
        {
            NativeFormat::Image(image::ImageFormat::Jpeg)
        } else {
            NativeFormat::Image(image::ImageFormat::Png)
        };
        let mut normalized = TileLevel {
            size: self.base.size.clone(),
            cell: self.base.cell.clone(),
            tiles: BTreeMap::new(),
            regular: true,
        };
        if normalized.count()? > self.max_tiles {
            return Err(Error::ResourceLimit(
                "IIIF output tile count exceeds max_tiles".into(),
            ));
        }
        let indexes = u64::from(normalized.count()?)
            * 2
            * (std::mem::size_of::<StoredTile>() + self.staging.path.as_os_str().len() + 128)
                as u64;
        let growth = indexes.saturating_sub(self.index_bytes);

        self.index_bytes += growth;
        self.read_settled_profile(cancelled)?;
        for index in 0..normalized.count()? {
            let rect = normalized.rect(index);
            let existing = self.base.tiles.get(&index).filter(|tile| {
                self.base.regular
                    && tile.rect == rect
                    && tile.format == format
                    && matches!(tile.bytes, TileBytes::File(_))
            });
            let stored = if let Some(tile) = existing {
                let TileBytes::File(path) = &tile.bytes else {
                    unreachable!()
                };
                StoredTile {
                    rect,
                    size: tile.size.clone(),
                    format,
                    bytes: TileBytes::File(path.clone()),
                }
            } else {
                let pixels = self.base.region(rect, cancelled, &mut self.decoded_tiles)?;
                StoredTile {
                    rect,
                    size: Size {
                        width: rect.w,
                        height: rect.h,
                    },
                    format,
                    bytes: TileBytes::File(self.encode_tile(
                        rect,
                        1,
                        &normalized.size,
                        &pixels,
                        format,
                        cancelled,
                    )?),
                }
            };
            normalized.tiles.insert(index, stored);
        }
        // Conversion may read any source tile; remove superseded payloads only
        // after all normalized base tiles have been produced.
        for tile in self.base.tiles.values().filter(|t| t.format != format) {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::Cancelled);
            }
            if let TileBytes::File(path) = &tile.bytes {
                for path in [
                    path.clone(),
                    self.staging.path.join(tile_path(
                        tile.rect,
                        1,
                        tile.format,
                        &self.base.size,
                        true,
                    )),
                ] {
                    std::fs::remove_file(path).map_err(|e| {
                        crate::output::write_failed("obsolete tile removal failed", &e)
                    })?;
                }
            }
        }
        self.base = normalized;
        self.retained = self.icc_profile.as_ref().map_or(0, Vec::len) as u64;
        let full_size = self.base.size.clone();
        let mut factors = vec![1u32];
        let replacement = TileLevel {
            size: full_size.clone(),
            cell: self.base.cell.clone(),
            tiles: BTreeMap::new(),
            regular: true,
        };
        let mut level = std::mem::replace(&mut self.base, replacement);
        while level.size.width > level.cell.width || level.size.height > level.cell.height {
            let scale = factors.last().copied().unwrap_or(1) * 2;
            let mut next = TileLevel {
                size: Size {
                    width: level.size.width.div_ceil(2),
                    height: level.size.height.div_ceil(2),
                },
                cell: level.cell.clone(),
                tiles: BTreeMap::new(),
                regular: true,
            };
            for index in 0..next.count()? {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(Error::Cancelled);
                }
                let rect = next.rect(index);
                let pixels =
                    downsample(&level, &next.size, rect, cancelled, &mut self.decoded_tiles)?;
                let path = self.encode_tile(rect, scale, &full_size, &pixels, format, cancelled)?;
                next.tiles.insert(
                    index,
                    StoredTile {
                        rect,
                        size: Size {
                            width: rect.w,
                            height: rect.h,
                        },
                        format,
                        bytes: TileBytes::File(path),
                    },
                );
            }
            factors.push(scale);
            level = next;
        }
        // A real overview at the smallest advertised size. The full-size
        // response remains available through the tile API, without JPEG's cap.
        let tile = level.tiles.values().next().expect("complete lowest level");
        let TileBytes::File(path) = &tile.bytes else {
            unreachable!()
        };
        let ext = if format == NativeFormat::Image(image::ImageFormat::Jpeg) {
            "jpg"
        } else {
            "png"
        };
        let overview = format!("full/{},/0/default.{ext}", level.size.width);
        self.staging.alias_file(path, &overview, cancelled)?;
        self.staging.alias_file(
            path,
            &format!(
                "full/{},{}/0/default.{ext}",
                level.size.width, level.size.height
            ),
            cancelled,
        )?;
        if level.size == full_size {
            self.staging
                .alias_file(path, &format!("full/full/0/default.{ext}"), cancelled)?;
        }
        let intermediate = self.staging.path.join(".pyramid");
        if intermediate.exists() {
            std::fs::remove_dir_all(intermediate)
                .map_err(|e| crate::output::write_failed("pyramid cleanup failed", &e))?;
        }
        let capabilities = serde_json::json!({"formats": [ext], "qualities": ["default"], "supports": ["sizeByWhListed"]});
        let profile = if format == NativeFormat::Image(image::ImageFormat::Jpeg) {
            serde_json::json!(["http://iiif.io/api/image/2/level0.json", capabilities])
        } else {
            serde_json::json!([capabilities])
        };
        let info = serde_json::to_string_pretty(&serde_json::json!({
            "@context": "http://iiif.io/api/image/2/context.json", "@id": ".",
            "protocol": "http://iiif.io/api/image", "width": full_size.width, "height": full_size.height,
            "tiles": [{ "width": self.base.cell.width, "height": self.base.cell.height, "scaleFactors": factors }],
            "sizes": [{"width": level.size.width, "height": level.size.height}],
            "preferredFormats": [ext], "profile": profile
        })).map_err(|e| Error::EncodeFailed(e.to_string().into()))?;
        self.staging
            .write("info.json", info.as_bytes(), cancelled)?;
        let viewer = include_str!(concat!(env!("OUT_DIR"), "/viewer.html")).replacen(
            "__DEZOOMIFY_IMAGE_INFO__",
            &info,
            1,
        );
        self.staging
            .write("viewer.html", viewer.as_bytes(), cancelled)?;
        Ok(crate::output::PreparedOutput {
            staging: crate::output::StagedOutput::Directory(self.staging),
            size: full_size,
            pixel_decodes: self.decoded_tiles,
            late_writes: 0,
        })
    }
}
