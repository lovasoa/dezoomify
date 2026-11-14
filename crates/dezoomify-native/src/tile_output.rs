//! Concrete encoded-tile writer selection; acquisition and publication are shared.
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
    /// Remaining space for one encoded input, after retained output, container
    /// indexes, and outstanding input/probe reservations have been withheld.
    pub(crate) fn input_budget(&self) -> u64 {
        match self {
            Self::Iiif(writer) => writer.input_budget(),
            Self::Zif(writer) => writer.input_budget(),
            Self::Pdf(writer) => writer.input_budget(),
        }
    }

    pub(crate) fn retained_bytes(&self) -> u64 {
        match self {
            Self::Iiif(writer) => writer.retained_bytes(),
            Self::Zif(writer) => writer.retained_bytes(),
            Self::Pdf(writer) => writer.retained_bytes(),
        }
    }

    pub(crate) fn hold_queued_bytes(&mut self, bytes: u64) -> Result<(), Error> {
        match self {
            Self::Iiif(writer) => writer.hold_queued_bytes(bytes),
            Self::Zif(writer) => writer.hold_queued_bytes(bytes),
            Self::Pdf(writer) => writer.hold_queued_bytes(bytes),
        }
    }

    pub(crate) fn release_probe_bytes(&mut self, bytes: u64) {
        match self {
            Self::Iiif(writer) => writer.release_probe_bytes(bytes),
            Self::Zif(writer) => writer.release_probe_bytes(bytes),
            Self::Pdf(writer) => writer.release_probe_bytes(bytes),
        }
    }

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
        budget: u64,
        compression: u8,
        max_tiles: u32,
        page: Option<crate::DocumentPage>,
    ) -> Result<Self, Error> {
        match plan.format {
            dezoomify::model::OutputFormat::Pdf => crate::pdf_output::PdfWriter::new(
                destination,
                plan,
                budget,
                compression,
                max_tiles,
                page,
            )
            .map(Self::Pdf),
            dezoomify::model::OutputFormat::IiifDir => {
                IiifWriter::new(destination, plan, budget, compression, max_tiles).map(Self::Iiif)
            }
            dezoomify::model::OutputFormat::Zif => {
                crate::zif_output::ZifWriter::new(destination, plan, budget, compression, max_tiles)
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
