use super::super::encoding_error;
use crate::{host::Controls, output::StagedFile, pixel_pipe::PixelPipe};
use dezoomify::model::Error;
use std::io::Read;

pub(super) fn finish(
    staging: &mut StagedFile,
    pipe: &PixelPipe,
    controls: &Controls,
) -> Result<(), Error> {
    let (icc, _) = pipe.metadata()?;
    if let Some(icc) = icc {
        let bytes = header(&icc)?;
        // Keep JFIF APP0 immediately after SOI, matching the local JPEG encoder.
        let mut prefix = [0; 6];
        std::fs::File::open(staging.path())
            .and_then(|mut file| file.read_exact(&mut prefix))
            .map_err(encoding_error)?;
        let offset = if prefix[2..4] == [0xff, 0xe0] {
            4 + u64::from(u16::from_be_bytes([prefix[4], prefix[5]]))
        } else {
            2
        };
        staging.insert_header(offset, &bytes, controls.cancel_flag())?;
    }
    Ok(())
}

// Reuse the ICC encoder; discard the dummy pixel and compressed payload.
fn header(icc: &[u8]) -> Result<Vec<u8>, Error> {
    let encoded = super::encode(&image::RgbaImage::new(1, 1), 95, Some(icc))?;
    let mut result = Vec::new();
    let mut pos = 2;
    while pos + 8 <= encoded.len() {
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
    Ok(result)
}
