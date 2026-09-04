//! Bounded Native Messaging framing (Phase 12).
//!
//! Pure length-prefix codec for the `dezoomify-native-host` binary.
//! - One browser-defined native-endian 32-bit length-prefixed JSON message
//!   from stdin at a time; bounded framed responses to stdout.
//! - Conservative maximum (1 MiB) enforced BEFORE allocation.
//! - Handles partial reads, EOF, zero/oversized lengths, malformed JSON
//!   shape at the framing layer (JSON parsing itself is done by callers).
//! - No `std::net`, no I/O here: only pure byte-slice functions so unit
//!   tests and fuzzers can drive them without processes or sockets.
//! - Diagnostics belong on stderr and must be redacted (see `redaction.rs`).

/// Maximum message body in bytes (conservative, below browser limits).
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Length prefix size in bytes (native-endian u32).
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Framing errors. Never carries message bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Length prefix claims more than [`MAX_MESSAGE_BYTES`].
    Oversized { claimed: u32 },
    /// Payload longer than caller's buffer allows (defensive).
    BufferTooShort,
}

/// Encode a payload into a single framed message.
///
/// Returns `Err(Oversized)` without allocating when `payload` exceeds max.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(FrameError::Oversized {
            claimed: payload.len() as u32,
        });
    }
    let mut out = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Parse the native-endian u32 length prefix.
///
/// Returns `None` when fewer than 4 bytes are available (partial read).
pub fn parse_length_prefix(buffer: &[u8]) -> Option<u32> {
    if buffer.len() < LENGTH_PREFIX_BYTES {
        return None;
    }
    let mut arr = [0u8; 4];
    arr.copy_from_slice(&buffer[..4]);
    Some(u32::from_ne_bytes(arr))
}

/// Try to parse one framed message from the front of `buffer`.
///
/// - `Ok(None)` — need more bytes (partial read) or empty buffer (EOF idle).
/// - `Ok(Some((payload, consumed)))` — one full message; `consumed` counts
///   prefix + body so callers can drain and parse the next message.
/// - `Err(Oversized)` — prefix claims > max; caller must drop the channel
///   without allocating `claimed` bytes.
/// - Zero-length bodies (`claimed == 0`) are returned as empty payloads;
///   callers treat empty JSON as malformed at the envelope layer.
pub fn try_parse_frame(buffer: &[u8]) -> Result<Option<(Vec<u8>, usize)>, FrameError> {
    if buffer.is_empty() {
        return Ok(None);
    }
    let claimed = match parse_length_prefix(buffer) {
        None => return Ok(None),
        Some(n) => n,
    };
    if claimed as usize > MAX_MESSAGE_BYTES {
        return Err(FrameError::Oversized { claimed });
    }
    let need = LENGTH_PREFIX_BYTES + claimed as usize;
    if buffer.len() < need {
        return Ok(None);
    }
    let payload = buffer[LENGTH_PREFIX_BYTES..need].to_vec();
    Ok(Some((payload, need)))
}

/// True when `buffer` holds no bytes (clean EOF state, no partial frame).
pub fn is_clean_eof(buffer: &[u8]) -> bool {
    buffer.is_empty()
}

/// True when `buffer` holds a truncated prefix/body (dirty EOF).
pub fn is_truncated(buffer: &[u8]) -> bool {
    !buffer.is_empty() && try_parse_frame(buffer).map(|o| o.is_none()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_single_message() {
        let payload = br#"{"v":2}"#;
        let framed = encode_frame(payload).unwrap();
        assert_eq!(framed.len(), 4 + payload.len());
        let parsed = try_parse_frame(&framed).unwrap().unwrap();
        assert_eq!(parsed.0, payload);
        assert_eq!(parsed.1, framed.len());
    }

    #[test]
    fn partial_prefix_needs_more() {
        assert_eq!(try_parse_frame(&[]).unwrap(), None);
        assert_eq!(try_parse_frame(&[1, 2]).unwrap(), None);
    }

    #[test]
    fn partial_body_needs_more() {
        let framed = encode_frame(b"hello").unwrap();
        assert_eq!(try_parse_frame(&framed[..5]).unwrap(), None);
    }

    #[test]
    fn oversized_rejected_before_allocation() {
        let mut buf = (2u32 * 1024 * 1024).to_ne_bytes().to_vec();
        buf.extend_from_slice(b"{}");
        assert_eq!(
            try_parse_frame(&buf),
            Err(FrameError::Oversized {
                claimed: 2 * 1024 * 1024
            })
        );
        assert!(encode_frame(&vec![0u8; MAX_MESSAGE_BYTES + 1]).is_err());
    }

    #[test]
    fn zero_length_is_empty_payload() {
        let framed = encode_frame(b"").unwrap();
        let (payload, consumed) = try_parse_frame(&framed).unwrap().unwrap();
        assert!(payload.is_empty());
        assert_eq!(consumed, 4);
    }

    #[test]
    fn multiple_messages_drain_in_order() {
        let a = encode_frame(b"a").unwrap();
        let b = encode_frame(b"bb").unwrap();
        let mut buf = Vec::new();
        buf.extend_from_slice(&a);
        buf.extend_from_slice(&b);
        let (p1, c1) = try_parse_frame(&buf).unwrap().unwrap();
        assert_eq!(p1, b"a");
        let (p2, c2) = try_parse_frame(&buf[c1..]).unwrap().unwrap();
        assert_eq!(p2, b"bb");
        assert_eq!(c1 + c2, buf.len());
    }
}
