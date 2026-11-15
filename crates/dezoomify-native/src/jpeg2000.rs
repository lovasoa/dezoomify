//! JPEG 2000 adapter: header inspection and incremental, source-grid JP2 output.
use crate::{host::Controls, output::StagedFile, pixel_pipe::PixelPipe, raster::RasterEncoder};
use dezoomify::model::{Error, OutputGrid, Size};
use image::{ImageDecoder, ImageError, ImageResult};
use openjp2::{CoreImage, CoreImageComp, EncodeParameters, J2KFormat, Stream};
use std::sync::Arc;

fn decoding_error(error: impl std::fmt::Display) -> ImageError {
    ImageError::Decoding(image::error::DecodingError::new(
        image::error::ImageFormatHint::Name("JPEG 2000".into()),
        error.to_string(),
    ))
}

pub(crate) struct Decoder {
    codec: openjp2::Decoder,
    stream: Stream,
    size: (u32, u32),
    icc_profile: Option<Vec<u8>>,
}
impl Decoder {
    pub(crate) fn new(bytes: &[u8]) -> ImageResult<Self> {
        let format = openjp2::detect_format(bytes).map_err(decoding_error)?;
        let mut codec = openjp2::Decoder::new(format).map_err(decoding_error)?;
        codec.set_strict(true).map_err(decoding_error)?;
        codec
            .set_limits(
                openjp2::DecodeLimits::new()
                    .max_mem_alloc(u64::MAX)
                    .max_metadata_len(usize::MAX),
            )
            .map_err(decoding_error)?;
        let mut stream = Stream::from_bytes(crate::buffers::copy(bytes)?);
        let header = codec.read_header(&mut stream).map_err(decoding_error)?;
        let size = (header.width(), header.height());
        let core = header.into_core_image();
        if core.icc_profile_is_cielab {
            return Err(decoding_error("JPEG 2000 CIELab images are unsupported"));
        }
        let profile = core.icc_profile_buf;
        Ok(Self {
            codec,
            stream,
            size,
            icc_profile: (!profile.is_empty()).then_some(profile),
        })
    }
}
impl ImageDecoder for Decoder {
    fn dimensions(&self) -> (u32, u32) {
        self.size
    }
    fn color_type(&self) -> image::ColorType {
        image::ColorType::Rgba8
    }
    fn icc_profile(&mut self) -> ImageResult<Option<Vec<u8>>> {
        self.icc_profile
            .as_deref()
            .map(crate::buffers::copy)
            .transpose()
            .map_err(image::ImageError::from)
    }
    fn read_image(mut self, buf: &mut [u8]) -> ImageResult<()> {
        let core = self
            .codec
            .decode(&mut self.stream)
            .map_err(decoding_error)?;
        self.codec
            .end_decompress(&mut self.stream)
            .map_err(decoding_error)?;
        let decoded = openjp2::Image::from_core_image(core);
        let image: image::DynamicImage = (&decoded).try_into().map_err(decoding_error)?;
        if (image.width(), image.height()) != self.size {
            return Err(decoding_error(
                "subsampled JPEG 2000 images are unsupported",
            ));
        }
        buf.copy_from_slice(image.into_rgba8().as_raw());
        Ok(())
    }
    fn read_image_boxed(self: Box<Self>, buf: &mut [u8]) -> ImageResult<()> {
        (*self).read_image(buf)
    }
}

pub(crate) struct Encoder {
    pub(crate) compression: u8,
}
impl RasterEncoder for Encoder {
    fn grid(&self, size: &Size, source: Option<&OutputGrid>) -> Result<Option<OutputGrid>, Error> {
        let grid = source
            .filter(|g| g.tile_size.width > 0 && g.tile_size.height > 0)
            .ok_or_else(|| {
                Error::PlanInvalid("JPEG 2000 output requires a regular source tile grid".into())
            })?;
        let cell = &grid.tile_size;
        let count = u64::from(size.width.div_ceil(cell.width))
            * u64::from(size.height.div_ceil(cell.height));
        if count > 65_535 || cell.width > i32::MAX as u32 || cell.height > i32::MAX as u32 {
            return Err(Error::PlanInvalid(
                "source tile grid exceeds JPEG 2000 format limits".into(),
            ));
        }
        Ok(Some(grid.clone()))
    }
    fn encode(
        self: Box<Self>,
        staging: StagedFile,
        pipe: &Arc<PixelPipe>,
        _controls: &Controls,
    ) -> Result<StagedFile, Error> {
        let mut first = pipe
            .receive_region()?
            .ok_or_else(|| Error::EncodeFailed("empty pixel source".into()))?;
        let cell = pipe.region_size();
        let mut image = CoreImage {
            x1: pipe.size.width,
            y1: pipe.size.height,
            numcomps: 3,
            color_space: openjp2::ColorSpace::Srgb,
            comps: (0..3)
                .map(|_| CoreImageComp {
                    dx: 1,
                    dy: 1,
                    w: pipe.size.width,
                    h: pipe.size.height,
                    prec: 8,
                    bpp: 8,
                    ..Default::default()
                })
                .collect(),
            // The pixel source is RGB. A gray/CMYK profile cannot describe it.
            icc_profile_buf: pipe
                .origin_profile()?
                .filter(|p| p.get(16..20) == Some(b"RGB "))
                .unwrap_or_default(),
            ..Default::default()
        };
        let resolutions = cell
            .width
            .min(cell.height)
            .min(pipe.size.width)
            .min(pipe.size.height)
            .ilog2()
            .min(5)
            + 1;
        let mut params = EncodeParameters::new()
            .tile_size(cell.width, cell.height)
            .num_resolutions(resolutions)
            .irreversible(self.compression != 0)
            .layer_rate(if self.compression == 0 {
                0.0
            } else {
                1.0 + f32::from(self.compression)
            })
            .into_inner();
        let mut codec = openjp2::Encoder::new(J2KFormat::JP2).map_err(encoding_error)?;
        codec
            .setup(&mut params, &mut image)
            .map_err(encoding_error)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(staging.path())
            .map_err(encoding_error)?;
        let mut stream = Stream::new_output(
            64 << 10,
            crate::raster::PipeWriter {
                inner: file,
                pipe: Arc::clone(pipe),
            },
        );
        codec
            .start(&mut image, &mut stream)
            .map_err(encoding_error)?;
        let mut index = 0;
        loop {
            let mut planar = Vec::new();
            planar
                .try_reserve_exact(first.rgba.len() / 4 * 3)
                .map_err(crate::buffers::allocation_error)?;
            for channel in 0..3 {
                planar.extend(first.rgba.as_chunks::<4>().0.iter().map(|p| p[channel]));
            }
            codec
                .write_tile(index, &planar, &mut stream)
                .map_err(encoding_error)?;
            pipe.consumed_region(&first);
            index += 1;
            match pipe.receive_region()? {
                Some(region) => first = region,
                None => break,
            }
        }
        codec.finish(&mut stream).map_err(encoding_error)?;
        stream.flush().map_err(encoding_error)?;
        if let Some(error) = pipe.error() {
            return Err(error);
        }
        // Profile selection does not delay tile encoding; settlement still
        // precedes publication, including cancellation and reused probes.
        pipe.metadata()?;
        Ok(staging)
    }
}
fn encoding_error(error: impl std::fmt::Display) -> Error {
    Error::EncodeFailed(format!("JPEG 2000: {error}").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        imaging::load_image_with_metadata,
        pixel_pipe::tests::{placement, put},
        raster::EncoderTask,
    };
    use dezoomify::model::OutputFormat;
    const RGB_JP2: &[u8] = include_bytes!("../tests/data/jpeg2000/rgb.jp2");
    const RGB_J2K: &[u8] = include_bytes!("../tests/data/jpeg2000/rgb.j2k");

    #[test]
    fn reads_reference_containers_codestreams_and_16_bit_gray() {
        let expected = image::RgbaImage::from_fn(11, 7, |x, y| {
            image::Rgba([(x * 17) as u8, (y * 31) as u8, ((x + y) * 13) as u8, 255])
        });
        for bytes in [RGB_JP2, RGB_J2K] {
            assert_eq!(load_image_with_metadata(bytes).unwrap().image, expected);
            for truncated in [&bytes[..30], &bytes[..bytes.len() - 1]] {
                assert!(load_image_with_metadata(truncated).is_err());
            }
        }
        let gray = load_image_with_metadata(include_bytes!("../tests/data/jpeg2000/gray16.j2k"))
            .unwrap()
            .image;
        assert_eq!(
            gray,
            image::RgbaImage::from_fn(5, 3, |x, y| {
                let v = (((x + 5 * y) * 4096 + 128) / 257) as u8;
                image::Rgba([v, v, v, 255])
            })
        );
    }

    fn grid() -> OutputGrid {
        OutputGrid {
            tile_size: Size {
                width: 17,
                height: 11,
            },
            overlap: Size {
                width: 1,
                height: 1,
            },
        }
    }

    #[tokio::test]
    async fn preserves_source_grid_overlap_edges_and_origin_profile() {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("image.jp2");
        let size = Size {
            width: 43,
            height: 27,
        };
        let source = image::RgbaImage::from_fn(size.width, size.height, |x, y| {
            image::Rgba([x as u8, y as u8, (x ^ y) as u8, 255])
        });
        let mut profile = vec![0; 128];
        profile[16..20].copy_from_slice(b"RGB ");
        let task = EncoderTask::start(
            &path,
            size,
            Some(&grid()),
            OutputFormat::Jpeg2000,
            0,
            Controls::default(),
        )
        .unwrap();
        for row in (0u32..3).rev() {
            for col in (0u32..3).rev() {
                let x = (col * 17).saturating_sub(1);
                let y = (row * 11).saturating_sub(1);
                let right = ((col + 1) * 17 + 1).min(source.width());
                let bottom = ((row + 1) * 11 + 1).min(source.height());
                task.pipe
                    .place(
                        row * 3 + col,
                        &placement(x, y),
                        crate::imaging::DecodedTile {
                            image: image::imageops::crop_imm(&source, x, y, right - x, bottom - y)
                                .to_image(),
                            icc_profile: (col == 0 && row == 0).then(|| profile.clone()),
                            exif_metadata: None,
                        },
                    )
                    .unwrap();
            }
        }
        task.pipe.finish(&[]).unwrap();
        let staged = task.wait().await.unwrap();
        let bytes = std::fs::read(staged.path()).unwrap();
        let decoded = load_image_with_metadata(&bytes).unwrap();
        assert_eq!(decoded.image, source);
        assert_eq!(decoded.icc_profile, Some(profile));
        let mut decoder = openjp2::Decoder::new(J2KFormat::JP2).unwrap();
        decoder.read_header(&mut Stream::from_bytes(bytes)).unwrap();
        let info = decoder.cstr_info().unwrap();
        assert_eq!((info.tdx, info.tdy, info.tw, info.th), (17, 11, 3, 3));
    }

    #[tokio::test]
    async fn encodes_before_acquisition_finishes_and_cleans_up_on_cancellation() {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("out.jp2");
        std::fs::write(&path, b"existing destination").unwrap();
        let controls = Controls::default();
        let task = EncoderTask::start(
            &path,
            Size {
                width: 34,
                height: 11,
            },
            Some(&grid()),
            OutputFormat::Jpeg2000,
            0,
            controls.clone(),
        )
        .unwrap();
        put(
            &task.pipe,
            0,
            0,
            0,
            image::RgbaImage::from_pixel(17, 11, image::Rgba([40, 80, 120, 255])),
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while task.pipe.consumed() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first tile must encode before remaining downloads");
        controls.cancel();
        assert!(matches!(task.wait().await, Err(Error::Cancelled)));
        assert_eq!(std::fs::read(path).unwrap(), b"existing destination");
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn lossy_compression_encodes_within_tolerance() {
        for compression in [1, 100] {
            let work = tempfile::tempdir().unwrap();
            let path = work.path().join("out.jp2");
            let task = EncoderTask::start(
                &path,
                Size {
                    width: 34,
                    height: 11,
                },
                Some(&grid()),
                OutputFormat::Jpeg2000,
                compression,
                Controls::default(),
            )
            .unwrap();
            put(
                &task.pipe,
                0,
                0,
                0,
                image::RgbaImage::from_pixel(17, 11, image::Rgba([40, 80, 120, 255])),
            );
            put(
                &task.pipe,
                1,
                16,
                0,
                image::RgbaImage::from_pixel(18, 11, image::Rgba([40, 80, 120, 255])),
            );
            task.pipe.finish(&[]).unwrap();
            let staged = task.wait().await.unwrap();
            let decoded = load_image_with_metadata(&std::fs::read(staged.path()).unwrap())
                .unwrap()
                .image;
            assert_eq!(decoded.dimensions(), (34, 11));
            assert!(decoded
                .pixels()
                .all(|p| p[0].abs_diff(40) < 5 && p[1].abs_diff(80) < 5 && p[2].abs_diff(120) < 5));
        }
    }

    #[tokio::test]
    async fn rejects_unsupported_grids_before_creating_staging() {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("out.jp2");
        let encoder = Encoder { compression: 0 };
        assert!(encoder
            .grid(
                &Size {
                    width: 1,
                    height: 1
                },
                None
            )
            .is_err());
        let too_many = OutputGrid {
            tile_size: Size {
                width: 1,
                height: 1,
            },
            overlap: Size {
                width: 0,
                height: 0,
            },
        };
        assert!(encoder
            .grid(
                &Size {
                    width: 256,
                    height: 256
                },
                Some(&too_many)
            )
            .is_err());
        assert!(EncoderTask::start(
            &path,
            Size {
                width: 34,
                height: 22
            },
            None,
            OutputFormat::Jpeg2000,
            0,
            Controls::default()
        )
        .is_err());
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }
}
