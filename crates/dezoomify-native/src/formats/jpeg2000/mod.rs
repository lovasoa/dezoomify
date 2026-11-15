//! JPEG 2000 adapter: header inspection and incremental, source-grid JP2 output.
use crate::{formats::RasterEncoder, host::Controls, output::StagedFile, pixel_pipe::PixelPipe};
use dezoomify::model::{Error, OutputGrid, Size};
use openjp2::{CoreImage, CoreImageComp, EncodeParameters, J2KFormat, Stream};
use std::sync::Arc;

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

mod decoder;
pub(crate) use decoder::Decoder;

pub(crate) fn matches(bytes: &[u8]) -> bool {
    openjp2::detect_format(bytes).is_ok()
}

#[cfg(test)]
mod tests;
