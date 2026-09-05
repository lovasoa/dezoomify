//! Legacy base64 mapping shared by fixture routes.
//!
//! The legacy Google Arts & Culture client maps both `+` and `-` to value 62
//! and both `/` and `_` to value 63 when decoding, and emits `_` for both 62
//! and 63 when encoding. A single `base64::alphabet::Alphabet` cannot express
//! that ambiguity, so decoding normalizes to the standard alphabet first and
//! encoding maps `+`/`/` to `_` afterwards.

use base64::{
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine,
};

/// Standard-alphabet engine that accepts padded and unpadded input.
pub(crate) static LEGACY_ENGINE: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// Decode legacy base64 (whitespace ignored, `-`/`_` accepted as 62/63).
pub(crate) fn decode(input: impl AsRef<[u8]>) -> Option<Vec<u8>> {
    let normalized: Vec<u8> = input
        .as_ref()
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .map(|b| match b {
            b'-' => b'+',
            b'_' => b'/',
            other => other,
        })
        .collect();
    LEGACY_ENGINE.decode(normalized).ok()
}

/// Encode with the legacy mapping (`+` and `/` both become `_`, no padding).
pub(crate) fn encode_nopad(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    STANDARD_NO_PAD.encode(bytes).replace(['+', '/'], "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The legacy hand-rolled encoder, kept here as a reference oracle.
    fn reference(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789__";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | (*chunk.get(2).unwrap_or(&0) as u32);
            out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[(n & 63) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn encode_matches_legacy_alphabet() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8)
                .map(|i| i.wrapping_mul(37).wrapping_add(11))
                .collect();
            assert_eq!(encode_nopad(&data), reference(&data), "len {len}");
        }
    }

    #[test]
    fn decode_round_trips_legacy_output() {
        for len in 0..40 {
            let data: Vec<u8> = (0..len as u8)
                .map(|i| i.wrapping_mul(53).wrapping_add(7))
                .collect();
            assert_eq!(
                decode(reference(&data)).as_deref(),
                Some(data.as_slice()),
                "len {len}"
            );
        }
    }
}
