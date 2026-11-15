use image::{ImageDecoder, ImageError, ImageResult};
use openjp2::Stream;

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
