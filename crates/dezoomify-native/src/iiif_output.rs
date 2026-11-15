//! Static IIIF publication and offline viewer, using shared tile conversion and pyramids.
use crate::{
    codecs::{tile_metadata, NativeFormat},
    encoded_tile::EncodedTile,
    output::StagedDirectory,
    tile_pyramid::{downsample, Rect, StoredTile, TileBytes, TileLevel},
};
use dezoomify::model::{Error, OutputPlan, ReusedTile, Size};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

fn tile_path(
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

pub(crate) struct IiifWriter {
    staging: StagedDirectory,
    base: TileLevel,
    compression: u8,
    pub(crate) decoded_tiles: u64,
    retained: u64,
    peak_retained: u64,
    infer_canvas: bool,
    max_tiles: u32,
    icc_profile: Option<Vec<u8>>,
    index_bytes: u64,
}

impl IiifWriter {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.retained + self.index_bytes
    }

    pub(crate) fn peak_retained(&self) -> u64 {
        self.peak_retained
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        compression: u8,
        max_tiles: u32,
    ) -> Result<Self, Error> {
        if plan
            .canvas
            .as_ref()
            .is_some_and(|size| size.width == 0 || size.height == 0)
        {
            return Err(Error::PlanInvalid(
                "IIIF canvas dimensions must be positive".into(),
            ));
        }
        let regular = plan
            .grid
            .as_ref()
            .is_some_and(|grid| grid.overlap.width == 0 && grid.overlap.height == 0);
        let cell = if regular {
            plan.grid.as_ref().expect("regular grid").tile_size.clone()
        } else {
            Size {
                width: 512,
                height: 512,
            }
        };
        let index_bytes = u64::from(plan.tile_count)
            * (std::mem::size_of::<StoredTile>() + destination.as_os_str().len() + 128) as u64;

        Ok(Self {
            staging: StagedDirectory::new(destination)?,
            base: TileLevel {
                size: plan.canvas.clone().unwrap_or(Size {
                    width: 1,
                    height: 1,
                }),
                cell,
                tiles: BTreeMap::new(),
                regular,
            },
            compression,
            decoded_tiles: 0,
            retained: 0,
            peak_retained: index_bytes,
            infer_canvas: plan.canvas.is_none(),
            max_tiles,
            icc_profile: None,
            index_bytes,
        })
    }

    pub(crate) fn place(
        &mut self,
        mut tile: EncodedTile,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        let rect = Rect::placed(
            &tile.placement,
            &tile.size,
            (!self.infer_canvas).then_some(&self.base.size),
        );
        if rect.w == 0 || rect.h == 0 {
            return Ok(());
        }

        let index = if self.base.regular {
            (rect.y / self.base.cell.height) * self.base.size.width.div_ceil(self.base.cell.width)
                + rect.x / self.base.cell.width
        } else {
            tile.id
        };
        let mut compatible = matches!(
            tile.format,
            NativeFormat::Image(image::ImageFormat::Jpeg | image::ImageFormat::Png)
        ) && tile.size.width == rect.w
            && tile.size.height == rect.h
            && self.base.regular
            && rect == self.base.rect(index);
        if !compatible {
            self.decoded_tiles += 1;
            tile.convert_to_png(
                Size {
                    width: rect.w,
                    height: rect.h,
                },
                self.compression,
            )?;
            compatible = self.base.regular && rect == self.base.rect(index);
        }
        let bytes = if compatible {
            TileBytes::File(self.write_tile(
                rect,
                1,
                tile.format,
                &self.base.size,
                &tile.bytes,
                cancelled,
            )?)
        } else {
            self.retained += tile.bytes.len() as u64;
            self.peak_retained = self.peak_retained.max(self.retained_bytes());

            TileBytes::Memory(tile.bytes)
        };
        if self.infer_canvas {
            self.base.size.width = self.base.size.width.max(rect.x.saturating_add(rect.w));
            self.base.size.height = self.base.size.height.max(rect.y.saturating_add(rect.h));
        }
        self.base.tiles.insert(
            index,
            StoredTile {
                rect,
                size: tile.size,
                format: tile.format,
                bytes,
            },
        );
        Ok(())
    }

    fn write_tile(
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

    fn encode_tile(
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
            crate::imaging::encode_jpeg_to(
                file.writer(cancelled),
                pixels,
                dezoomify::model::OutputFormat::Jpeg
                    .codec()
                    .control
                    .quality(self.compression),
                self.icc_profile.as_deref(),
            )
        } else {
            crate::imaging::encode_png_to(
                file.writer(cancelled),
                pixels,
                crate::imaging::png_compression_for(self.compression),
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

    fn read_settled_profile(&mut self, cancelled: &AtomicBool) -> Result<(), Error> {
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
                body = crate::buffers::read_file(path)
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

    pub(crate) fn finish(
        mut self,
        _destination: &Path,
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
