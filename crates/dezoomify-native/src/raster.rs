//! Concrete blocking encoder task. PNG rows reference stripe segments; JPEG
//! requests individual pixels. No assembled canvas or second pixel cache.
use crate::{
    host::Controls,
    output::StagedFile,
    pixel_pipe::{MemoryBudget, PixelPipe, ReadCounts},
};
use dezoomify::model::{Error, OutputFormat, Size};
use std::{
    io::{Read, Seek, Write},
    path::Path,
    sync::Arc,
};

pub(crate) struct EncoderTask {
    pub(crate) pipe: Arc<PixelPipe>,
    task: Option<tokio::task::JoinHandle<Result<StagedFile, Error>>>,
}
impl EncoderTask {
    pub(crate) fn start(
        destination: &Path,
        size: Size,
        tile_height: u32,
        format: OutputFormat,
        compression: u8,
        budget: Arc<MemoryBudget>,
        controls: Controls,
    ) -> Result<Self, Error> {
        if size.width == 0 || size.height == 0 {
            return Err(Error::InvalidState("empty raster dimensions".into()));
        }
        let reason = match format {
            OutputFormat::Jpeg
                if size.width > crate::imaging::JPEG_MAX_SIDE
                    || size.height > crate::imaging::JPEG_MAX_SIDE =>
            {
                Some(dezoomify::model::LimitReason::JpegSide)
            }
            OutputFormat::Webp
                if size.width > crate::imaging::WEBP_MAX_SIDE
                    || size.height > crate::imaging::WEBP_MAX_SIDE =>
            {
                Some(dezoomify::model::LimitReason::WebpSide)
            }
            _ => None,
        };
        if let Some(reason) = reason {
            return Err(Error::LimitExceeded {
                limit: dezoomify::model::LimitContext {
                    reason,
                    dimensions: Some(size),
                    bytes_required: None,
                    bytes_available: None,
                },
            });
        }
        let reads = if format == OutputFormat::Jpeg {
            JpegView::read_counts(&size)
        } else {
            ReadCounts::default()
        };
        let pipe = PixelPipe::new(size.clone(), budget, tile_height, reads);
        let work = match format {
            OutputFormat::Png => u64::from(size.width) * 16 + (1 << 20),
            OutputFormat::Tiff => {
                u64::from(size.width) * 8 + u64::from(size.height) * 24 + (128 << 10)
            }
            // The WebP API requires a contiguous image and whole-image codec
            // workspace. Reserve this fallback explicitly before acquisition.
            OutputFormat::Webp => u64::from(size.width) * u64::from(size.height) * 32 + (128 << 10),
            _ => 128 << 10,
        };
        let workspace = pipe.budget.reserve(work, 0)?;
        let staging = StagedFile::new(destination)?;
        controls.watch(&pipe);
        let reader = Arc::clone(&pipe);
        let task = tokio::task::spawn_blocking(move || {
            let _workspace = workspace;
            let result = encode(staging, &reader, format, compression, &controls);
            if let Err(error) = &result {
                reader.fail(error.clone());
            }
            result
        });
        Ok(Self {
            pipe,
            task: Some(task),
        })
    }
    pub(crate) async fn wait(mut self) -> Result<StagedFile, Error> {
        self.task
            .take()
            .expect("encoder task")
            .await
            .map_err(|_| Error::Internal("image encoder task failed".into()))?
    }
    pub(crate) async fn abort(mut self) {
        self.pipe.fail(Error::Cancelled);
        let _ = self.task.take().expect("encoder task").await;
    }
}
impl Drop for EncoderTask {
    fn drop(&mut self) {
        if self.task.is_some() {
            self.pipe.fail(Error::Cancelled);
        }
    }
}

struct PipeWriter<'a, W> {
    inner: W,
    pipe: &'a PixelPipe,
}
impl<W> PipeWriter<'_, W> {
    fn check(&self) -> std::io::Result<()> {
        if self.pipe.error().is_some() {
            Err(std::io::Error::other("pixel source failed"))
        } else {
            Ok(())
        }
    }
}
impl<W: Write> Write for PipeWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.check()?;
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.check()?;
        self.inner.flush()
    }
}
impl<W: Seek> Seek for PipeWriter<'_, W> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        self.inner.seek(pos)
    }
}
fn encode(
    mut staging: StagedFile,
    pipe: &Arc<PixelPipe>,
    format: OutputFormat,
    compression: u8,
    controls: &Controls,
) -> Result<StagedFile, Error> {
    let result = (|| {
        let mut output = std::io::BufWriter::with_capacity(
            64 << 10,
            PipeWriter {
                inner: staging.writer(controls.cancel_flag()),
                pipe,
            },
        );
        match format {
            OutputFormat::Png => {
                let mut encoder = png::Encoder::new(&mut output, pipe.size.width, pipe.size.height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.set_compression(match compression {
                    0..=19 => png::Compression::Fast,
                    20..=60 => png::Compression::Balanced,
                    _ => png::Compression::High,
                });
                let mut writer = encoder.write_header().map_err(encoding_error)?;
                {
                    let mut stream = writer
                        .stream_writer_with_size(64 << 10)
                        .map_err(encoding_error)?;
                    for y in 0..pipe.size.height {
                        let start = u64::from(y) * u64::from(pipe.size.width);
                        let row = pipe.read(start..start + u64::from(pipe.size.width))?;
                        for bytes in row.segments() {
                            stream.write_all(bytes).map_err(encoding_error)?;
                        }
                    }
                    stream.finish().map_err(encoding_error)?;
                }
                writer.finish().map_err(encoding_error)?;
            }
            OutputFormat::Jpeg => {
                let view = JpegView { pipe };
                image::codecs::jpeg::JpegEncoder::new_with_quality(
                    &mut output,
                    100u8.saturating_sub(compression),
                )
                .encode_image(&view)
                .map_err(encoding_error)?;
            }
            OutputFormat::Tiff => {
                // tiff 0.11's public write_strip does not enable its compressor.
                // Compress each row explicitly and let the directory encoder
                // write offsets and tags.
                use tiff::tags::Tag;
                let mut encoder =
                    tiff::encoder::TiffEncoder::new(&mut output).map_err(encoding_error)?;
                let mut directory = encoder.image_directory().map_err(encoding_error)?;
                directory
                    .write_tag(Tag::ImageWidth, pipe.size.width)
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::ImageLength, pipe.size.height)
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::BitsPerSample, &[8u16; 4][..])
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::SamplesPerPixel, 4u16)
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::PhotometricInterpretation, 2u16)
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::ExtraSamples, &[2u16][..])
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::Compression, 8u16)
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::RowsPerStrip, 1u32)
                    .map_err(encoding_error)?;
                let mut offsets = Vec::with_capacity(pipe.size.height as usize);
                let mut lengths = Vec::with_capacity(pipe.size.height as usize);
                let level = crate::imaging::tiff_compression_for(compression) as u32;
                for y in 0..pipe.size.height {
                    let mut compressed = flate2::write::ZlibEncoder::new(
                        Vec::new(),
                        flate2::Compression::new(level),
                    );
                    let start = u64::from(y) * u64::from(pipe.size.width);
                    let lease = pipe.read(start..start + u64::from(pipe.size.width))?;
                    for bytes in lease.segments() {
                        compressed.write_all(bytes).map_err(encoding_error)?;
                    }
                    let bytes = compressed.finish().map_err(encoding_error)?;
                    offsets.push(
                        u32::try_from(
                            directory
                                .write_data(bytes.as_slice())
                                .map_err(encoding_error)?,
                        )
                        .map_err(encoding_error)?,
                    );
                    lengths.push(u32::try_from(bytes.len()).map_err(encoding_error)?);
                }
                directory
                    .write_tag(Tag::StripOffsets, offsets.as_slice())
                    .map_err(encoding_error)?;
                directory
                    .write_tag(Tag::StripByteCounts, lengths.as_slice())
                    .map_err(encoding_error)?;
                let (icc, _) = pipe.metadata()?;
                if let Some(icc) = icc {
                    directory
                        .write_tag(Tag::IccProfile, icc.as_slice())
                        .map_err(encoding_error)?;
                }
                directory.finish().map_err(encoding_error)?;
            }
            OutputFormat::Webp => {
                let mut pixels =
                    Vec::with_capacity(pipe.size.width as usize * pipe.size.height as usize * 4);
                for y in 0..pipe.size.height {
                    let start = u64::from(y) * u64::from(pipe.size.width);
                    let lease = pipe.read(start..start + u64::from(pipe.size.width))?;
                    for bytes in lease.segments() {
                        pixels.extend_from_slice(bytes);
                    }
                }
                let image = image::RgbaImage::from_raw(pipe.size.width, pipe.size.height, pixels)
                    .expect("complete WebP pixels");
                let (icc, _) = pipe.metadata()?;
                crate::imaging::encode_webp_to(&mut output, &image, icc.as_deref())?;
            }
            _ => return Err(Error::InvalidState("tile format in raster encoder".into())),
        }
        output.flush().map_err(encoding_error)?;
        Ok::<_, Error>(())
    })();
    if let Some(error) = pipe.error() {
        return Err(error);
    }
    result?;
    let (icc, exif) = pipe.metadata()?;
    if matches!(format, OutputFormat::Png | OutputFormat::Jpeg)
        && (icc.is_some() || (format == OutputFormat::Png && exif.is_some()))
    {
        let metadata_bytes = icc.as_ref().map_or(0, Vec::len) + exif.as_ref().map_or(0, Vec::len);
        let _metadata_memory = pipe
            .budget
            .reserve(metadata_bytes as u64 * 4 + (128 << 10), 0)?;
        let bytes = metadata_header(format, icc.as_deref(), exif.as_deref())?;
        let offset = if format == OutputFormat::Png {
            33
        } else {
            // Keep JFIF APP0 immediately after SOI, matching encode_jpeg_to.
            let mut prefix = [0; 6];
            std::fs::File::open(staging.path())
                .and_then(|mut file| file.read_exact(&mut prefix))
                .map_err(encoding_error)?;
            if prefix[2..4] == [0xff, 0xe0] {
                4 + u64::from(u16::from_be_bytes([prefix[4], prefix[5]]))
            } else {
                2
            }
        };
        staging.insert_header(offset, &bytes, controls.cancel_flag())?;
    }
    Ok(staging)
}
fn encoding_error(error: impl std::fmt::Display) -> Error {
    Error::EncodeFailed(error.to_string().into())
}

/// The current image encoder reads each pixel once, except repeated edge
/// pixels used to pad its 8x8 blocks. Counts are codec-specific; no leases.
struct JpegView<'a> {
    pipe: &'a PixelPipe,
}
impl JpegView<'_> {
    fn read_counts(size: &Size) -> ReadCounts {
        ReadCounts {
            pad_x: (8 - size.width % 8) % 8,
            pad_y: (8 - size.height % 8) % 8,
        }
    }
}
impl image::GenericImageView for JpegView<'_> {
    type Pixel = image::Rgb<u8>;
    fn dimensions(&self) -> (u32, u32) {
        (self.pipe.size.width, self.pipe.size.height)
    }
    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        if self.pipe.error().is_some() {
            return image::Rgb([0, 0, 0]);
        }
        match self
            .pipe
            .pixel(u64::from(y) * u64::from(self.pipe.size.width) + u64::from(x))
        {
            Ok(pixel) => pixel,
            Err(error) => {
                self.pipe.fail(error);
                image::Rgb([0, 0, 0])
            }
        }
    }
}
/// Obtain just the ICC/EXIF chunks using the existing metadata encoders. The
/// dummy pixel and its compressed payload are never part of the final image.
fn metadata_header(
    format: OutputFormat,
    icc: Option<&[u8]>,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>, Error> {
    let pixel = image::RgbaImage::new(1, 1);
    let encoded = if format == OutputFormat::Png {
        crate::imaging::encode_png(&pixel, image::codecs::png::CompressionType::Fast, icc, exif)?
    } else {
        crate::imaging::encode_jpeg(&pixel, 95, icc)?
    };
    let mut result = Vec::new();
    let mut pos = if format == OutputFormat::Png { 8 } else { 2 };
    while pos + 8 <= encoded.len() {
        if format == OutputFormat::Png {
            let len =
                u32::from_be_bytes(encoded[pos..pos + 4].try_into().expect("PNG chunk length"))
                    as usize;
            let end = pos + len + 12;
            if end > encoded.len() {
                break;
            }
            if matches!(&encoded[pos + 4..pos + 8], b"iCCP" | b"eXIf") {
                result.extend_from_slice(&encoded[pos..end]);
            }
            pos = end;
        } else {
            if encoded[pos] != 0xff || encoded[pos + 1] == 0xda {
                break;
            }
            let len = u16::from_be_bytes([encoded[pos + 2], encoded[pos + 3]]) as usize;
            let end = pos + len + 2;
            if end > encoded.len() {
                break;
            }
            if encoded[pos + 1] == 0xe2 && encoded[pos + 4..end].starts_with(b"ICC_PROFILE\0") {
                result.extend_from_slice(&encoded[pos..end]);
            }
            pos = end;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imaging::DecodedTile;
    use dezoomify::model::{Point, TilePlacement, TileRole};
    #[test]
    fn metadata_is_finalized_after_pixels_without_recompressing_the_image() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let directory =
                crate::sink::temp_sibling(&std::env::temp_dir().join("stripe-metadata"));
            std::fs::create_dir(&directory).expect("directory");
            let icc = vec![
                0, 0, 2, 12, 0x61, 0x64, 0x73, 0x70, 0, 0, 0, 0, 0x6d, 0x6e, 0x74, 0x72, 0x52,
                0x47, 0x42, 0x20,
            ];
            let exif = vec![0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a];
            for format in [OutputFormat::Png, OutputFormat::Jpeg] {
                let destination = directory.join(format.extension());
                let budget = MemoryBudget::new(8 << 20);
                let task = EncoderTask::start(
                    &destination,
                    Size {
                        width: 2,
                        height: 1,
                    },
                    1,
                    format,
                    5,
                    Arc::clone(&budget),
                    Controls::default(),
                )
                .expect("encoder");
                let pipe = Arc::clone(&task.pipe);
                for x in [1, 0] {
                    pipe.place(
                        x,
                        &TilePlacement {
                            position: Point { x, y: 0 },
                            expected_size: None,
                            canvas: None,
                            processing: Default::default(),
                            role: TileRole::output(),
                        },
                        DecodedTile {
                            image: image::RgbaImage::from_pixel(
                                1,
                                1,
                                image::Rgba([40, 80, 120, 255]),
                            ),
                            icc_profile: if x == 1 { Some(icc.clone()) } else { None },
                            exif_metadata: if x == 0 { Some(exif.clone()) } else { None },
                        },
                        budget.reserve(4, 0).expect("pixels"),
                    )
                    .expect("place");
                }
                tokio::time::timeout(std::time::Duration::from_secs(3), async {
                    while pipe.consumed() != 2 {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .expect("encoder reads before finalization");
                pipe.finish(&[]);
                let mut staging = task.wait().await.expect("metadata finish");
                staging
                    .publish(
                        &destination,
                        false,
                        &std::sync::atomic::AtomicBool::new(false),
                    )
                    .expect("publish");
                let bytes = std::fs::read(&destination).expect("image");
                let loaded =
                    crate::imaging::load_image_with_metadata(&bytes).expect("metadata decode");
                assert_eq!(loaded.icc_profile, Some(icc.clone()));
                if format == OutputFormat::Png {
                    assert_eq!(loaded.exif_metadata, Some(exif.clone()));
                } else {
                    assert_eq!(
                        bytes,
                        crate::imaging::encode_jpeg(
                            &image::RgbaImage::from_pixel(2, 1, image::Rgba([40, 80, 120, 255])),
                            95,
                            Some(&icc)
                        )
                        .expect("reference header ordering")
                    );
                }
            }
            std::fs::remove_dir_all(directory).expect("cleanup");
        });
    }
    #[test]
    fn codecs_match_pixels_and_jpeg_padding_releases_every_stripe() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let directory = crate::sink::temp_sibling(&std::env::temp_dir().join("stripe-codecs"));
            std::fs::create_dir(&directory).expect("directory");
            for (width, height) in [(1, 1), (1, 9), (7, 7), (8, 8), (9, 9), (13, 19), (16, 17)] {
                let source = image::RgbaImage::from_fn(width, height, |x, y| {
                    image::Rgba([
                        (x * 17) as u8,
                        (y * 11) as u8,
                        ((x + y) * 7) as u8,
                        if (x + y) % 3 == 0 { 128 } else { 255 },
                    ])
                });
                for format in [
                    OutputFormat::Png,
                    OutputFormat::Jpeg,
                    OutputFormat::Tiff,
                    OutputFormat::Webp,
                ] {
                    let destination =
                        directory.join(format!("{width}-{height}.{}", format.extension()));
                    let budget = MemoryBudget::new(8 << 20);
                    let task = EncoderTask::start(
                        &destination,
                        Size { width, height },
                        5,
                        format,
                        5,
                        Arc::clone(&budget),
                        Controls::default(),
                    )
                    .expect("start encoder");
                    let pipe = Arc::clone(&task.pipe);
                    for y in (0..height).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                        for x in (0..width).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                            let tile = image::imageops::crop_imm(
                                &source,
                                x,
                                y,
                                (width - x).min(5),
                                (height - y).min(5),
                            )
                            .to_image();
                            let reservation = budget
                                .reserve(tile.as_raw().len() as u64, 0)
                                .expect("tile RAM");
                            let placement = TilePlacement {
                                position: Point { x, y },
                                expected_size: None,
                                canvas: None,
                                processing: Default::default(),
                                role: TileRole::output(),
                            };
                            pipe.place(
                                y * width + x,
                                &placement,
                                DecodedTile {
                                    image: tile,
                                    icc_profile: None,
                                    exif_metadata: None,
                                },
                                reservation,
                            )
                            .expect("place tile");
                        }
                    }
                    pipe.finish(&[]);
                    let mut staged =
                        tokio::time::timeout(std::time::Duration::from_secs(3), task.wait())
                            .await
                            .expect("no padding deadlock")
                            .expect("encode");
                    staged
                        .publish(
                            &destination,
                            false,
                            &std::sync::atomic::AtomicBool::new(false),
                        )
                        .expect("publish");
                    let bytes = std::fs::read(&destination).expect("output");
                    if format == OutputFormat::Jpeg {
                        assert_eq!(
                            bytes,
                            crate::imaging::encode_jpeg(&source, 95, None).expect("reference JPEG"),
                            "JPEG {width}x{height}"
                        );
                    } else {
                        assert_eq!(
                            image::load_from_memory(&bytes)
                                .expect("decode output")
                                .into_rgba8(),
                            source,
                            "{format:?} {width}x{height}"
                        );
                    }
                    assert_eq!(pipe.buffered_stripes(), 0, "all declared reads consumed");
                    assert_eq!(pipe.consumed(), u64::from(width) * u64::from(height));
                    assert!(budget.peak() <= 8 << 20);
                    drop(pipe);
                    assert_eq!(budget.current(), 0, "all owned RAM released");
                }
            }
            std::fs::remove_dir_all(directory).expect("cleanup");
        });
    }
    #[test]
    fn cancellation_and_source_failure_wake_waiting_encoders_and_remove_staging() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let directory = crate::sink::temp_sibling(&std::env::temp_dir().join("stripe-abort"));
            std::fs::create_dir(&directory).expect("directory");
            for format in [OutputFormat::Png, OutputFormat::Jpeg] {
                for cancellation in [true, false] {
                    let controls = Controls::default();
                    let task = EncoderTask::start(
                        &directory.join(format.extension()),
                        Size {
                            width: 9,
                            height: 9,
                        },
                        8,
                        format,
                        5,
                        MemoryBudget::new(8 << 20),
                        controls.clone(),
                    )
                    .expect("encoder");
                    let error = if cancellation {
                        controls.cancel();
                        Error::Cancelled
                    } else {
                        let error = Error::WriteFailed("original source failure".into());
                        task.pipe.fail(error.clone());
                        error
                    };
                    let result =
                        tokio::time::timeout(std::time::Duration::from_secs(3), task.wait())
                            .await
                            .expect("failure must wake encoder");
                    assert!(matches!(result, Err(ref cause) if cause == &error));
                    assert_eq!(
                        std::fs::read_dir(&directory)
                            .expect("staging directory")
                            .count(),
                        0
                    );
                }
            }
            std::fs::remove_dir_all(directory).expect("cleanup");
        });
    }
}
