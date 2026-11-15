use dezoomify::model::Error;

// Extract PNG ICC data without decoding pixels.
pub(crate) fn icc_profile(bytes: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(None);
    }
    let mut at = 8;
    while let Some(header) = bytes.get(at..at + 8) {
        let len = u32::from_be_bytes(header[..4].try_into().expect("chunk length")) as usize;
        let data = bytes
            .get(at + 8..at + 8 + len)
            .ok_or_else(|| Error::DecodeFailed("truncated PNG metadata".into()))?;
        if &header[4..] == b"iCCP" {
            let start = data
                .iter()
                .position(|&byte| byte == 0)
                .filter(|&name| name > 0 && name <= 79)
                .ok_or_else(|| Error::DecodeFailed("invalid PNG ICC name".into()))?
                + 1;
            if data.get(start) != Some(&0) {
                return Err(Error::DecodeFailed("invalid PNG ICC compression".into()));
            }
            let mut decoder = flate2::read::ZlibDecoder::new(&data[start + 1..]);
            let mut output = crate::buffers::Buffer::default();
            std::io::copy(&mut decoder, &mut output).map_err(|error| {
                Error::DecodeFailed(format!("PNG ICC inflation failed: {error}").into())
            })?;
            return Ok(Some(output.into_vec()));
        }
        at += len + 12;
    }
    Ok(None)
}

// Reuse the metadata encoder; discard the dummy pixel and compressed payload.
pub(super) fn header(icc: Option<&[u8]>, exif: Option<&[u8]>) -> Result<Vec<u8>, Error> {
    let encoded = super::encode(
        &image::RgbaImage::new(1, 1),
        image::codecs::png::CompressionType::Fast,
        icc,
        exif,
    )?;
    let mut result = Vec::new();
    let mut pos = 8;
    while pos + 8 <= encoded.len() {
        let len = u32::from_be_bytes(encoded[pos..pos + 4].try_into().expect("PNG chunk length"))
            as usize;
        let end = pos + len + 12;
        if end > encoded.len() {
            break;
        }
        if matches!(&encoded[pos + 4..pos + 8], b"iCCP" | b"eXIf") {
            result.extend_from_slice(&encoded[pos..end]);
        }
        pos = end;
    }
    Ok(result)
}
