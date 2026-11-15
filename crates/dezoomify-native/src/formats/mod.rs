//! Native output codecs. Shared acquisition and staging call these interfaces.
pub(crate) mod avif;
pub(crate) mod iiif;
pub(crate) mod jpeg;
pub(crate) mod jpeg2000;
pub(crate) mod pdf;
pub(crate) mod png;
pub(crate) mod tiff;
pub(crate) mod webp;
pub(crate) mod zif;

use crate::{
    host::Controls,
    output::{GuardedFile, StagedFile},
    pixel_pipe::PixelPipe,
    raster::PipeWriter,
};
use dezoomify::model::{Error, OutputFormat, OutputGrid, Size};
use std::{
    io::{BufWriter, Write},
    sync::Arc,
};

/// A worker-owned encoder negotiates its pixel regions and workspace before
/// acquisition starts. Encoding consumes regions in order; metadata settlement
/// and cancellation must complete before returning publishable staging.
pub(crate) trait RasterEncoder: Send {
    /// Choose delivery regions before creating the pipe. Returning a grid uses
    /// raster-order cells with overlap cropped; `None` uses full-width strips.
    fn grid(
        &self,
        _size: &Size,
        _source: Option<&OutputGrid>,
    ) -> Result<Option<OutputGrid>, Error> {
        Ok(None)
    }
    /// Conservative preflight estimate, excluding disk staging and OS page cache.
    /// `grid` must be the result of this encoder's negotiation above.
    fn workspace(&self, _size: &Size, _grid: Option<&OutputGrid>) -> u64 {
        0
    }
    fn encode(
        self: Box<Self>,
        staging: StagedFile,
        pipe: &Arc<PixelPipe>,
        controls: &Controls,
    ) -> Result<StagedFile, Error>;
}

pub(crate) type RasterWriter<'a> = BufWriter<PipeWriter<GuardedFile<'a>>>;

/// Full-width strips are consumed in order. Metadata may settle after the last
/// strip; publication waits for `finish_metadata` and source settlement.
pub(crate) trait StripEncoder: Send {
    fn workspace(&self, _size: &Size) -> u64 {
        0
    }
    fn write(&self, output: &mut RasterWriter<'_>, pipe: &Arc<PixelPipe>) -> Result<(), Error>;
    fn finish_metadata(
        &self,
        _staging: &mut StagedFile,
        pipe: &PixelPipe,
        _controls: &Controls,
    ) -> Result<(), Error> {
        pipe.metadata()?;
        Ok(())
    }
}

impl<T: StripEncoder> RasterEncoder for T {
    fn workspace(&self, size: &Size, _grid: Option<&OutputGrid>) -> u64 {
        StripEncoder::workspace(self, size)
    }
    fn encode(
        self: Box<Self>,
        mut staging: StagedFile,
        pipe: &Arc<PixelPipe>,
        controls: &Controls,
    ) -> Result<StagedFile, Error> {
        let result = (|| {
            let mut output = BufWriter::with_capacity(
                64 << 10,
                PipeWriter {
                    inner: staging.writer(controls.cancel_flag()),
                    pipe: Arc::clone(pipe),
                },
            );
            self.write(&mut output, pipe)?;
            output.flush().map_err(encoding_error)
        })();
        if let Some(error) = pipe.error() {
            return Err(error);
        }
        staging.check_error()?;
        result?;
        self.finish_metadata(&mut staging, pipe, controls)?;
        Ok(staging)
    }
}

pub(crate) fn raster_encoder(
    format: OutputFormat,
    compression: u8,
) -> Result<Box<dyn RasterEncoder>, Error> {
    Ok(match format {
        OutputFormat::Png => Box::new(png::Encoder { compression }),
        OutputFormat::Jpeg => Box::new(jpeg::Encoder { compression }),
        OutputFormat::Tiff => Box::new(tiff::Encoder { compression }),
        OutputFormat::Webp => Box::new(webp::Encoder),
        OutputFormat::Avif => Box::new(avif::Encoder { compression }),
        OutputFormat::Jpeg2000 => Box::new(jpeg2000::Encoder { compression }),
        OutputFormat::Zif | OutputFormat::IiifDir | OutputFormat::Pdf => {
            return Err(Error::InvalidState("tile format in raster encoder".into()))
        }
    })
}

fn buffered_pixels(pipe: &PixelPipe) -> Result<image::RgbaImage, Error> {
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
    image::RgbaImage::from_raw(pipe.size.width, pipe.size.height, pixels)
        .ok_or_else(|| Error::InvalidState("incomplete buffered pixels".into()))
}

fn encoding_error(error: impl std::fmt::Display) -> Error {
    Error::EncodeFailed(error.to_string().into())
}

fn invalid_structure() -> Error {
    Error::DecodeFailed("truncated or invalid encoded tile structure".into())
}

// Shared effort tiers for lossless deflate encoders.
fn deflate_level(compression: u8) -> u32 {
    match compression {
        0..=19 => 1,
        20..=60 => 6,
        _ => 9,
    }
}

pub(crate) fn tile_writer(
    destination: &std::path::Path,
    plan: &dezoomify::model::OutputPlan,
    budget: u64,
    compression: u8,
    max_tiles: u32,
    page: Option<crate::DocumentPage>,
) -> Result<Box<dyn crate::tile_output::TileWriter>, Error> {
    Ok(match plan.format {
        OutputFormat::IiifDir => Box::new(iiif::IiifWriter::new(
            destination,
            plan,
            budget,
            compression,
            max_tiles,
        )?),
        OutputFormat::Zif => Box::new(zif::ZifWriter::new(
            destination,
            plan,
            budget,
            compression,
            max_tiles,
        )?),
        OutputFormat::Pdf => Box::new(pdf::PdfWriter::new(
            destination,
            plan,
            budget,
            compression,
            max_tiles,
            page,
        )?),
        _ => {
            return Err(Error::InvalidState(
                "output format does not have an encoded tile writer".into(),
            ))
        }
    })
}

pub(crate) fn probe_needs_preparation(
    format: OutputFormat,
    tile: &crate::encoded_tile::EncodedTile,
    extent: &Size,
) -> bool {
    match format {
        OutputFormat::IiifDir => iiif::probe_needs_preparation(tile, extent),
        OutputFormat::Zif => zif::probe_needs_preparation(tile, extent),
        OutputFormat::Pdf => pdf::probe_needs_preparation(tile, extent),
        _ => false,
    }
}
