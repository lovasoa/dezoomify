use super::{encoding_error, RasterWriter, StripEncoder};
use crate::pixel_pipe::PixelPipe;
use dezoomify::model::Error;
use std::{io::Write, sync::Arc};

pub(crate) struct Encoder {
    pub(crate) compression: u8,
}

impl StripEncoder for Encoder {
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error> {
        // tiff 0.11's public write_strip does not enable its compressor.
        // Compress each row explicitly and let the directory encoder
        // write offsets and tags.
        use tiff::tags::Tag;
        let mut encoder = tiff::encoder::TiffEncoder::new(output).map_err(encoding_error)?;
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
        let mut offsets = Vec::new();
        offsets
            .try_reserve_exact(pipe.size.height as usize)
            .map_err(crate::buffers::allocation_error)?;
        let mut lengths = Vec::new();
        lengths
            .try_reserve_exact(pipe.size.height as usize)
            .map_err(crate::buffers::allocation_error)?;
        let level = super::deflate_level(self.compression);
        while let Some(strip) = pipe.receive()? {
            for row in strip.rgba.chunks_exact(pipe.size.width as usize * 4) {
                let mut compressed = flate2::write::ZlibEncoder::new(
                    crate::buffers::Buffer::default(),
                    flate2::Compression::new(level),
                );
                compressed.write_all(row).map_err(encoding_error)?;
                let bytes = compressed.finish().map_err(encoding_error)?.into_vec();
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
        Ok(())
    }
}
