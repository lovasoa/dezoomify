//! Arts & Culture signed-tile verification and AES-CBC decryption.
//!
//! Faithful port of `arts-culture-crypto.js`: HMAC-SHA1 (hex key) over
//! `arts/<path|plain>=x{X}-y{Y}-z{Z}-t<token>` with legacy base64 mapping;
//! tile container parsing (magic, prefix, replace-count, suffix) with the
//! encrypt-pad/decrypt-truncate workaround. Mismatch yields `None` (403).

use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

use crate::b64;

const HMAC_KEY: &[u8] = &[0x7b, 0x2b, 0x4e, 0x23, 0xde, 0x2c, 0xc5, 0xc5];
const AES_KEY: [u8; 16] = [
    0x5b, 0x63, 0xdb, 0x11, 0x3b, 0x7a, 0xf3, 0xe0, 0xb1, 0x43, 0x55, 0x56, 0xc8, 0xf9, 0x53, 0x0c,
];
const AES_IV: [u8; 16] = [
    0x71, 0xe7, 0x04, 0x05, 0x35, 0x3a, 0x77, 0x8b, 0xfa, 0x6f, 0xbc, 0x30, 0x32, 0x1b, 0x95, 0x92,
];

/// Verify the HMAC-SHA1 tile signature of an
/// `/arts/<base>=x{X}-y{Y}-z{Z}-t{sig}` request path, where `<base>` is the
/// page-provided image path (the client signs exactly that base). Returns the
/// verified base (`path`, `plain`, or a scenario-specific one) on success.
pub fn verify_signature(request_path: &str) -> Option<String> {
    let rest = request_path.strip_prefix("/arts/")?;
    let (base, tail) = rest.split_once("=x")?;
    if base.is_empty() || base.contains('=') {
        return None;
    }
    let mut parts = tail.split("-y");
    let x = parts.next()?;
    let rest = parts.next()?;
    let mut parts = rest.split("-z");
    let y = parts.next()?;
    let rest = parts.next()?;
    let mut parts = rest.split("-t");
    let z = parts.next()?;
    let sig = parts.next()?;
    if sig.contains('/') || parts.next().is_some() {
        return None;
    }
    let signed = format!("arts/{base}=x{x}-y{y}-z{z}-tsample-token");
    let mut mac = Hmac::<Sha1>::new_from_slice(HMAC_KEY).ok()?;
    mac.update(signed.as_bytes());
    let digest = mac.finalize().into_bytes();
    let expected = b64::encode_nopad(&digest);
    if expected != sig {
        return None;
    }
    Some(base.to_string())
}

pub fn verify_and_decrypt(request_path: &str, stored: &[u8]) -> Option<Vec<u8>> {
    let base = verify_signature(request_path)?;
    if base == "plain" {
        return Some(b"plain-tile".to_vec());
    }
    let b64: Vec<u8> = stored
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let buffer = b64::decode(&b64)?;
    decrypt_image(&buffer)
}

/// Port of `decrypt_image`: container-aware AES-CBC decrypt with the legacy
/// pad-encrypt/truncate workaround.
fn decrypt_image(buffer: &[u8]) -> Option<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
    use aes::Aes128;
    use cbc::{Decryptor, Encryptor};
    if buffer.len() < 4 || u32::from_be_bytes(buffer[0..4].try_into().ok()?) != 0x0A0A0A0A {
        return Some(buffer.to_vec());
    }
    if buffer.len() < 8 {
        return None;
    }
    let index = u32::from_le_bytes(buffer[buffer.len() - 4..].try_into().ok()?) as usize;
    let prefix_end = 4usize.checked_add(index)?;
    let count_at = prefix_end.checked_add(4)?;
    if count_at > buffer.len() {
        return None;
    }
    let replace_count = u32::from_le_bytes(buffer[prefix_end..count_at].try_into().ok()?) as usize;
    let enc_start = count_at;
    let enc_end = enc_start.checked_add(replace_count)?;
    let suffix_end = buffer.len().checked_sub(4)?;
    if enc_end > suffix_end {
        return None;
    }
    // Pad workaround: AES-CBC-encrypt 32 bytes of 0x10 (yields 48 with PKCS7),
    // append, decrypt everything, drop the last 32 bytes.
    let mut pad = [16u8; 48];
    let pad_enc = Encryptor::<Aes128>::new(&AES_KEY.into(), &AES_IV.into())
        .encrypt_padded::<Pkcs7>(&mut pad, 32)
        .ok()?;
    assert_eq!(pad_enc.len(), 48);
    let mut c = Vec::with_capacity(replace_count + pad_enc.len());
    c.extend_from_slice(&buffer[enc_start..enc_end]);
    c.extend_from_slice(pad_enc);
    let pt = Decryptor::<Aes128>::new(&AES_KEY.into(), &AES_IV.into())
        .decrypt_padded::<Pkcs7>(&mut c)
        .ok()?;
    let pt = pt.get(..pt.len().checked_sub(32)?)?.to_vec();
    let mut out = Vec::with_capacity(4 + index + pt.len() + (suffix_end - enc_end));
    out.extend_from_slice(&buffer[4..prefix_end]);
    out.extend_from_slice(&pt);
    out.extend_from_slice(&buffer[enc_end..suffix_end]);
    Some(out)
}
