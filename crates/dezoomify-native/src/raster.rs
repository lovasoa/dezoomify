//! Concrete encoder worker: own contiguous strips, then read and compress.
use crate::{
    host::Controls,
    output::StagedFile,
    pixel_pipe::{MemoryBudget, PixelPipe, PixelStrip},
};
use dezoomify::model::{Error, OutputFormat, Size};
use std::{
    cell::{Cell, RefCell},
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
        format: OutputFormat,
        compression: u8,
        budget: Arc<MemoryBudget>,
        controls: Controls,
    ) -> Result<Self, Error> {
        if size.width == 0 || size.height == 0 {
            return Err(Error::InvalidState("empty raster dimensions".into()));
        }
        crate::imaging::check_dimensions(format, &size)?;
        let pipe = PixelPipe::new(size.clone(), budget);
        let work = match format {
            OutputFormat::Png => u64::from(size.width) * 16 + (1 << 20),
            OutputFormat::Tiff => {
                u64::from(size.width) * 8 + u64::from(size.height) * 24 + (128 << 10)
            }
            // The WebP API requires a contiguous image and whole-image codec
            // workspace. Reserve this fallback explicitly before acquisition.
            OutputFormat::Webp => u64::from(size.width) * u64::from(size.height) * 32 + (128 << 10),
            // Full RGBA, encoded bytes and rav1e workspace. This is conservative
            // accounting headroom, not a hard bound on the codec's process RSS.
            // check_dimensions bounds both factors to u16::MAX before this sum.
            OutputFormat::Avif => u64::from(size.width) * u64::from(size.height) * 64 + (16 << 20),
            _ => 128 << 10,
        };
        let workspace = pipe.budget.reserve(work)?;
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
                    while let Some(strip) = pipe.receive()? {
                        stream.write_all(&strip.rgba).map_err(encoding_error)?;
                        pipe.consumed_strip(&strip);
                    }
                    stream.finish().map_err(encoding_error)?;
                }
                writer.finish().map_err(encoding_error)?;
            }
            OutputFormat::Jpeg => {
                let view = JpegView::new(pipe)?;
                image::codecs::jpeg::JpegEncoder::new_with_quality(
                    &mut output,
                    100u8.saturating_sub(compression),
                )
                .encode_image(&view)
                .map_err(encoding_error)?;
                pipe.consumed_strip(&view.current.borrow());
            }
            OutputFormat::Tiff => {
                // tiff 0.11's public write_strip does not enable its compressor.
                // Compress each row explicitly and let the directory encoder
                // write offsets and tags.
                use tiff::tags::Tag;
                let mut encoder =
                    tiff::encoder::TiffEncoder::new(&mut output).map_err(encoding_error)?;
                let mut directory = encoder.image_directory().map_err(encoding_error)?;
                for (tag, value) in [
                    (Tag::ImageWidth, pipe.size.width),
                    (Tag::ImageLength, pipe.size.height),
                    (Tag::RowsPerStrip, 1),
                ] {
                    directory.write_tag(tag, value).map_err(encoding_error)?;
                }
                for (tag, value) in [
                    (Tag::SamplesPerPixel, 4u16),
                    (Tag::PhotometricInterpretation, 2),
                    (Tag::Compression, 8),
                ] {
                    directory.write_tag(tag, value).map_err(encoding_error)?;
                }
                for (tag, value) in [
                    (Tag::BitsPerSample, &[8u16; 4][..]),
                    (Tag::ExtraSamples, &[2u16][..]),
                ] {
                    directory.write_tag(tag, value).map_err(encoding_error)?;
                }
                let mut offsets = Vec::with_capacity(pipe.size.height as usize);
                let mut lengths = Vec::with_capacity(pipe.size.height as usize);
                let level = crate::imaging::tiff_compression_for(compression) as u32;
                while let Some(strip) = pipe.receive()? {
                    for row in strip.rgba.chunks_exact(pipe.size.width as usize * 4) {
                        let mut compressed = flate2::write::ZlibEncoder::new(
                            Vec::new(),
                            flate2::Compression::new(level),
                        );
                        compressed.write_all(row).map_err(encoding_error)?;
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
                    pipe.consumed_strip(&strip);
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
            OutputFormat::Avif => {
                let length = u64::from(pipe.size.width) * u64::from(pipe.size.height) * 4;
                let length = usize::try_from(length).map_err(encoding_error)?;
                let mut pixels = Vec::new();
                pixels.try_reserve_exact(length).map_err(encoding_error)?;
                while let Some(strip) = pipe.receive()? {
                    pixels.extend_from_slice(&strip.rgba);
                    pipe.consumed_strip(&strip);
                }
                if let Some(error) = pipe.error() {
                    return Err(error);
                }
                // AvifEncoder is synchronous and buffers its result internally;
                // keep our completed output in memory until encoding succeeds.
                let mut encoded = BufferedAvif::default();
                image::ImageEncoder::write_image(
                    image::codecs::avif::AvifEncoder::new_with_speed_quality(
                        &mut encoded,
                        4,
                        100u8.saturating_sub(compression).max(1),
                    )
                    .with_num_threads(Some(1)),
                    &pixels,
                    pipe.size.width,
                    pipe.size.height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(encoding_error)?;
                if let Some(error) = pipe.error() {
                    return Err(error);
                }
                output.write_all(&encoded.0).map_err(encoding_error)?;
            }
            OutputFormat::Webp => {
                let mut pixels =
                    Vec::with_capacity(pipe.size.width as usize * pipe.size.height as usize * 4);
                while let Some(strip) = pipe.receive()? {
                    pixels.extend_from_slice(&strip.rgba);
                    pipe.consumed_strip(&strip);
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
    staging.check_error()?;
    result?;
    let (icc, exif) = pipe.metadata()?;
    if matches!(format, OutputFormat::Png | OutputFormat::Jpeg)
        && (icc.is_some() || (format == OutputFormat::Png && exif.is_some()))
    {
        let metadata_bytes = icc.as_ref().map_or(0, Vec::len) + exif.as_ref().map_or(0, Vec::len);
        let _metadata_memory = pipe
            .budget
            .reserve(metadata_bytes as u64 * 4 + (128 << 10))?;
        let bytes = metadata_header(format, icc.as_deref(), exif.as_deref())?;
        let offset = if format == OutputFormat::Png {
            33
        } else {
            // Keep JFIF APP0 immediately after SOI, matching encode_jpeg.
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

/// Fallible allocation for the completed AVIF file, before any disk writes.
#[derive(Default)]
struct BufferedAvif(Vec<u8>);
impl Write for BufferedAvif {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .try_reserve(bytes.len())
            .map_err(std::io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// image's JPEG encoder finishes full-width eight-row bands in order.
/// Only advancing to the next strip synchronizes with the producer.
struct JpegView<'a> {
    pipe: &'a PixelPipe,
    current: RefCell<PixelStrip>,
    failed: Cell<bool>,
}
impl<'a> JpegView<'a> {
    fn new(pipe: &'a PixelPipe) -> Result<Self, Error> {
        let current = pipe
            .receive()?
            .ok_or_else(|| Error::Internal("empty pixel stream".into()))?;
        Ok(Self {
            pipe,
            current: RefCell::new(current),
            failed: Cell::new(false),
        })
    }
    fn advance(&self, y: u32) -> Result<(), Error> {
        let mut current = self.current.borrow_mut();
        self.pipe.consumed_strip(&current);
        let next = self
            .pipe
            .receive()?
            .ok_or_else(|| Error::Internal("JPEG exceeded pixel stream".into()))?;
        if y != next.first_row {
            return Err(Error::Internal("JPEG traversal skipped a strip".into()));
        }
        *current = next;
        Ok(())
    }
}
impl image::GenericImageView for JpegView<'_> {
    type Pixel = image::Rgb<u8>;
    fn dimensions(&self) -> (u32, u32) {
        (self.pipe.size.width, self.pipe.size.height)
    }
    #[inline]
    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        if self.failed.get() {
            return image::Rgb([0; 3]);
        }
        let strip = self.current.borrow();
        if y < strip.first_row {
            drop(strip);
            self.failed.set(true);
            self.pipe
                .fail(Error::Internal("JPEG revisited a released strip".into()));
            return image::Rgb([0; 3]);
        }
        if y >= strip.first_row + strip.rows {
            drop(strip);
            if let Err(error) = self.advance(y) {
                self.failed.set(true);
                self.pipe.fail(error);
                return image::Rgb([0; 3]);
            }
            return self.get_pixel(x, y);
        }
        let offset =
            ((y - strip.first_row) as usize * self.pipe.size.width as usize + x as usize) * 4;
        let rgb = &strip.rgba[offset..offset + 3];
        image::Rgb([rgb[0], rgb[1], rgb[2]])
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
    use crate::{
        imaging::DecodedTile,
        pixel_pipe::{
            tests::{placement, put},
            ReceivedPixels,
        },
    };
    const FORMATS: [OutputFormat; 4] = [
        OutputFormat::Png,
        OutputFormat::Jpeg,
        OutputFormat::Tiff,
        OutputFormat::Webp,
    ];

    fn directory() -> std::path::PathBuf {
        let path = crate::output::temp_sibling(&std::env::temp_dir().join("raster-test"));
        std::fs::create_dir(&path).unwrap();
        path
    }
    fn start(path: &Path, format: OutputFormat, size: Size, controls: Controls) -> EncoderTask {
        let cap = if format == OutputFormat::Avif {
            32 << 20
        } else {
            8 << 20
        };
        EncoderTask::start(path, size, format, 5, MemoryBudget::new(cap), controls).unwrap()
    }
    async fn publish(task: EncoderTask, destination: &Path) -> Vec<u8> {
        task.pipe.finish(&[]).unwrap();
        let mut staged = tokio::time::timeout(std::time::Duration::from_secs(3), task.wait())
            .await
            .expect("encoder must finish")
            .unwrap();
        staged
            .publish(
                destination,
                false,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        std::fs::read(destination).unwrap()
    }

    #[tokio::test]
    async fn metadata_is_finalized_after_pixels_without_recompressing_the_image() {
        let directory = directory();
        let icc = vec![
            0, 0, 2, 12, 0x61, 0x64, 0x73, 0x70, 0, 0, 0, 0, 0x6d, 0x6e, 0x74, 0x72, 0x52, 0x47,
            0x42, 0x20,
        ];
        let exif = vec![0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a];
        let source = image::RgbaImage::from_pixel(2, 1, image::Rgba([40, 80, 120, 255]));
        for format in FORMATS {
            let destination = directory.join(format.extension());
            let task = start(
                &destination,
                format,
                Size {
                    width: 2,
                    height: 1,
                },
                Controls::default(),
            );
            for x in [1, 0] {
                task.pipe
                    .place(
                        x,
                        &placement(x, 0),
                        ReceivedPixels::new(
                            DecodedTile {
                                image: image::imageops::crop_imm(&source, x, 0, 1, 1).to_image(),
                                icc_profile: (x == 1).then(|| icc.clone()),
                                exif_metadata: (x == 0).then(|| exif.clone()),
                            },
                            task.pipe.budget.reserve(4).unwrap(),
                        )
                        .unwrap(),
                    )
                    .unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while task.pipe.consumed() != 2 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("pixels must be read before metadata finalization");
            let bytes = publish(task, &destination).await;
            if format == OutputFormat::Tiff {
                let mut decoder =
                    tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
                assert_eq!(
                    decoder.get_tag_u8_vec(tiff::tags::Tag::IccProfile).unwrap(),
                    icc
                );
            } else {
                let decoded = crate::imaging::load_image_with_metadata(&bytes).unwrap();
                assert_eq!(decoded.icc_profile.as_ref(), Some(&icc));
                if format == OutputFormat::Png {
                    assert_eq!(decoded.exif_metadata.as_ref(), Some(&exif));
                }
            }
            if format == OutputFormat::Jpeg {
                assert_eq!(
                    bytes,
                    crate::imaging::encode_jpeg(&source, 95, Some(&icc)).unwrap()
                );
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn codecs_match_pixels_across_strip_handoffs_and_jpeg_edge_padding() {
        let directory = directory();
        for (width, height) in [
            (1, 1),
            (1, 9),
            (7, 7),
            (8, 8),
            (9, 9),
            (13, 19),
            (16, 17),
            (1, 65),
            (9, 64),
            (13, 129),
        ] {
            let source = image::RgbaImage::from_fn(width, height, |x, y| {
                image::Rgba([
                    (x * 17) as u8,
                    (y * 11) as u8,
                    ((x + y) * 7) as u8,
                    if (x + y) % 3 == 0 { 128 } else { 255 },
                ])
            });
            for format in FORMATS {
                let destination =
                    directory.join(format!("{width}-{height}.{}", format.extension()));
                let task = start(
                    &destination,
                    format,
                    Size { width, height },
                    Controls::default(),
                );
                let pipe = Arc::clone(&task.pipe);
                let budget = Arc::clone(&pipe.budget);
                for y in (0..height).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                    for x in (0..width).step_by(5).collect::<Vec<_>>().into_iter().rev() {
                        put(
                            &pipe,
                            y * width + x,
                            x,
                            y,
                            image::imageops::crop_imm(
                                &source,
                                x,
                                y,
                                (width - x).min(5),
                                (height - y).min(5),
                            )
                            .to_image(),
                        );
                    }
                }
                let bytes = publish(task, &destination).await;
                if format == OutputFormat::Jpeg {
                    assert_eq!(
                        bytes,
                        crate::imaging::encode_jpeg(&source, 95, None).unwrap(),
                        "{width}x{height}"
                    );
                } else {
                    assert_eq!(
                        image::load_from_memory(&bytes).unwrap().into_rgba8(),
                        source,
                        "{format:?} {width}x{height}"
                    );
                }
                assert_eq!(pipe.queued_strips(), 0);
                assert_eq!(pipe.consumed(), u64::from(width) * u64::from(height));
                drop(pipe);
                assert_eq!(budget.current(), 0, "all allocations released");
                assert!(budget.peak() <= 8 << 20);
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn cancellation_and_source_failure_wake_waiting_encoders_and_remove_staging() {
        let directory = directory();
        for format in FORMATS.into_iter().chain([OutputFormat::Avif]) {
            for cancellation in [true, false] {
                let controls = Controls::default();
                let task = start(
                    &directory.join(format.extension()),
                    format,
                    Size {
                        width: 9,
                        height: 9,
                    },
                    controls.clone(),
                );
                let error = if cancellation {
                    controls.cancel();
                    Error::Cancelled
                } else {
                    let error = Error::WriteFailed("original source failure".into());
                    task.pipe.fail(error.clone());
                    error
                };
                let result = tokio::time::timeout(std::time::Duration::from_secs(3), task.wait())
                    .await
                    .expect("reader must wake");
                assert!(matches!(result, Err(cause) if cause == error));
                assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn avif_limits_fail_before_staging_and_release_reservations() {
        use dezoomify::model::LimitReason;
        let directory = directory();
        for (size, reason) in [
            (
                Size {
                    width: 65_536,
                    height: 1,
                },
                LimitReason::AvifSide,
            ),
            (
                Size {
                    width: 1,
                    height: 65_536,
                },
                LimitReason::AvifSide,
            ),
            (
                Size {
                    width: 512,
                    height: 512,
                },
                LimitReason::Memory,
            ),
        ] {
            let budget = MemoryBudget::new(8 << 20);
            let result = EncoderTask::start(
                &directory.join("output.avif"),
                size,
                OutputFormat::Avif,
                5,
                Arc::clone(&budget),
                Controls::default(),
            );
            assert!(
                matches!(result, Err(Error::LimitExceeded { limit }) if limit.reason == reason)
            );
            assert_eq!(budget.current(), 0);
            assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        }
        let task = start(
            &directory.join("boundary.avif"),
            OutputFormat::Avif,
            Size {
                width: 65_535,
                height: 1,
            },
            Controls::default(),
        );
        let budget = Arc::clone(&task.pipe.budget);
        task.abort().await;
        assert_eq!(budget.current(), 0);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn avif_cancel_after_pixels_never_replaces_existing_output() {
        let directory = directory();
        let destination = directory.join("existing.avif");
        std::fs::write(&destination, b"previous output").unwrap();
        let controls = Controls::default();
        let task = start(
            &destination,
            OutputFormat::Avif,
            Size {
                width: 129,
                height: 65,
            },
            controls.clone(),
        );
        let budget = Arc::clone(&task.pipe.budget);
        put(
            &task.pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(129, 65, image::Rgba([120, 40, 80, 128])),
        );
        task.pipe.finish(&[]).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while task.pipe.consumed() != 129 * 65 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        controls.cancel();
        // If the codec already finished, publication still checks cancellation.
        match task.wait().await {
            Err(error) => assert_eq!(error, Error::Cancelled),
            Ok(mut staged) => assert_eq!(
                staged.publish(&destination, true, controls.cancel_flag()),
                Err(Error::Cancelled)
            ),
        }
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous output");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(budget.current(), 0);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn avif_quality_endpoints_preserve_dimensions_colors_and_alpha() {
        let directory = directory();
        for compression in [0, 5, 99, 100] {
            let destination = directory.join(format!("quality-{compression}.avif"));
            let budget = MemoryBudget::new(32 << 20);
            let task = EncoderTask::start(
                &destination,
                Size {
                    width: 33,
                    height: 19,
                },
                OutputFormat::Avif,
                compression,
                Arc::clone(&budget),
                Controls::default(),
            )
            .unwrap();
            let source = image::RgbaImage::from_fn(33, 19, |x, _| {
                image::Rgba([120, 40, 80, if x < 16 { 128 } else { 255 }])
            });
            // Arrive out of order across a tile boundary.
            for (id, x, width) in [(1, 16, 17), (0, 0, 16)] {
                put(
                    &task.pipe,
                    id,
                    x,
                    0,
                    image::imageops::crop_imm(&source, x, 0, width, 19).to_image(),
                );
            }
            publish(task, &destination).await;
            let decoded = std::process::Command::new("node")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../test/support/decode-image.mjs"
                ))
                .arg(&destination)
                .output()
                .unwrap();
            assert!(
                decoded.status.success(),
                "{}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            assert_eq!(
                u32::from_le_bytes(decoded.stdout[0..4].try_into().unwrap()),
                33
            );
            assert_eq!(
                u32::from_le_bytes(decoded.stdout[4..8].try_into().unwrap()),
                19
            );
            let rgba = &decoded.stdout[8..];
            assert_eq!(rgba.len(), 33 * 19 * 4);
            // Flat colors remain recognizable even at quality 1. Quality 95+
            // has tighter tolerances, and alpha must survive on both sides.
            let tolerance = if compression <= 5 { 5 } else { 35 };
            for (x, alpha) in [(8, 128u8), (24, 255u8)] {
                let pixel = &rgba[(9 * 33 + x) * 4..][..4];
                for (actual, expected) in pixel.iter().zip([120, 40, 80, alpha]) {
                    assert!(
                        actual.abs_diff(expected) <= tolerance,
                        "compression {compression}: {pixel:?}"
                    );
                }
            }
            assert_eq!(budget.current(), 0);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
