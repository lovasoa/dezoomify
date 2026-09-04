//! Bounded pure pixel operation over supplied decoded-pixel buffers.
//!
//! Adapter v1 exposes exactly one operation, `composite-crop`
//! ([`composite_crop`]): copy the rectangle `geometry {x, y, w, h}` out of a
//! caller-supplied RGBA8 (`[`PIXEL_BYTES`] = 4` bytes per pixel) source image
//! into a preallocated destination. There is no decoding, canvas, fetch,
//! storage, worker, I/O, or encoding anywhere in this module: both buffers
//! are plain slices, usually borrowed from [`ByteArena`][crate::buffer::ByteArena].
//!
//! Bounds use core coordinate math ([`Vec2d`][dezoomify_core::Vec2d]) with
//! checked arithmetic throughout. Every validation runs before the first
//! byte is written, so any failure leaves `output` untouched (failure
//! atomicity). In-place operation is rejected by the arena before this
//! function is reached. Work is bounded by the destination length, so a
//! well-formed call cannot hang: `w * h * 4` must equal `output.len()`.
//!
//! [`fnv1a64_hex`] provides the deterministic digest tests compare against.

use crate::error::{AdapterError, AdapterErrorCode};
use dezoomify_core::Vec2d;
use serde::{Deserialize, Serialize};

/// Bytes per pixel of adapter-v1 pixel buffers (RGBA8, row-major, no padding).
pub const PIXEL_BYTES: u64 = 4;

/// Crop rectangle inside the source image, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CropGeometry {
    /// Left edge in the source image.
    pub x: u32,
    /// Top edge in the source image.
    pub y: u32,
    /// Crop width. Must be non-zero.
    pub w: u32,
    /// Crop height. Must be non-zero.
    pub h: u32,
}

impl CropGeometry {
    /// Parse geometry JSON (`{"x":..,"y":..,"w":..,"h":..}`).
    ///
    /// # Errors
    ///
    /// `malformed` when the JSON does not decode.
    pub fn from_json(json: &str) -> Result<Self, AdapterError> {
        serde_json::from_str(json).map_err(|error| {
            AdapterError::new(
                AdapterErrorCode::Malformed,
                format!("invalid crop geometry: {error}"),
            )
        })
    }
}

/// Copy one crop rectangle from RGBA8 `input` into `output`.
///
/// `src_width`/`src_height` describe `input` (`len == w*h*4`); `output` must
/// hold exactly the cropped pixels (`len == w*h*4`). All checks precede any
/// write, so errors are atomic with respect to `output`.
///
/// # Errors
///
/// `malformed` for empty crops; `limit-exceeded` for arithmetic overflow,
/// dimension/length mismatch, out-of-bounds regions, or capacity mismatch.
pub fn composite_crop(
    input: &[u8],
    src_width: u32,
    src_height: u32,
    output: &mut [u8],
    geometry: &CropGeometry,
) -> Result<(), AdapterError> {
    if geometry.w == 0 || geometry.h == 0 {
        return Err(AdapterError::new(
            AdapterErrorCode::Malformed,
            "crop width and height must be non-zero",
        ));
    }
    let source = Vec2d {
        x: src_width,
        y: src_height,
    };
    let origin = Vec2d {
        x: geometry.x,
        y: geometry.y,
    };
    let size = Vec2d {
        x: geometry.w,
        y: geometry.h,
    };
    let end = origin.checked_add(size).ok_or_else(|| {
        AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            "crop rectangle corner overflows",
        )
    })?;
    if !end.fits_inside(source) {
        return Err(AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            format!(
                "crop x={} y={} w={} h={} exceeds source {}x{}",
                geometry.x, geometry.y, geometry.w, geometry.h, src_width, src_height
            ),
        ));
    }
    let expected_input = source.area().checked_mul(PIXEL_BYTES).ok_or_else(|| {
        AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            "source dimensions overflow byte accounting",
        )
    })?;
    let expected_input = usize::try_from(expected_input).map_err(|_| {
        AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            "source image does not fit this target",
        )
    })?;
    if input.len() != expected_input {
        return Err(AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            format!(
                "input holds {} bytes but {}x{} RGBA8 needs {expected_input}",
                input.len(),
                src_width,
                src_height
            ),
        ));
    }
    let expected_output = size.area().checked_mul(PIXEL_BYTES).ok_or_else(|| {
        AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            "crop dimensions overflow byte accounting",
        )
    })?;
    let expected_output = usize::try_from(expected_output).map_err(|_| {
        AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            "crop output does not fit this target",
        )
    })?;
    if output.len() != expected_output {
        return Err(AdapterError::new(
            AdapterErrorCode::LimitExceeded,
            format!(
                "output holds {} bytes but crop needs {expected_output}",
                output.len()
            ),
        ));
    }
    // All validation is done: the rows below cannot fail, and total copied
    // bytes equal `output.len()`, bounding the work.
    let src_stride = src_width as usize * PIXEL_BYTES as usize;
    let crop_stride = geometry.w as usize * PIXEL_BYTES as usize;
    let left = geometry.x as usize * PIXEL_BYTES as usize;
    for row in 0..geometry.h as usize {
        let src_row = geometry.y as usize + row;
        let src_start = src_row * src_stride + left;
        let dst_start = row * crop_stride;
        let src_range = src_start..src_start + crop_stride;
        let dst_range = dst_start..dst_start + crop_stride;
        let chunk: &[u8] = input.get(src_range).ok_or_else(|| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "crop source range invalid after bounds check",
            )
        })?;
        let slot: &mut [u8] = output.get_mut(dst_range).ok_or_else(|| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "crop output range invalid after bounds check",
            )
        })?;
        slot.copy_from_slice(chunk);
    }
    Ok(())
}

/// Deterministic FNV-1a (64-bit) digest rendered as 16 lowercase hex digits.
///
/// Used to compare processing output against scenario expectations without
/// extra hash dependencies.
#[must_use]
pub fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4x4 RGBA8 test image: pixel (x, y) holds `[x, y, x ^ y, 255]`.
    pub fn test_image_4x4() -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 * 4 * 4);
        for y in 0u8..4 {
            for x in 0u8..4 {
                bytes.extend_from_slice(&[x, y, x ^ y, 255]);
            }
        }
        bytes
    }

    #[test]
    fn crop_copies_exact_pixels() {
        let input = test_image_4x4();
        let mut output = vec![0u8; 2 * 2 * 4];
        let geometry = CropGeometry {
            x: 1,
            y: 1,
            w: 2,
            h: 2,
        };
        composite_crop(&input, 4, 4, &mut output, &geometry).unwrap();
        let expected: Vec<u8> = vec![
            1, 1, 0, 255, 2, 1, 3, 255, //
            1, 2, 3, 255, 2, 2, 0, 255, //
        ];
        assert_eq!(output, expected);
    }

    #[test]
    fn out_of_bounds_crop_fails_atomically() {
        let input = test_image_4x4();
        let mut output = vec![0xAAu8; 2 * 2 * 4];
        let geometry = CropGeometry {
            x: 3,
            y: 3,
            w: 2,
            h: 2,
        };
        let error = composite_crop(&input, 4, 4, &mut output, &geometry).unwrap_err();
        assert_eq!(error.code(), AdapterErrorCode::LimitExceeded);
        assert_eq!(output, vec![0xAAu8; 2 * 2 * 4]);
    }
}
