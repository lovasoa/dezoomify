/// JPEG container facts inspected without decoding entropy data. Unsupported
/// frames return None; each output applies its own stricter eligibility rules.
pub(crate) struct Header {
    pub channels: u8,
    pub jfif: bool,
    pub adobe_transform: Option<u8>,
    pub ycbcr_sampling: Option<(u16, u16)>,
    pub rgb_ids: bool,
}

pub(crate) fn header(bytes: &[u8]) -> Option<Header> {
    if !bytes.starts_with(b"\xff\xd8") {
        return None;
    }
    let mut header = Header {
        channels: 0,
        jfif: false,
        adobe_transform: None,
        ycbcr_sampling: None,
        rgb_ids: false,
    };
    let mut at = 2usize;
    while bytes.get(at) == Some(&0xff) {
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0xda {
            return (header.channels != 0).then_some(header);
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let len = usize::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?));
        if len < 2 {
            return None;
        }
        let data = bytes.get(at + 2..at.checked_add(len)?)?;
        if marker == 0xe0 && data.starts_with(b"JFIF\0") {
            header.jfif = true;
        }
        if marker == 0xee && data.starts_with(b"Adobe") {
            header.adobe_transform = data.get(11).copied();
        }
        if matches!(marker, 0xc0 | 0xc2) {
            read_jpeg_frame(data, &mut header)?;
        }
        at += len;
    }
    None
}

fn read_jpeg_frame(data: &[u8], header: &mut Header) -> Option<()> {
    if data.first() != Some(&8) {
        return None;
    }
    header.channels = *data.get(5)?;
    if data.len() != 6 + usize::from(header.channels) * 3 {
        return None;
    }
    if header.channels == 3 {
        let sampling = (u16::from(data[7] >> 4), u16::from(data[7] & 15));
        if data[6] == 1
            && data[9] == 2
            && data[12] == 3
            && data[10] == 0x11
            && data[13] == 0x11
            && (1..=4).contains(&sampling.0)
            && (1..=4).contains(&sampling.1)
        {
            header.ycbcr_sampling = Some(sampling);
        }
        header.rgb_ids = data[6] == b'R' && data[9] == b'G' && data[12] == b'B';
    }
    Some(())
}

/// Tile positions refer to the stored raster. Remove JPEG display transforms
/// in place, preserving compressed pixels and all other EXIF fields.
pub(crate) fn normalize_orientation(bytes: &mut [u8]) {
    if !bytes.starts_with(b"\xff\xd8") {
        return;
    }
    let mut at = 2;
    while bytes.get(at) == Some(&0xff) {
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let Some(&marker) = bytes.get(at) else { break };
        at += 1;
        if matches!(marker, 0xda | 0xd9) {
            break;
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let Some(length) = bytes.get(at..at + 2) else {
            break;
        };
        let len = usize::from(u16::from_be_bytes(
            length.try_into().expect("segment length"),
        ));
        if len < 2 {
            break;
        }
        let Some(data) = bytes.get_mut(at + 2..at + len) else {
            break;
        };
        if marker == 0xe1 && data.starts_with(b"Exif\0\0") {
            let _ = image::metadata::Orientation::remove_from_exif_chunk(&mut data[6..]);
        }
        at += len;
    }
}

// Bounded checks do not decode entropy data.
pub(crate) fn check_structure(bytes: &[u8]) -> Result<(), dezoomify::model::Error> {
    let invalid = super::super::invalid_structure;
    let mut pos = 2;
    let mut scan = false;
    while bytes.get(pos) == Some(&0xff) {
        while bytes.get(pos) == Some(&0xff) {
            pos += 1;
        }
        let marker = *bytes.get(pos).ok_or_else(invalid)?;
        pos += 1;
        if marker == 0xd9 {
            return if scan { Ok(()) } else { Err(invalid()) };
        }
        if marker == 0 || marker == 0xd8 {
            return Err(invalid());
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = bytes.get(pos..pos + 2).ok_or_else(invalid)?;
        let len = u16::from_be_bytes(length.try_into().expect("segment length")) as usize;
        if len < 2 || len > bytes.len().saturating_sub(pos) {
            return Err(invalid());
        }
        pos += len;
        if marker == 0xda {
            scan = true;
            while pos < bytes.len() {
                if bytes[pos] != 0xff {
                    pos += 1;
                    continue;
                }
                let start = pos;
                while bytes.get(pos) == Some(&0xff) {
                    pos += 1;
                }
                let next = *bytes.get(pos).ok_or_else(invalid)?;
                if next == 0 || (0xd0..=0xd7).contains(&next) {
                    pos += 1;
                } else {
                    pos = start;
                    break;
                }
            }
        }
    }
    Err(invalid())
}
