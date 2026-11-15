//! Required source conversion stays in acquisition so failures retain the tile's
//! request context and retry handling. Finalization may decode stored tiles for
//! pyramid generation, but must not reacquire missing source data.
use crate::{codecs::NativeFormat, encoded_tile::EncodedTile, iiif_output::IiifWriter};
use dezoomify::model::{Error, OutputPlan, ReusedTile};
use std::{path::Path, sync::atomic::AtomicBool};

/// Validate/conform output probes before they become geometry observations.
/// Document pages clip encoded tiles themselves; pyramids require exact extents.
pub(crate) fn probe_needs_preparation(
    format: dezoomify::model::OutputFormat,
    tile: &EncodedTile,
    extent: &dezoomify::model::Size,
) -> bool {
    if format.supports_pages() {
        return !crate::pdf_images::can_reuse(tile);
    }
    *extent != tile.size
        || (format == dezoomify::model::OutputFormat::Zif
            && !crate::zif_output::can_reuse(&tile.bytes))
        || !matches!(
            tile.format,
            NativeFormat::Image(image::ImageFormat::Png | image::ImageFormat::Jpeg)
        )
}

/// Concrete containers behind one encoded acquisition/publication route.
pub(crate) enum TileWriter {
    Iiif(IiifWriter),
    Zif(crate::zif_output::ZifWriter),
    Pdf(crate::pdf_output::PdfWriter),
}
impl TileWriter {
    pub(crate) fn peak_retained(&self) -> u64 {
        match self {
            Self::Iiif(writer) => writer.peak_retained(),
            Self::Zif(writer) => writer.peak_retained(),
            Self::Pdf(writer) => writer.peak_retained(),
        }
    }

    pub(crate) fn new(
        destination: &Path,
        plan: &OutputPlan,
        compression: u8,
        max_tiles: u32,
        page: Option<crate::DocumentPage>,
    ) -> Result<Self, Error> {
        match plan.format {
            dezoomify::model::OutputFormat::Pdf => {
                crate::pdf_output::PdfWriter::new(destination, plan, compression, max_tiles, page)
                    .map(Self::Pdf)
            }
            dezoomify::model::OutputFormat::IiifDir => {
                IiifWriter::new(destination, plan, compression, max_tiles).map(Self::Iiif)
            }
            dezoomify::model::OutputFormat::Zif => {
                crate::zif_output::ZifWriter::new(destination, plan, compression, max_tiles)
                    .map(Self::Zif)
            }
            _ => Err(Error::InvalidState(
                "output format does not have an encoded tile writer".into(),
            )),
        }
    }
    pub(crate) fn place(&mut self, tile: EncodedTile, cancelled: &AtomicBool) -> Result<(), Error> {
        match self {
            Self::Iiif(writer) => writer.place(tile, cancelled),
            Self::Zif(writer) => writer.place(tile, cancelled),
            Self::Pdf(writer) => writer.place(tile, cancelled),
        }
    }
    pub(crate) fn finish(
        self,
        destination: &Path,
        reused: &[ReusedTile],
        cancelled: &AtomicBool,
    ) -> Result<crate::output::PreparedOutput, Error> {
        match self {
            Self::Iiif(writer) => writer.finish(destination, reused, cancelled),
            Self::Zif(writer) => writer.finish(reused, cancelled),
            Self::Pdf(writer) => writer.finish(reused, cancelled),
        }
    }
}
