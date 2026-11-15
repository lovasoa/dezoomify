/// PNG header/chunk facts, shared by encoded output profiles. Pixel bytes stay
/// compressed; structural validation belongs to `inspect` before this call.
pub(crate) struct Header {
    pub bits: u8,
    pub color: u8,
    pub interlaced: bool,
    pub transparent: bool,
    pub color_chunks: bool,
    pub icc: bool,
}

pub(crate) fn header(bytes: &[u8]) -> Option<Header> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut header = Header {
        bits: *bytes.get(24)?,
        color: *bytes.get(25)?,
        interlaced: *bytes.get(28)? != 0,
        transparent: false,
        color_chunks: false,
        icc: false,
    };
    let mut at = 8usize;
    while let Some(chunk) = bytes.get(at..at.checked_add(8)?) {
        header.transparent |= &chunk[4..] == b"tRNS";
        header.color_chunks |= matches!(&chunk[4..], b"gAMA" | b"cHRM" | b"sRGB");
        header.icc |= &chunk[4..] == b"iCCP";
        if &chunk[4..] == b"IEND" {
            return Some(header);
        }
        at = at
            .checked_add(u32::from_be_bytes(chunk[..4].try_into().ok()?) as usize)?
            .checked_add(12)?;
    }
    None
}

// Bounded checks do not decompress pixels or validate zlib.
pub(crate) fn check_structure(bytes: &[u8]) -> Result<(), dezoomify::model::Error> {
    let invalid = super::super::invalid_structure;
    let mut pos = 8usize;
    let mut data = false;
    while let Some(header) = bytes.get(pos..pos + 8) {
        let len = u32::from_be_bytes(header[..4].try_into().expect("chunk length")) as usize;
        let end = pos
            .checked_add(len)
            .and_then(|v| v.checked_add(12))
            .ok_or_else(invalid)?;
        if end > bytes.len() {
            return Err(invalid());
        }
        match &header[4..] {
            b"IHDR" if pos == 8 && len != 13 => return Err(invalid()),
            b"IDAT" => data = true,
            b"IEND" => {
                return if len == 0 && data {
                    Ok(())
                } else {
                    Err(invalid())
                }
            }
            _ => {}
        }
        pos = end;
    }
    Err(invalid())
}

/// Concatenate compressed scanlines without decoding pixels. Call after inspection.
pub(crate) fn image_data(bytes: &[u8]) -> Result<Vec<u8>, dezoomify::model::Error> {
    use dezoomify::model::Error;
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(bytes.len())
        .map_err(crate::buffers::allocation_error)?;
    let mut at = 8usize;
    while let Some(chunk) = bytes.get(at..at.saturating_add(8)) {
        let length = u32::from_be_bytes(chunk[..4].try_into().expect("chunk length")) as usize;
        if &chunk[4..] == b"IDAT" {
            payload.extend_from_slice(
                bytes
                    .get(at + 8..at + 8 + length)
                    .ok_or_else(|| Error::DecodeFailed("truncated PNG data".into()))?,
            );
        }
        at = at
            .checked_add(length)
            .and_then(|end| end.checked_add(12))
            .ok_or_else(|| Error::DecodeFailed("PNG chunk overflow".into()))?;
    }
    Ok(payload)
}
